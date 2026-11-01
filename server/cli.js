'use strict';
// Usage: node server/cli.js create-admin | seed-demo
const { open } = require('./db');
const S = require('./security');
const path = require('node:path');
const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'campuscare.db');
const db = open(file);
const cmd = process.argv[2];

if (cmd === 'create-admin') {
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase(), pw = process.env.ADMIN_PASSWORD || '', name = process.env.ADMIN_NAME || 'CampusCare Admin';
  if (!email || !S.strongPassword(pw)) { console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (8+ chars, letters+numbers) in the environment first.'); process.exit(1); }
  db.prepare("INSERT INTO users(full_name,srn,email,password_hash,role,verified) VALUES(?,NULL,?,?,'admin',1) ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash, role='admin'")
    .run(name, email, S.hashPassword(pw));
  console.log(`Administrator ready: ${email}`);
} else if (cmd === 'seed-demo') {
  // DEMONSTRATION DATA ONLY. Clearly fake students, tickets prefixed so they are recognisable.
  const pw = S.hashPassword('Demo@12345');
  const ts = d => new Date(Date.now() - d * 36e5).toISOString();
  const students = [['Demo Student One','R21DEMO01','demo1@example.edu'],['Demo Student Two','R22DEMO02','demo2@example.edu']];
  const ins = db.prepare("INSERT OR IGNORE INTO users(full_name,srn,email,password_hash,role,department,course,semester,verified) VALUES(?,?,?,?,'student','School of Computing & IT','B.Tech CSE','6th Semester',1)");
  students.forEach(([n, s, e]) => ins.run(n, s, e, pw));
  const admin = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if (!admin) { console.error('Create an administrator first (create-admin).'); process.exit(1); }
  const samples = [
    ['R21DEMO01','Wi-Fi down on 3rd floor of C.V. Raman Block','Wi-Fi/Internet','High','C.V. Raman Block, Room 302','In Progress',3],
    ['R21DEMO01','Sanitizer dispenser empty at Library entrance','Cleanliness','Normal','Central Library','Resolved',70],
    ['R22DEMO02','Auditorium light flickering','Infrastructure','Medium','Main Auditorium','Submitted',18],
    ['R22DEMO02','Bus route 14 consistently late','Transport','Urgent','Main Gate','Submitted',5]];
  let n = db.prepare("SELECT COALESCE((SELECT value FROM counters WHERE name='ticket'),1000) v").get().v;
  for (const [srn, title, cat, pr, loc, st, hrs] of samples) {
    const u = db.prepare('SELECT id FROM users WHERE srn=?').get(srn);
    if (db.prepare('SELECT 1 x FROM complaints WHERE title=? AND user_id=?').get(title, u.id)) continue;
    n++;
    const dept = db.prepare('SELECT department_id d FROM category_map WHERE category=?').get(cat).d;
    const res = db.prepare('INSERT INTO complaints(ticket_id,user_id,title,description,category,priority,location,department_id,status,admin_note,created_at,updated_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(`CC-${new Date().getFullYear()}-${n}`, u.id, title, '[DEMO DATA] ' + title + ' — sample record for demonstration.', cat, pr, loc, dept, st, st === 'Submitted' ? null : 'Demo note', ts(hrs), ts(hrs / 2), st === 'Resolved' ? ts(hrs / 2) : null);
    const cid = Number(res.lastInsertRowid);
    const h = db.prepare('INSERT INTO status_history(complaint_id,prev_status,new_status,changed_by,notes,created_at) VALUES(?,?,?,?,?,?)');
    h.run(cid, null, 'Submitted', u.id, 'Complaint submitted', ts(hrs));
    if (st !== 'Submitted') h.run(cid, 'Submitted', st, admin.id, 'Demo note', ts(hrs / 2));
  }
  db.prepare("INSERT INTO counters(name,value) VALUES('ticket',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(n);
  console.log('Demo data loaded. Demo students: R21DEMO01 / R22DEMO02, password Demo@12345 (demo only — delete before real use).');
} else { console.error('Usage: node server/cli.js create-admin | seed-demo'); process.exit(1); }
