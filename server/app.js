'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { open } = require('./db');
const S = require('./security');

const STATUSES = ['Submitted','Acknowledged','In Progress','Resolved','Rejected','Reopened'];
const PRIORITIES = ['Urgent','High','Medium','Normal'];
const CATEGORIES = ['Wi-Fi/Internet','Infrastructure','Cleanliness','Housekeeping','Transport','Hostel',
  'Classroom/Lab Equipment','Library','Security/Safety','Water/Washroom','Other'];
const TRANSITIONS = {
  'Submitted': ['Acknowledged','In Progress','Rejected'],
  'Acknowledged': ['In Progress','Resolved','Rejected'],
  'In Progress': ['Acknowledged','Resolved','Rejected'],
  'Resolved': ['Reopened'], 'Rejected': ['Reopened'],
  'Reopened': ['Acknowledged','In Progress','Resolved','Rejected']};
const SLA_HOURS = { Urgent: 24, High: 72, Medium: 168, Normal: 336 };
const PRIO_SQL = "CASE c.priority WHEN 'Urgent' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END";
const MAX_UPLOAD = 5 * 1024 * 1024;

class HttpError extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra; } }
const bad = (m, f) => new HttpError(400, m, f && { fields: f });
const now = () => new Date().toISOString();
const str = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

function createApp(opts = {}) {
  const cfg = {
    dbFile: opts.dbFile || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'campuscare.db'),
    uploadDir: opts.uploadDir || process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'),
    sessionHours: Number(process.env.SESSION_HOURS || 8),
    requireVerification: (opts.requireVerification ?? process.env.REQUIRE_VERIFICATION) === true || process.env.REQUIRE_VERIFICATION === 'true',
    emailDomain: opts.emailDomain ?? process.env.STUDENT_EMAIL_DOMAIN ?? '',   // e.g. "reva.edu.in"; empty = any
    reopenDays: Number(process.env.REOPEN_WINDOW_DAYS || 14),
    exposeResetToken: opts.exposeResetToken ?? process.env.EXPOSE_RESET_TOKEN === 'true',
    secureCookie: process.env.NODE_ENV === 'production',
    loginMax: opts.loginMax || 8 };
  fs.mkdirSync(cfg.uploadDir, { recursive: true });
  const db = open(cfg.dbFile);
  const loginLimit = S.limiter(cfg.loginMax, 15 * 60 * 1000);
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const audit = (actor, action, entity, id, detail) =>
    run('INSERT INTO audit_log(actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?)', actor, action, entity, String(id), detail || null, now());
  const notify = (userId, cid, msg) =>
    run('INSERT INTO notifications(user_id,complaint_id,message,is_read,created_at) VALUES(?,?,?,0,?)', userId, cid, msg, now());
  const notifyAdmins = (cid, msg) => q("SELECT id FROM users WHERE role='admin' AND status='active'").forEach(a => notify(a.id, cid, msg));

  // ---------- serialization ----------
  const COMPLAINT_SQL = `SELECT c.*, u.srn AS srn, u.full_name AS student_name, u.email AS student_email, d.name AS dept
    FROM complaints c JOIN users u ON u.id=c.user_id LEFT JOIN departments d ON d.id=c.department_id`;
  function ser(c, admin) {
    const o = { id: c.ticket_id, title: c.title, description: c.description, category: c.category, subcategory: c.subcategory,
      priority: c.priority, location: c.location, department: c.dept, status: c.status, adminNote: c.admin_note || '',
      rejectionReason: c.rejection_reason, createdAt: c.created_at, updatedAt: c.updated_at, resolvedAt: c.resolved_at,
      studentId: c.srn, overdue: isOverdue(c) };
    if (admin) { o.studentName = c.student_name; o.studentEmail = c.student_email; }
    return o;
  }
  const isOverdue = c => !['Resolved','Rejected'].includes(c.status) && (Date.now() - Date.parse(c.created_at)) / 36e5 > SLA_HOURS[c.priority];
  function detail(c, admin) {
    const o = ser(c, admin);
    o.history = q(`SELECT h.prev_status AS prev, h.new_status AS status, h.notes, h.created_at AS at, u.full_name AS by, u.role AS byRole
      FROM status_history h JOIN users u ON u.id=h.changed_by WHERE complaint_id=? ORDER BY h.id`, c.id);
    o.comments = q(`SELECT m.message, m.created_at AS at, u.full_name AS author, u.role FROM comments m JOIN users u ON u.id=m.author_id
      WHERE complaint_id=? ORDER BY m.id`, c.id);
    o.attachments = q('SELECT id,original_name AS name,mime,size FROM attachments WHERE complaint_id=?', c.id);
    return o;
  }

  // ---------- request helpers ----------
  async function readJson(req) {
    const chunks = []; let n = 0;
    for await (const ch of req) { n += ch.length; if (n > 8 * 1024 * 1024) throw new HttpError(413, 'Request too large'); chunks.push(ch); }
    if (!n) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('Invalid JSON body'); }
  }
  const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0, i).trim(), decodeURIComponent(s.slice(i + 1))]; }));
  function sessionUser(req) {
    const t = cookies(req).cc_session; if (!t) return null;
    const s = one('SELECT * FROM sessions WHERE token_hash=?', S.sha(t));
    if (!s) return null;
    if (s.expires_at < Date.now()) { run('DELETE FROM sessions WHERE token_hash=?', s.token_hash); return null; }
    const u = one('SELECT * FROM users WHERE id=?', s.user_id);
    if (!u || u.status !== 'active') return null;
    return { ...u, csrf: s.csrf, tokenHash: s.token_hash };
  }
  const publicUser = u => ({ id: u.id, name: u.full_name, srn: u.srn, email: u.email, role: u.role, department: u.department,
    course: u.course, semester: u.semester, verified: !!u.verified });
  function startSession(res, u) {
    const t = S.token(), csrf = S.token();
    run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)', S.sha(t), u.id, csrf, Date.now() + cfg.sessionHours * 36e5);
    res.setHeader('Set-Cookie', `cc_session=${t}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${cfg.sessionHours * 3600}${cfg.secureCookie ? '; Secure' : ''}`);
    return csrf;
  }
  const need = (u, role) => { if (!u) throw new HttpError(401, 'Please sign in to continue.'); if (role && u.role !== role) throw new HttpError(403, 'You are not authorized to access this resource.'); };

  function pageParams(url) {
    const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
    const size = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize')) || 20));
    return { page, size, offset: (page - 1) * size };
  }
  function filters(url, where, args, admin) {
    const g = k => url.searchParams.get(k);
    if (g('status') && g('status') !== 'ALL') { where.push('c.status=?'); args.push(g('status')); }
    if (g('priority') && g('priority') !== 'ALL') { where.push('c.priority=?'); args.push(g('priority')); }
    if (g('category') && g('category') !== 'ALL') { where.push('c.category=?'); args.push(g('category')); }
    if (g('department') && g('department') !== 'ALL') { where.push('d.name=?'); args.push(g('department')); }
    if (g('from')) { where.push('c.created_at>=?'); args.push(g('from')); }
    if (g('to')) { where.push('c.created_at<=?'); args.push(g('to') + 'T23:59:59.999Z'); }
    const s = str(g('search') || '', 100).toLowerCase();
    if (s) {
      const like = `%${s.replace(/[%_\\]/g, m => '\\' + m)}%`;
      const cols = ['c.ticket_id', 'c.title', 'c.category', 'c.location', 'd.name'];
      if (admin) cols.push('u.srn');
      where.push('(' + cols.map(c => `lower(${c}) LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
      cols.forEach(() => args.push(like));
    }
  }
  function list(url, user, admin) {
    const where = [], args = [];
    if (!admin) { where.push('c.user_id=?'); args.push(user.id); }
    filters(url, where, args, admin);
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sort = url.searchParams.get('sort') || (admin ? 'priority' : 'newest');
    const order = sort === 'oldest' ? 'c.created_at ASC' : sort === 'newest' ? 'c.created_at DESC'
      : `(c.status IN ('Resolved','Rejected')) ASC, ${PRIO_SQL} ASC, c.created_at ASC`;
    const { page, size, offset } = pageParams(url);
    const total = one(`SELECT COUNT(*) n FROM complaints c JOIN users u ON u.id=c.user_id LEFT JOIN departments d ON d.id=c.department_id ${W}`, ...args).n;
    const rows = q(`${COMPLAINT_SQL} ${W} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, size, offset);
    return { items: rows.map(r => ser(r, admin)), page, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)), sort };
  }
  const counts = (where, args, col) => Object.fromEntries(q(`SELECT ${col} k, COUNT(*) n FROM complaints c ${where} GROUP BY ${col}`, ...args).map(r => [r.k, r.n]));

  function studentDashboard(u) {
    const w = 'WHERE c.user_id=?', a = [u.id];
    const byStatus = counts(w, a, 'c.status');
    const total = Object.values(byStatus).reduce((x, y) => x + y, 0);
    const monthly = q(`SELECT substr(created_at,1,7) m, COUNT(*) n FROM complaints c ${w} GROUP BY m ORDER BY m DESC LIMIT 12`, ...a).reverse();
    const resolved = byStatus['Resolved'] || 0;
    return { total, byStatus, open: total - resolved - (byStatus['Rejected'] || 0), resolved,
      resolutionRate: total ? Math.round(resolved / total * 100) : 0, byCategory: counts(w, a, 'c.category'),
      byPriority: counts(w, a, 'c.priority'), monthly,
      unread: one('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND is_read=0', u.id).n,
      recent: q(`SELECT m.message, m.created_at AS at FROM notifications m WHERE user_id=? ORDER BY id DESC LIMIT 8`, u.id) };
  }
  function analytics(url) {
    const where = [], args = [];
    filters(url, where, args, true);
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const base = `FROM complaints c JOIN users u ON u.id=c.user_id LEFT JOIN departments d ON d.id=c.department_id ${W}`;
    const grp = col => Object.fromEntries(q(`SELECT ${col} k, COUNT(*) n ${base} GROUP BY ${col}`, ...args).map(r => [r.k ?? 'Unassigned', r.n]));
    const all = q(`SELECT c.status, c.priority, c.created_at, c.resolved_at ${base}`, ...args);
    const resolvedRows = all.filter(r => r.resolved_at);
    const avgHrs = resolvedRows.length ? resolvedRows.reduce((s, r) => s + (Date.parse(r.resolved_at) - Date.parse(r.created_at)), 0) / resolvedRows.length / 36e5 : null;
    const month = {}; all.forEach(r => { const m = r.created_at.slice(0, 7); (month[m] ??= { month: m, submitted: 0, resolved: 0 }).submitted++; });
    resolvedRows.forEach(r => { const m = r.resolved_at.slice(0, 7); (month[m] ??= { month: m, submitted: 0, resolved: 0 }).resolved++; });
    const perf = q(`SELECT d.name dept, SUM(c.status NOT IN ('Resolved','Rejected')) open, SUM(c.status='Resolved') resolved ${base} GROUP BY d.name`, ...args);
    return { total: all.length, byDepartment: grp('d.name'), byCategory: grp('c.category'), byPriority: grp('c.priority'), byStatus: grp('c.status'),
      monthly: Object.values(month).sort((a, b) => a.month.localeCompare(b.month)), avgResolutionHours: avgHrs === null ? null : Math.round(avgHrs * 10) / 10,
      resolutionRate: all.length ? Math.round(resolvedRows.length / all.length * 100) : 0,
      departmentPerformance: perf.map(p => ({ dept: p.dept ?? 'Unassigned', open: p.open, resolved: p.resolved })) };
  }
  function adminDashboard() {
    const rows = q(`SELECT c.status,c.priority,c.created_at,c.resolved_at FROM complaints c`);
    const by = f => rows.filter(f).length, open = r => !['Resolved', 'Rejected'].includes(r.status);
    const res = rows.filter(r => r.resolved_at);
    return { total: rows.length, newlySubmitted: by(r => r.status === 'Submitted'), urgent: by(r => r.priority === 'Urgent' && open(r)),
      high: by(r => r.priority === 'High' && open(r)), medium: by(r => r.priority === 'Medium' && open(r)), normal: by(r => r.priority === 'Normal' && open(r)),
      inProgress: by(r => r.status === 'In Progress'), resolved: by(r => r.status === 'Resolved'), rejected: by(r => r.status === 'Rejected'),
      pending: by(r => ['Submitted', 'Acknowledged', 'Reopened', 'In Progress'].includes(r.status)), overdue: by(r => open(r) && isOverdue(r)),
      avgResolutionHours: res.length ? Math.round(res.reduce((s, r) => s + Date.parse(r.resolved_at) - Date.parse(r.created_at), 0) / res.length / 36e4) / 10 : null };
  }

  function createComplaint(u, b, idem) {
    if (u.role !== 'student') throw new HttpError(403, 'Only students can submit complaints.');
    if (cfg.requireVerification && !u.verified) throw new HttpError(403, 'Your account is awaiting administrator verification.');
    const f = {};
    const title = str(b.title, 150), description = str(b.description, 4000), location = str(b.location, 200), category = str(b.category, 60);
    const priority = str(b.priority, 10) || 'Medium';
    if (title.length < 5) f.title = 'Title must be at least 5 characters.';
    if (description.length < 10) f.description = 'Please describe the problem (at least 10 characters).';
    if (!location) f.location = 'Location is required.';
    if (!CATEGORIES.includes(category)) f.category = 'Choose a valid category.';
    if (!PRIORITIES.includes(priority)) f.priority = 'Choose a valid priority.';
    let file = null;
    if (b.attachment && b.attachment.data) {
      const buf = Buffer.from(String(b.attachment.data).replace(/^data:[^,]*,/, ''), 'base64');
      const t = S.sniff(buf);
      if (!buf.length || buf.length > MAX_UPLOAD) f.attachment = 'Attachment must be between 1 byte and 5 MB.';
      else if (!t) f.attachment = 'Only JPG, PNG, GIF, WEBP or PDF files are allowed.';
      else file = { buf, t, name: str(b.attachment.name, 120).replace(/[^\w.\- ]/g, '_') || 'attachment.' + t.ext };
    }
    if (Object.keys(f).length) throw bad('Please correct the highlighted fields.', f);
    if (idem) { const dup = one(`${COMPLAINT_SQL} WHERE c.user_id=? AND c.idem_key=?`, u.id, idem); if (dup) return { complaint: ser(dup), duplicate: true }; }
    const ts = now();
    const id = tx(() => {
      const year = new Date().getFullYear();
      run("INSERT INTO counters(name,value) VALUES('ticket',1000) ON CONFLICT(name) DO NOTHING");
      run("UPDATE counters SET value=value+1 WHERE name='ticket'");
      const ticket = `CC-${year}-${one("SELECT value FROM counters WHERE name='ticket'").value}`;
      const dept = one('SELECT department_id FROM category_map WHERE category=?', category);
      const r = run(`INSERT INTO complaints(ticket_id,user_id,title,description,category,subcategory,priority,location,department_id,status,idem_key,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, ticket, u.id, title, description, category, str(b.subcategory, 80) || null, priority, location, dept?.department_id ?? null, 'Submitted', idem || null, ts, ts);
      const cid = Number(r.lastInsertRowid);
      run('INSERT INTO status_history(complaint_id,prev_status,new_status,changed_by,notes,created_at) VALUES(?,?,?,?,?,?)', cid, null, 'Submitted', u.id, 'Complaint submitted', ts);
      if (file) {
        const stored = crypto.randomUUID() + '.' + file.t.ext;
        fs.writeFileSync(path.join(cfg.uploadDir, stored), file.buf, { mode: 0o600 });
        run('INSERT INTO attachments(complaint_id,original_name,stored_name,mime,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)', cid, file.name, stored, file.t.mime, file.buf.length, u.id, ts);
      }
      notify(u.id, cid, `Your complaint ${ticket} was submitted successfully.`);
      notifyAdmins(cid, `${priority === 'Urgent' ? '🚨 URGENT: ' : ''}New complaint ${ticket}: ${title}`);
      audit(u.id, 'complaint.create', 'complaint', ticket);
      return cid;
    });
    return { complaint: detail(one(`${COMPLAINT_SQL} WHERE c.id=?`, id), false), duplicate: false };
  }

  function changeStatus(admin, c, b) {
    const to = str(b.status, 20), notes = str(b.note, 2000), reason = str(b.reason, 1000);
    if (!STATUSES.includes(to)) throw bad('Unknown status.');
    if (!(TRANSITIONS[c.status] || []).includes(to)) throw bad(`A complaint that is "${c.status}" cannot be moved to "${to}".`);
    if (to === 'Rejected' && !reason) throw bad('A reason is required to reject a complaint.', { reason: 'Required' });
    if (to === 'Resolved' && !notes) throw bad('Resolution notes are required to mark a complaint as resolved.', { note: 'Required' });
    const ts = now();
    tx(() => {
      run('UPDATE complaints SET status=?, admin_note=COALESCE(NULLIF(?,\'\'),admin_note), rejection_reason=?, resolved_at=?, updated_at=? WHERE id=?',
        to, notes || reason, to === 'Rejected' ? reason : null, to === 'Resolved' ? ts : null, ts, c.id);
      run('INSERT INTO status_history(complaint_id,prev_status,new_status,changed_by,notes,created_at) VALUES(?,?,?,?,?,?)', c.id, c.status, to, admin.id, to === 'Rejected' ? reason : notes || null, ts);
      notify(c.user_id, c.id, `Complaint ${c.ticket_id} is now "${to}".${to === 'Rejected' ? ' Reason: ' + reason : notes ? ' Note: ' + notes : ''}`);
      audit(admin.id, 'complaint.status', 'complaint', c.ticket_id, `${c.status} -> ${to}`);
    });
  }
  const getOwned = (u, ticket) => {
    const c = one(`${COMPLAINT_SQL} WHERE c.ticket_id=?`, ticket);
    if (!c || (u.role === 'student' && c.user_id !== u.id)) throw new HttpError(404, 'Complaint not found.'); // 404 avoids confirming other tickets exist
    return c;
  };

  // ---------- router ----------
  const routes = [];
  const r = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'), fn });

  r('GET', '/api/health', () => ({ ok: true }));
  r('GET', '/api/config', () => ({ statuses: STATUSES, priorities: PRIORITIES, categories: CATEGORIES, reopenDays: cfg.reopenDays,
    departments: q('SELECT name FROM departments WHERE active=1 ORDER BY name').map(d => d.name),
    categoryDepartments: Object.fromEntries(q('SELECT m.category,d.name FROM category_map m JOIN departments d ON d.id=m.department_id').map(x => [x.category, x.name])),
    requireVerification: cfg.requireVerification, emailDomain: cfg.emailDomain }));
  r('GET', '/api/public/stats', () => { const d = adminDashboard(); return { total: d.total, pending: d.pending, resolved: d.resolved }; });

  r('POST', '/api/auth/register', ({ body: b, res }) => {
    const f = {};
    const name = str(b.name, 100), srn = str(b.srn, 20).toUpperCase(), email = str(b.email, 120).toLowerCase();
    if (name.length < 2) f.name = 'Full name is required.';
    if (!/^[A-Z0-9]{6,15}$/.test(srn)) f.srn = 'SRN must be 6-15 letters/digits (e.g. R21CS045).';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) f.email = 'Enter a valid email address.';
    else if (cfg.emailDomain && !email.endsWith('@' + cfg.emailDomain)) f.email = `Use your official @${cfg.emailDomain} email.`;
    if (!S.strongPassword(b.password)) f.password = 'Password needs 8+ characters with letters and numbers.';
    if (b.confirmPassword !== undefined && b.confirmPassword !== b.password) f.confirmPassword = 'Passwords do not match.';
    if (Object.keys(f).length) throw bad('Please correct the highlighted fields.', f);
    if (one('SELECT 1 x FROM users WHERE srn=?', srn)) throw new HttpError(409, 'This SRN is already registered.', { fields: { srn: 'Already registered' } });
    if (one('SELECT 1 x FROM users WHERE email=?', email)) throw new HttpError(409, 'This email is already registered.', { fields: { email: 'Already registered' } });
    const rr = run('INSERT INTO users(full_name,srn,email,password_hash,role,department,course,semester,verified) VALUES(?,?,?,?,?,?,?,?,0)',
      name, srn, email, S.hashPassword(b.password), 'student', str(b.department, 120), str(b.course, 120), str(b.semester, 40));
    audit(Number(rr.lastInsertRowid), 'user.register', 'user', srn);
    return { http: 201, body: { message: 'Registration successful. You can sign in now; an administrator will verify your account.' } };
  });
  r('POST', '/api/auth/login', ({ body: b, req, res }) => {
    const key = (req.socket.remoteAddress || '') + '|' + str(b.identifier, 120).toLowerCase();
    if (!loginLimit(key)) throw new HttpError(429, 'Too many login attempts. Please wait 15 minutes and try again.');
    const id = str(b.identifier, 120).toLowerCase(), role = b.role === 'admin' ? 'admin' : 'student';
    const u = one('SELECT * FROM users WHERE lower(email)=? OR lower(srn)=?', id, id);
    // Same error for unknown user / wrong password / wrong portal, so nothing leaks.
    if (!u || u.status !== 'active' || u.role !== role || !S.verifyPassword(String(b.password || ''), u.password_hash))
      throw new HttpError(401, 'Invalid credentials.');
    const csrf = startSession(res, u);
    audit(u.id, 'auth.login', 'user', u.id);
    return { user: publicUser(u), csrf };
  });
  r('POST', '/api/auth/logout', ({ user, res }) => {
    if (user) run('DELETE FROM sessions WHERE token_hash=?', user.tokenHash);
    res.setHeader('Set-Cookie', 'cc_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
    return { ok: true };
  });
  r('GET', '/api/auth/me', ({ user }) => { need(user); return { user: publicUser(user), csrf: user.csrf }; });
  r('POST', '/api/auth/forgot-password', ({ body: b }) => {
    const u = one('SELECT * FROM users WHERE lower(email)=?', str(b.email, 120).toLowerCase());
    const out = { message: 'If that email is registered, a reset link has been generated. Email delivery is not configured on this server, so contact an administrator.' };
    if (u && u.status === 'active') {
      const t = S.token();
      run('INSERT INTO reset_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)', S.sha(t), u.id, Date.now() + 30 * 60000);
      console.log(`[reset] token generated for user ${u.id} (not emailed: no email provider configured)`);
      if (cfg.exposeResetToken) out.devToken = t; // demo/test only
    }
    return out;
  });
  r('POST', '/api/auth/reset-password', ({ body: b }) => {
    if (!S.strongPassword(b.password)) throw bad('Password needs 8+ characters with letters and numbers.');
    const t = one('SELECT * FROM reset_tokens WHERE token_hash=?', S.sha(String(b.token || '')));
    if (!t || t.expires_at < Date.now()) throw bad('This reset link is invalid or has expired.');
    tx(() => { run('UPDATE users SET password_hash=?, updated_at=? WHERE id=?', S.hashPassword(b.password), now(), t.user_id);
      run('DELETE FROM reset_tokens WHERE user_id=?', t.user_id); run('DELETE FROM sessions WHERE user_id=?', t.user_id); });
    audit(t.user_id, 'auth.reset', 'user', t.user_id);
    return { message: 'Password updated. Please sign in.' };
  });

  // student
  r('GET', '/api/student/dashboard', ({ user }) => { need(user, 'student'); return studentDashboard(user); });
  r('GET', '/api/student/complaints', ({ user, url }) => { need(user, 'student'); return list(url, user, false); });
  r('POST', '/api/student/complaints', ({ user, body, req }) => {
    need(user, 'student');
    const out = createComplaint(user, body, str(req.headers['idempotency-key'] || '', 80));
    return { http: out.duplicate ? 200 : 201, body: out };
  });
  r('GET', '/api/student/complaints/:id', ({ user, params }) => { need(user, 'student'); return detail(getOwned(user, params[0]), false); });
  r('POST', '/api/student/complaints/:id/comments', ({ user, params, body }) => {
    need(user, 'student'); const c = getOwned(user, params[0]);
    const m = str(body.message, 2000); if (!m) throw bad('Message cannot be empty.');
    run('INSERT INTO comments(complaint_id,author_id,message,created_at) VALUES(?,?,?,?)', c.id, user.id, m, now());
    notifyAdmins(c.id, `Follow-up from ${user.srn} on ${c.ticket_id}`);
    return { http: 201, body: { ok: true } };
  });
  r('POST', '/api/student/complaints/:id/reopen', ({ user, params, body }) => {
    need(user, 'student'); const c = getOwned(user, params[0]);
    if (c.status !== 'Resolved') throw bad('Only resolved complaints can be reopened.');
    if ((Date.now() - Date.parse(c.resolved_at)) / 864e5 > cfg.reopenDays) throw bad(`Complaints can only be reopened within ${cfg.reopenDays} days of resolution.`);
    const ts = now();
    tx(() => { run("UPDATE complaints SET status='Reopened', resolved_at=NULL, updated_at=? WHERE id=?", ts, c.id);
      run('INSERT INTO status_history(complaint_id,prev_status,new_status,changed_by,notes,created_at) VALUES(?,?,?,?,?,?)', c.id, 'Resolved', 'Reopened', user.id, str(body.message, 1000) || 'Reopened by student', ts);
      notifyAdmins(c.id, `${c.ticket_id} was reopened by the student.`); audit(user.id, 'complaint.reopen', 'complaint', c.ticket_id); });
    return { ok: true };
  });
  const notifList = u => ({ items: q('SELECT n.id,n.message,n.is_read AS isRead,n.created_at AS createdAt,c.ticket_id AS ticket FROM notifications n LEFT JOIN complaints c ON c.id=n.complaint_id WHERE n.user_id=? ORDER BY n.id DESC LIMIT 100', u.id).map(n => ({ ...n, isRead: !!n.isRead })),
    unread: one('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND is_read=0', u.id).n });
  for (const role of ['student', 'admin']) {
    r('GET', `/api/${role}/notifications`, ({ user }) => { need(user, role); return notifList(user); });
    r('POST', `/api/${role}/notifications/read-all`, ({ user }) => { need(user, role); run('UPDATE notifications SET is_read=1 WHERE user_id=?', user.id); return { ok: true }; });
    r('PATCH', `/api/${role}/notifications/:id/read`, ({ user, params }) => { need(user, role); run('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?', params[0], user.id); return { ok: true }; });
  }

  // admin
  r('GET', '/api/admin/dashboard', ({ user }) => { need(user, 'admin'); return adminDashboard(); });
  r('GET', '/api/admin/complaints', ({ user, url }) => { need(user, 'admin'); return list(url, user, true); });
  r('GET', '/api/admin/complaints/:id', ({ user, params }) => { need(user, 'admin'); return detail(getOwned(user, params[0]), true); });
  r('PATCH', '/api/admin/complaints/:id/status', ({ user, params, body }) => {
    need(user, 'admin'); const c = getOwned(user, params[0]); changeStatus(user, c, body);
    return detail(getOwned(user, params[0]), true);
  });
  r('PATCH', '/api/admin/complaints/:id/department', ({ user, params, body }) => {
    need(user, 'admin'); const c = getOwned(user, params[0]);
    const d = one('SELECT id,name FROM departments WHERE name=? AND active=1', str(body.department, 120));
    if (!d) throw bad('Unknown department.');
    run('UPDATE complaints SET department_id=?, updated_at=? WHERE id=?', d.id, now(), c.id);
    run('INSERT INTO status_history(complaint_id,prev_status,new_status,changed_by,notes,created_at) VALUES(?,?,?,?,?,?)', c.id, c.status, c.status, user.id, `Assigned to ${d.name}`, now());
    notify(c.user_id, c.id, `Complaint ${c.ticket_id} was assigned to ${d.name}.`);
    audit(user.id, 'complaint.department', 'complaint', c.ticket_id, `${c.dept} -> ${d.name}`);
    return detail(getOwned(user, params[0]), true);
  });
  r('POST', '/api/admin/complaints/:id/comments', ({ user, params, body }) => {
    need(user, 'admin'); const c = getOwned(user, params[0]);
    const m = str(body.message, 2000); if (!m) throw bad('Message cannot be empty.');
    run('INSERT INTO comments(complaint_id,author_id,message,created_at) VALUES(?,?,?,?)', c.id, user.id, m, now());
    notify(c.user_id, c.id, `Administration replied on ${c.ticket_id}: ${m.slice(0, 120)}`);
    return { http: 201, body: { ok: true } };
  });
  r('GET', '/api/admin/analytics', ({ user, url }) => { need(user, 'admin'); return analytics(url); });
  r('GET', '/api/admin/departments', ({ user }) => { need(user, 'admin'); return { items: q('SELECT id,name,active FROM departments ORDER BY name') }; });
  r('GET', '/api/admin/users', ({ user, url }) => { need(user, 'admin');
    const v = url.searchParams.get('verified');
    return { items: q(`SELECT id,full_name AS name,srn,email,department,course,semester,verified,status FROM users WHERE role='student' ${v === '0' ? 'AND verified=0' : ''} ORDER BY id DESC LIMIT 200`).map(x => ({ ...x, verified: !!x.verified })) }; });
  r('PATCH', '/api/admin/users/:id/verify', ({ user, params, body }) => { need(user, 'admin');
    const v = body.verified === false ? 0 : 1;
    const res = run("UPDATE users SET verified=?, updated_at=? WHERE id=? AND role='student'", v, now(), params[0]);
    if (!res.changes) throw new HttpError(404, 'Student not found.');
    notify(Number(params[0]), null, v ? 'Your account has been verified by the administration.' : 'Your account verification was revoked.');
    audit(user.id, 'user.verify', 'user', params[0], String(v)); return { ok: true }; });
  r('GET', '/api/attachments/:id', ({ user, params, res }) => {
    need(user);
    const a = one('SELECT a.*, c.user_id AS owner FROM attachments a JOIN complaints c ON c.id=a.complaint_id WHERE a.id=?', params[0]);
    if (!a || (user.role === 'student' && a.owner !== user.id)) throw new HttpError(404, 'Attachment not found.');
    return { raw: fs.readFileSync(path.join(cfg.uploadDir, a.stored_name)), mime: a.mime, name: a.original_name };
  });

  // ---------- static + dispatcher ----------
  const PUB = path.join(__dirname, '..', 'public');
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  function serveStatic(url, res) {
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (!p || p.endsWith('/')) p += 'index.html';
    const f = path.join(PUB, p);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(f));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
    const url = new URL(req.url, 'http://x');
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(url, res);
      const user = sessionUser(req);
      const route = routes.map(rt => rt.method === req.method && { rt, m: url.pathname.match(rt.re) }).find(x => x && x.m);
      if (!route) throw new HttpError(404, 'Endpoint not found.');
      const mutating = req.method !== 'GET';
      if (mutating && user && req.headers['x-csrf-token'] !== user.csrf) throw new HttpError(403, 'Invalid or missing CSRF token.');
      const body = mutating ? await readJson(req) : {};
      const out = route.rt.fn({ req, res, url, user, body, params: route.m.slice(1).map(decodeURIComponent) });
      if (out && out.raw) { res.writeHead(200, { 'Content-Type': out.mime, 'Content-Disposition': `inline; filename="${out.name.replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store' }); return res.end(out.raw); }
      const status = out && out.http ? out.http : 200;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out && out.http ? out.body : out));
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 500;
      if (code === 500) console.error('[error]', e.message);
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: code === 500 ? 'Something went wrong on the server.' : e.message, ...(e.extra || {}) }));
    }
  });
  return { server, db, cfg, close: () => new Promise(ok => { server.close(() => { db.close(); ok(); }); server.closeAllConnections?.(); }) };
}
module.exports = { createApp };
