/* Student Portal (REVA University) API layer:
   Replaces the prototype's localStorage data layer with real backend calls to the SQLite database.
   Loaded after the inline script; it overrides the data/auth functions by name. */
'use strict';
let CSRF = '', CONFIG = { categories: [], departments: [], categoryDepartments: {} };
let notifs = { items: [], unread: 0 }, publicStats = { total: 0, pending: 0, resolved: 0 };
let adminRows = { items: [], page: 1, totalPages: 1, total: 0 }, adminStats = null, analytics = null, adminPage = 1;
let adminUsers = [], currentAdminTab = 'grievances';
let submitKey = '', pollTimer = null, adminCharts = {};

async function api(method, url, body, headers) {
  const opt = { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, credentials: 'same-origin' };
  if (CSRF && method !== 'GET') opt.headers['X-CSRF-Token'] = CSRF;
  if (body !== undefined) opt.body = JSON.stringify(body);
  let res;
  try { res = await fetch(url, opt); } catch { throw Object.assign(new Error('Cannot reach the server. Check your connection and try again.'), { status: 0 }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && currentUser && !url.includes('/auth/')) { sessionExpired(); }
    throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, fields: data.fields });
  }
  return data;
}
const $ = id => document.getElementById(id);
const esc = s => escapeHTML(String(s ?? ''));
function showErr(id, e) { const el = $(id); if (!el) return; const f = e.fields ? ' ' + Object.values(e.fields).join(' ') : ''; el.textContent = e.message + (e.fields && e.message.startsWith('Please') ? f : ''); el.classList.remove('hidden'); }
function clearErr(id) { const el = $(id); if (el) el.classList.add('hidden'); }
function busy(btn, on, label) { if (!btn) return; btn.disabled = on; btn.dataset.l = btn.dataset.l || btn.textContent; btn.textContent = on ? (label || 'Please wait…') : btn.dataset.l; btn.classList.toggle('opacity-60', on); }
const toFront = c => ({ ...c, department: c.department || 'Unassigned', imageData: '' });
const role = () => (currentUser ? currentUser.role : null);

// ---------- bootstrap / session ----------
function initUserSession() { bootstrap(); }
function loadComplaints() {} function loadReadUpdates() {} function seedDatabase() {}
async function bootstrap() {
  try { CONFIG = await api('GET', '/api/config'); } catch (e) { showToast(e.message, 'error'); }
  fillDeptFilter();
  try { const me = await api('GET', '/api/auth/me'); CSRF = me.csrf; currentUser = me.user; } catch { currentUser = null; }
  updateUserUI();
  await loadData();
  if (currentUser) navigateTo(currentUser.role === 'admin' ? 'admin' : 'student'); else navigateTo('landing');
}
function fillDeptFilter() {
  const sel = $('admin-filter-dept'); if (!sel) return;
  sel.innerHTML = '<option value="ALL">All Departments</option>' + CONFIG.departments.map(d => `<option>${esc(d)}</option>`).join('');
  const studentSel = $('admin-student-filter-dept');
  if (studentSel) {
    studentSel.innerHTML = '<option value="ALL">All Schools & Departments</option>' + CONFIG.departments.map(d => `<option>${esc(d)}</option>`).join('');
  }
}
function sessionExpired() { currentUser = null; CSRF = ''; complaints = []; updateUserUI(); navigateTo('landing'); showToast('Your session has expired. Please sign in again.', 'error'); }
function updateUserUI() {
  const u = currentUser, show = (id, on, disp) => { const e = $(id); if (e) { e.classList.toggle('hidden', !on); if (disp) { e.classList.toggle(disp, on); } } };
  show('nav-user-pill', !!u, 'flex'); show('nav-register-btn', !u); show('hero-register-btn', !u);
  if (!u) return;
  if ($('nav-user-name')) $('nav-user-name').textContent = u.role === 'admin' ? 'Administrator' : u.name.split(' ')[0];
  const badge = $('nav-user-pill')?.querySelector('span.font-mono'); if (badge) badge.textContent = u.role === 'admin' ? 'Admin' : (u.verified ? 'Verified' : 'Pending Verification');
  const ini = u.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'ST';
  if ($('sidebar-user-avatar')) $('sidebar-user-avatar').textContent = ini;
  if ($('sidebar-user-name')) $('sidebar-user-name').textContent = u.name;
  if ($('sidebar-user-srn')) $('sidebar-user-srn').textContent = u.srn ? `SRN: ${u.srn}` : (u.role === 'admin' ? 'Operations Admin' : '');
  if ($('student-greeting-name')) $('student-greeting-name').textContent = u.name.split(' ')[0];
  if ($('input-student-id') && u.srn) $('input-student-id').value = u.srn;
}

// ---------- data loading ----------
async function loadData() {
  try { publicStats = await api('GET', '/api/public/stats'); } catch {}
  try {
    if (role() === 'student') {
      const [list, n] = await Promise.all([api('GET', '/api/student/complaints?pageSize=100&sort=newest'), api('GET', '/api/student/notifications')]);
      complaints = list.items.map(toFront); notifs = n;
    } else if (role() === 'admin') {
      complaints = [];
      const [d, a, n, uList] = await Promise.all([
        api('GET', '/api/admin/dashboard'),
        api('GET', '/api/admin/analytics' + adminDateQuery()),
        api('GET', '/api/admin/notifications'),
        api('GET', '/api/admin/users').catch(() => ({ users: [] }))
      ]);
      adminStats = d; analytics = a; notifs = n; adminUsers = uList.users || [];
      await fetchAdminRows();
    }
  } catch (e) { if (e.status !== 401) showToast(e.message, 'error'); }
  renderAll();
  clearInterval(pollTimer);
  if (currentUser) pollTimer = setInterval(() => { if (!document.hidden) loadData(); }, 30000); // 30s polling
}
const adminDateQuery = () => { const d = $('admin-filter-dept') ? $('admin-filter-dept').value : 'ALL'; return d !== 'ALL' ? '?department=' + encodeURIComponent(d) : ''; };
function renderAll() {
  renderLandingStats(); renderStudentSidebarBadges();
  if (role() === 'student') { renderStudentDashboard(); if (currentStudentTab === 'notifications') renderNotificationsView(); }
  if (role() === 'admin') {
    renderAdminTable(true);
    renderAdminMetrics();
    renderDepartmentChart();
    renderAdminUsersTable();
  }
  updateUserUI();
}
function refreshAllViews() { return loadData(); }
function renderLandingStats() {
  [['landing-stat-total', publicStats.total], ['landing-stat-pending', publicStats.pending], ['landing-stat-resolved', publicStats.resolved]].forEach(([i, v]) => { if ($(i)) $(i).textContent = v; });
}
function getUnreadUpdatesCount() { return notifs.unread; }

// ---------- navigation guards ----------
const _navigate = navigateTo;
window.navigateTo = function (v) {
  if (v === 'student' && role() !== 'student') { if (role() === 'admin') { showToast('You are signed in as an administrator.', 'info'); v = 'admin'; } else { openRegisterModal(); setAuthTab('login'); return _navigate('landing'); } }
  if (v === 'admin' && role() !== 'admin') { openAdminLogin(); return _navigate('landing'); }
  return _navigate(v);
};
const _openComplaint = openComplaintModal;
window.openComplaintModal = function () {
  if (role() !== 'student') { showToast('Please sign in as a student to submit a grievance.', 'info'); openRegisterModal(); setAuthTab('login'); return; }
  submitKey = crypto.randomUUID(); _openComplaint();
};

// ---------- auth ----------
function openAdminLogin() { clearErr('admin-login-error'); openModal('modal-admin-login'); }
function openForgot() { closeModal('modal-register'); $('forgot-msg').textContent = ''; openModal('modal-forgot'); }
async function handleRegisterSubmit(e) {
  e.preventDefault(); clearErr('reg-error');
  const b = { name: $('reg-name').value, srn: $('reg-srn').value, email: $('reg-email').value, department: $('reg-department').value, course: $('reg-course').value,
    semester: $('reg-semester').value, password: $('reg-password').value, confirmPassword: $('reg-confirm').value };
  busy($('reg-submit'), true, 'Registering student…');
  try { await api('POST', '/api/auth/register', b); showToast('Registration successful! Please sign in with your SRN.', 'success'); setAuthTab('login'); $('login-srn').value = b.srn.toUpperCase(); $('login-password').focus(); }
  catch (err) { showErr('reg-error', err); } finally { busy($('reg-submit'), false); }
}
async function doLogin(identifier, password, r, errId, btn) {
  clearErr(errId); busy(btn, true, 'Signing in…');
  try {
    const out = await api('POST', '/api/auth/login', { identifier, password, role: r });
    CSRF = out.csrf; currentUser = out.user; updateUserUI();
    ['modal-register', 'modal-admin-login'].forEach(closeModal);
    showToast(`Welcome back, ${out.user.name}!`, 'success');
    await loadData(); navigateTo(r === 'admin' ? 'admin' : 'student');
  } catch (err) { showErr(errId, err); } finally { busy(btn, false); }
}
function handleLoginSubmit(e) { e.preventDefault(); doLogin($('login-srn').value, $('login-password').value, 'student', 'login-error', $('login-submit')); }
function handleAdminLogin(e) { e.preventDefault(); doLogin($('admin-email').value, $('admin-password').value, 'admin', 'admin-login-error', $('admin-login-submit')); }
async function handleUserLogout() {
  try { await api('POST', '/api/auth/logout', {}); } catch {}
  currentUser = null; CSRF = ''; complaints = []; notifs = { items: [], unread: 0 }; adminStats = null; clearInterval(pollTimer);
  closeModal('modal-profile'); updateUserUI(); await loadData(); navigateTo('landing'); showToast('Signed out securely.', 'info');
}
async function handleForgot(e) { e.preventDefault(); try { const r = await api('POST', '/api/auth/forgot-password', { email: $('forgot-email').value }); $('forgot-msg').textContent = r.message; } catch (x) { $('forgot-msg').textContent = x.message; } }
async function handleReset(e) { e.preventDefault(); try { const r = await api('POST', '/api/auth/reset-password', { token: $('reset-token').value.trim(), password: $('reset-password').value }); $('forgot-msg').textContent = r.message; } catch (x) { $('forgot-msg').textContent = x.message; } }

// ---------- complaints ----------
function updateDeptPreview() { const c = $('input-category').value; $('input-dept-preview').value = c ? (CONFIG.categoryDepartments[c] || 'General Administration') : 'Select Category First'; }
async function handleComplaintFormSubmit(e) {
  e.preventDefault();
  const file = $('input-image').files[0], btn = e.submitter || $('form-complaint').querySelector('[type=submit]');
  const body = { title: $('input-title').value, description: $('input-description').value, category: $('input-category').value, priority: $('input-priority').value, location: $('input-location').value };
  if (file && base64Image) body.attachment = { name: file.name, data: base64Image };
  busy(btn, true, 'Submitting grievance…');
  try {
    const r = await api('POST', '/api/student/complaints', body, { 'Idempotency-Key': submitKey });
    $('form-complaint').reset(); $('image-preview-box').classList.add('hidden'); base64Image = ''; closeModal('modal-complaint');
    showToast(`Grievance submitted successfully. Ticket ID: ${r.complaint.id}`, 'success');
    await loadData(); navigateTo('student'); setStudentTab('dashboard');
  } catch (err) { showToast(err.message + (err.fields ? ' ' + Object.values(err.fields).join(' ') : ''), 'error'); } finally { busy(btn, false); }
}

function getPriorityBadgeHTML(p) {
  const m = {
    Urgent: 'bg-red-100 text-red-800 border-red-300 font-bold',
    High: 'bg-orange-100 text-orange-800 border-orange-300 font-semibold',
    Medium: 'bg-amber-100 text-amber-800 border-amber-300 font-semibold',
    Normal: 'bg-stone-100 text-stone-700 border-stone-300 font-semibold'
  };
  return `<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] border ${m[p] || m.Normal}">${p === 'Urgent' ? '<span class="w-1.5 h-1.5 rounded-full bg-red-600 mr-1 animate-pulse"></span>' : ''}${esc(p)}</span>`;
}

const _statusBadge = window.getStatusBadgeHTML;
window.getStatusBadgeHTML = function (s) {
  if (s === 'Submitted') return '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-orange-100 text-orange-900 border border-orange-300">Submitted</span>';
  if (s === 'Acknowledged') return '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-900 border border-amber-300">Acknowledged</span>';
  if (s === 'In Progress') return '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-900 border border-amber-300">In Progress</span>';
  if (s === 'Resolved') return '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-100 text-emerald-900 border border-emerald-300">Resolved</span>';
  if (s === 'Rejected') return '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-rose-100 text-rose-900 border border-rose-300">Rejected</span>';
  if (s === 'Reopened') return '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-orange-100 text-orange-950 border border-orange-300">Reopened</span>';
  return _statusBadge ? _statusBadge(s) : `<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-stone-100 text-stone-800 border border-stone-300">${esc(s)}</span>`;
};

// ---------- notifications ----------
function renderNotificationsView() {
  const box = $('student-notifications-list'); if (!box) return;
  if (!notifs.items.length) { box.innerHTML = '<div class="glass-card p-8 text-center text-stone-500 rounded-xl border border-orange-200/60 text-xs">No notifications yet. Updates on your grievances will appear here in real time.</div>'; return; }
  box.innerHTML = notifs.items.map(n => `<div class="glass-card p-4 rounded-xl border ${n.isRead ? 'border-orange-200/50' : 'border-orange-400 bg-orange-50/40 shadow-sm'} cursor-pointer hover:border-orange-500 transition" onclick="markNotificationAsRead(${n.id}, '${esc(n.ticket || '')}')">
    <div class="flex justify-between text-[11px] text-stone-500"><span class="font-mono font-bold text-orange-700 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded">${esc(n.ticket || 'Portal Account')}</span><span>${formatDate(n.createdAt)}</span></div>
    <p class="text-xs text-stone-800 mt-2 font-medium">${!n.isRead ? '<span class="inline-block w-2 h-2 rounded-full bg-orange-600 mr-1.5 animate-pulse"></span>' : ''}${esc(n.message)}</p></div>`).join('');
}
async function markNotificationAsRead(id, ticket) {
  try { await api('PATCH', `/api/${role()}/notifications/${id}/read`, {}); await loadData(); } catch (e) { showToast(e.message, 'error'); }
  if (ticket) openDetailModal(ticket);
}
async function markAllNotificationsAsRead() { try { await api('POST', `/api/${role()}/notifications/read-all`, {}); await loadData(); showToast('All notifications marked as read', 'success'); } catch (e) { showToast(e.message, 'error'); } }

// ---------- admin ----------
let adminTimer = null;
async function fetchAdminRows() {
  const p = new URLSearchParams({ page: adminPage, pageSize: 15, sort: $('admin-sort').value });
  [['search', 'admin-search-input'], ['department', 'admin-filter-dept'], ['status', 'admin-filter-status'], ['priority', 'admin-filter-priority']].forEach(([k, id]) => { const v = $(id).value; if (v && v !== 'ALL') p.set(k, v); });
  adminRows = await api('GET', '/api/admin/complaints?' + p);
}
function renderAdminTable(fromLoad) {
  const tb = $('admin-table-body'); if (!tb) return;
  if (!fromLoad) { clearTimeout(adminTimer); adminPage = 1; adminTimer = setTimeout(() => fetchAdminRows().then(() => renderAdminTable(true)).catch(e => showToast(e.message, 'error')), 250); return; }
  const th = tb.closest('table').querySelector('thead tr'); if (th && th.children.length === 7) th.innerHTML = '<th class="p-3">Ticket ID</th><th class="p-3">Submitted</th><th class="p-3">Student</th><th class="p-3">Grievance Details</th><th class="p-3">Department / Location</th><th class="p-3">Status</th><th class="p-3 text-right">Action</th>';
  tb.innerHTML = adminRows.items.length ? adminRows.items.map(c => `<tr class="hover:bg-orange-50/50 border-b border-orange-200/60 transition ${c.priority === 'Urgent' && !['Resolved', 'Rejected'].includes(c.status) ? 'bg-red-50/70' : ''}">
    <td class="p-3 font-mono font-bold text-orange-700 whitespace-nowrap"><span class="bg-orange-50 border border-orange-200 px-2 py-0.5 rounded">${esc(c.id)}</span></td>
    <td class="p-3 text-stone-600 whitespace-nowrap">${formatDateShort(c.createdAt)}<div class="text-[10px] text-stone-400">upd ${formatDateShort(c.updatedAt)}</div></td>
    <td class="p-3"><div class="font-bold text-stone-900">${esc(c.studentName)}</div><div class="font-mono text-[10px] text-stone-500">${esc(c.studentId)}</div></td>
    <td class="p-3 max-w-xs"><div class="font-semibold text-stone-900 truncate">${esc(c.title)}</div><div class="text-[11px] text-stone-500 truncate">${esc(c.description.slice(0, 70))}</div><div class="mt-1 flex items-center space-x-1.5">${getPriorityBadgeHTML(c.priority)} <span class="text-[10px] text-stone-500 font-medium">${esc(c.category)}</span>${c.overdue ? ' <span class="text-[10px] font-bold text-red-600 bg-red-100 px-1 rounded border border-red-200 animate-pulse">OVERDUE</span>' : ''}</div></td>
    <td class="p-3"><div class="font-medium text-stone-800">${esc(c.department || 'Unassigned')}</div><div class="text-[11px] text-stone-500">📍 ${esc(c.location)}</div></td>
    <td class="p-3 whitespace-nowrap">${getStatusBadgeHTML(c.status)}</td>
    <td class="p-3 text-right whitespace-nowrap"><button onclick="openDetailModal('${esc(c.id)}')" class="btn-secondary px-3 py-1 text-xs shadow-sm hover:border-orange-400 hover:text-orange-700">Manage →</button></td></tr>`).join('')
    : '<tr><td colspan="7" class="p-8 text-center text-stone-500 text-xs">No grievances matching your current search or filters.</td></tr>';
  let pg = $('admin-pager');
  if (!pg) { pg = document.createElement('div'); pg.id = 'admin-pager'; pg.className = 'flex items-center justify-between p-3.5 text-xs text-stone-600 bg-orange-50/30 border-t border-orange-200/60 rounded-b-lg'; tb.closest('table').parentElement.appendChild(pg); }
  pg.innerHTML = `<span class="font-medium">${adminRows.total} total grievances · sorted by priority and SLA timeline</span><span class="space-x-2"><button class="btn-secondary px-2.5 py-1 text-xs" ${adminRows.page <= 1 ? 'disabled' : ''} onclick="adminGo(-1)">Prev</button> <span class="font-semibold text-stone-800">Page ${adminRows.page} of ${adminRows.totalPages}</span> <button class="btn-secondary px-2.5 py-1 text-xs" ${adminRows.page >= adminRows.totalPages ? 'disabled' : ''} onclick="adminGo(1)">Next</button></span>`;
}
function adminGo(d) { adminPage += d; fetchAdminRows().then(() => renderAdminTable(true)); }

function renderAdminMetrics() {
  const s = adminStats; if (!s) return;
  [['total', s.total], ['pending', s.pending], ['resolved', s.resolved], ['rejected', s.rejected]].forEach(([k, v]) => { if ($('admin-metric-' + k)) $('admin-metric-' + k).textContent = v; });
  let x = $('admin-extra');
  const anchor = $('admin-metric-total')?.closest('.grid') || $('admin-metric-total')?.parentElement?.parentElement;
  if (!x && anchor) { x = document.createElement('div'); x.id = 'admin-extra'; x.className = 'space-y-4'; anchor.parentElement.insertBefore(x, anchor.nextSibling); }
  if (!x) return;
  const tile = (l, v, c) => `<div class="glass-card rounded-xl p-3 border border-orange-200/50"><div class="text-[10px] uppercase font-bold text-stone-500 tracking-wider">${l}</div><div class="text-xl font-extrabold ${c} mt-0.5">${v}</div></div>`;
  x.innerHTML = `<div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">${tile('New', s.newlySubmitted, 'text-orange-700')}${tile('Urgent open', s.urgent, 'text-red-600')}${tile('High open', s.high, 'text-orange-600')}${tile('Medium open', s.medium, 'text-amber-600')}${tile('Normal open', s.normal, 'text-stone-700')}${tile('In progress', s.inProgress, 'text-amber-700')}${tile('Overdue (SLA)', s.overdue, 'text-red-600')}${tile('Avg resolution', s.avgResolutionHours == null ? '—' : s.avgResolutionHours + ' h', 'text-emerald-700')}</div>
   <div class="grid md:grid-cols-3 gap-4">
     <div class="glass-card rounded-xl p-4 border border-orange-200/60 shadow-sm"><div class="text-xs font-bold text-stone-800 uppercase tracking-wider mb-2">Priority Distribution</div><div class="h-44"><canvas id="ch-prio"></canvas></div></div>
     <div class="glass-card rounded-xl p-4 border border-orange-200/60 shadow-sm"><div class="text-xs font-bold text-stone-800 uppercase tracking-wider mb-2">Monthly: Submitted vs Resolved</div><div class="h-44"><canvas id="ch-month"></canvas></div></div>
     <div class="glass-card rounded-xl p-4 border border-orange-200/60 shadow-sm"><div class="text-xs font-bold text-stone-800 uppercase tracking-wider mb-2">Department: Open vs Resolved</div><div class="h-44"><canvas id="ch-dept"></canvas></div></div>
   </div>
   <p class="text-[11px] text-stone-500">Live Resolution Rate: <strong class="text-emerald-700">${analytics ? analytics.resolutionRate : 0}%</strong> · computed directly from the SQLite database; auto-refresh every 30 seconds.</p>`;
  if (typeof Chart === 'undefined' || !analytics) return;
  const mk = (id, cfg) => { adminCharts[id]?.destroy(); adminCharts[id] = new Chart($(id), { ...cfg, options: { responsive: true, maintainAspectRatio: false, ...(cfg.options || {}) } }); };
  const P = analytics.byPriority, col = { Urgent: '#dc2626', High: '#ea580c', Medium: '#f59e0b', Normal: '#78716c' };
  mk('ch-prio', { type: 'doughnut', data: { labels: Object.keys(P), datasets: [{ data: Object.values(P), backgroundColor: Object.keys(P).map(k => col[k]), borderWidth: 2, borderColor: '#fffdfa' }] } });
  mk('ch-month', { type: 'bar', data: { labels: analytics.monthly.map(m => m.month), datasets: [{ label: 'Submitted', data: analytics.monthly.map(m => m.submitted), backgroundColor: '#ea580c', borderRadius: 4 }, { label: 'Resolved', data: analytics.monthly.map(m => m.resolved), backgroundColor: '#10b981', borderRadius: 4 }] } });
  mk('ch-dept', { type: 'bar', data: { labels: analytics.departmentPerformance.map(d => d.dept.split(' ')[0]), datasets: [{ label: 'Open', data: analytics.departmentPerformance.map(d => d.open), backgroundColor: '#f97316', borderRadius: 4 }, { label: 'Resolved', data: analytics.departmentPerformance.map(d => d.resolved), backgroundColor: '#10b981', borderRadius: 4 }] }, options: { scales: { x: { stacked: true }, y: { stacked: true } } } });
}

function renderDepartmentChart() {
  const svg = $('chart-svg-departments'), box = $('category-ratio-container'); if (!svg || !analytics) return;
  const d = Object.entries(analytics.byDepartment), max = Math.max(1, ...d.map(x => x[1])), w = 470 / Math.max(d.length, 1);
  svg.innerHTML = d.length ? d.map(([k, v], i) => { const h = (v / max) * 85, x = 15 + i * w; return `<rect x="${x + 4}" y="${110 - h}" width="${w - 12}" height="${h}" fill="#ea580c" rx="4"><title>${esc(k)}: ${v}</title></rect><text x="${x + w / 2 - 2}" y="${104 - h}" text-anchor="middle" font-size="10" font-weight="bold" fill="#431407">${v}</text><text x="${x + w / 2 - 2}" y="128" text-anchor="middle" font-size="8" font-weight="600" fill="#78716c">${esc(k.split(' ')[0])}</text>`; }).join('') + '<line x1="10" y1="110" x2="480" y2="110" stroke="#fed7aa" stroke-width="1.5" />'
    : '<text x="250" y="70" text-anchor="middle" font-size="12" fill="#a8a29e">No grievances recorded yet</text>';
  const tot = analytics.total || 1;
  box.innerHTML = Object.entries(analytics.byCategory).map(([k, v]) => `<div class="flex items-center justify-between border-b border-orange-100 pb-1.5"><span class="text-stone-700">${esc(k)}</span><span class="font-bold text-stone-900">${v} <span class="text-orange-600 font-semibold text-[11px]">(${Math.round(v / tot * 100)}%)</span></span></div>`).join('') || '<p class="text-stone-400">No data available</p>';
}

// ---------- admin student management ----------
window.setAdminTab = function (tabId) {
  currentAdminTab = tabId;
  const tabs = ['grievances', 'analytics', 'students'];
  tabs.forEach(t => {
    const btn = $('admin-tab-btn-' + t);
    const view = $('admin-subview-' + t);
    if (t === tabId) {
      if (view) view.classList.remove('hidden');
      if (btn) btn.className = 'px-4 py-2 rounded-lg text-xs font-bold bg-orange-600 text-white shadow-sm transition';
    } else {
      if (view) view.classList.add('hidden');
      if (btn) btn.className = 'px-4 py-2 rounded-lg text-xs font-medium text-stone-600 hover:text-stone-900 hover:bg-orange-100/50 transition';
    }
  });
  if (tabId === 'students') renderAdminUsersTable();
};

window.renderAdminUsersTable = function () {
  const tb = $('admin-students-table-body'); if (!tb) return;
  const q = ($('admin-student-search')?.value || '').toLowerCase().trim();
  const dept = $('admin-student-filter-dept')?.value || 'ALL';
  const status = $('admin-student-filter-status')?.value || 'ALL';

  const students = adminUsers.filter(u => u.role === 'student').filter(u => {
    const matchQ = (u.full_name || '').toLowerCase().includes(q) || (u.srn || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q);
    const matchDept = (dept === 'ALL') || (u.department === dept);
    const matchStatus = (status === 'ALL') || (status === 'verified' && u.verified) || (status === 'unverified' && !u.verified);
    return matchQ && matchDept && matchStatus;
  });

  const countBadge = $('admin-students-count');
  if (countBadge) countBadge.textContent = `${students.length} students enrolled`;

  if (!students.length) {
    tb.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-stone-500 text-xs">No student accounts matching criteria.</td></tr>';
    return;
  }

  tb.innerHTML = students.map(u => `
    <tr class="hover:bg-orange-50/40 border-b border-orange-200/50 transition">
      <td class="p-3 font-mono font-bold text-orange-700 whitespace-nowrap"><span class="bg-orange-50 border border-orange-200 px-2 py-0.5 rounded">${esc(u.srn || 'N/A')}</span></td>
      <td class="p-3"><div class="font-bold text-stone-900">${esc(u.full_name)}</div><div class="text-[11px] text-stone-500 font-mono">${esc(u.email)}</div></td>
      <td class="p-3 text-stone-700"><span class="font-medium">${esc(u.department || 'School of Computing & IT')}</span></td>
      <td class="p-3 text-stone-600 text-xs">${esc(u.course || 'B.Tech')} · ${esc(u.semester || 'Semester')}</td>
      <td class="p-3 whitespace-nowrap">
        ${u.verified ? '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-100 text-emerald-900 border border-emerald-300"><span class="w-1.5 h-1.5 rounded-full bg-emerald-600 mr-1.5"></span>Verified</span>'
                    : '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-amber-100 text-amber-900 border border-amber-300"><span class="w-1.5 h-1.5 rounded-full bg-amber-600 mr-1.5"></span>Pending Verification</span>'}
      </td>
      <td class="p-3 text-stone-500 text-[11px] whitespace-nowrap">${formatDateShort(u.created_at)}</td>
      <td class="p-3 text-right whitespace-nowrap">
        <button onclick="toggleStudentVerification(${u.id}, ${!!u.verified})" class="px-3 py-1 rounded text-xs font-semibold ${u.verified ? 'bg-stone-100 text-stone-700 hover:bg-stone-200 border border-stone-300' : 'btn-primary'} shadow-sm">
          ${u.verified ? 'Revoke Verification' : 'Verify Student ✓'}
        </button>
      </td>
    </tr>
  `).join('');
};

window.toggleStudentVerification = async function (id, currentVerified) {
  try {
    await api('PATCH', `/api/admin/users/${id}/verify`, { verified: !currentVerified });
    showToast(`Student verification ${!currentVerified ? 'approved' : 'revoked'} successfully.`, 'success');
    await loadData();
  } catch (e) {
    showToast(e.message, 'error');
  }
};

// ---------- detail modal ----------
let activeDetail = null;
async function openDetailModal(ticketId) {
  activeTicketId = ticketId;
  let t; try { t = await api('GET', `/api/${role()}/complaints/${encodeURIComponent(ticketId)}`); } catch (e) { showToast(e.message, 'error'); return; }
  activeDetail = t; const admin = role() === 'admin';
  $('detail-ticket-id').textContent = t.id; $('detail-priority-badge').innerHTML = getPriorityBadgeHTML(t.priority); $('detail-status-badge').innerHTML = getStatusBadgeHTML(t.status);
  $('detail-title').textContent = t.title; $('detail-date').textContent = `Submitted ${formatDate(t.createdAt)}${t.resolvedAt ? ' · Resolved ' + formatDate(t.resolvedAt) : ''}`;
  $('detail-category').textContent = t.category + (t.subcategory ? ' / ' + t.subcategory : ''); $('detail-location').textContent = t.location; $('detail-dept').textContent = t.department || 'Unassigned';
  $('detail-student-id').textContent = admin ? `${t.studentId} · ${t.studentName}` : t.studentId; $('detail-description').textContent = t.description;
  const steps = ['Submitted', 'Acknowledged', 'In Progress', 'Resolved'], seen = new Set(t.history.map(h => h.status));
  const rej = t.status === 'Rejected';
  $('detail-stepper-container').innerHTML = (rej ? ['Submitted', 'Rejected'] : steps).map((s, i, a) => { const on = seen.has(s) || (s === 'Submitted'), cur = t.status === s;
    return `<div class="flex items-center ${i < a.length - 1 ? 'flex-1' : ''}"><div class="flex items-center space-x-1 text-[10px] font-semibold ${on ? (s === 'Rejected' ? 'text-rose-700' : 'text-orange-700') : 'text-stone-400'}"><span class="w-5 h-5 rounded-full ${on ? (s === 'Rejected' ? 'bg-rose-600' : 'bg-orange-600') : 'bg-stone-300'} text-white flex items-center justify-center text-[10px] font-bold ${cur ? 'ring-2 ring-offset-1 ring-orange-400' : ''}">${on ? '✓' : (i + 1)}</span><span>${s}</span></div>${i < a.length - 1 ? `<div class="h-0.5 flex-1 mx-2 ${seen.has(a[i + 1]) ? 'bg-orange-600' : 'bg-stone-300'}"></div>` : ''}</div>`; }).join('');
  $('detail-image-box').classList.add('hidden');
  const nb = $('detail-note-box'); if (t.adminNote || t.rejectionReason) { $('detail-note-text').textContent = t.rejectionReason ? `Rejected: ${t.rejectionReason}` : t.adminNote; nb.classList.remove('hidden'); } else nb.classList.add('hidden');
  $('admin-action-section').classList.toggle('hidden', !admin);
  if (admin) {
    const next = { Submitted: ['Acknowledged', 'In Progress', 'Rejected'], Acknowledged: ['In Progress', 'Resolved', 'Rejected'], 'In Progress': ['Acknowledged', 'Resolved', 'Rejected'], Resolved: ['Reopened'], Rejected: ['Reopened'], Reopened: ['Acknowledged', 'In Progress', 'Resolved', 'Rejected'] }[t.status];
    $('admin-update-status').innerHTML = `<option value="">Keep Status: ${t.status}</option>` + next.map(s => `<option>${s}</option>`).join('');
    $('admin-update-note').value = ''; $('admin-update-note').placeholder = 'Resolution note (required to resolve) / rejection reason (required to reject)';
    let ds = $('admin-update-dept'); if (!ds) { ds = document.createElement('select'); ds.id = 'admin-update-dept'; ds.className = 'w-full border border-stone-300 rounded-lg px-3 py-2 bg-white mt-2 text-xs focus:ring-2 focus:ring-orange-500 focus:outline-none'; $('admin-update-note').parentElement.appendChild(ds); }
    ds.innerHTML = CONFIG.departments.map(d => `<option ${d === t.department ? 'selected' : ''}>${esc(d)}</option>`).join('');
  }
  const hist = t.history.map(h => `<li class="text-[11px] text-stone-700"><b>${esc(h.status)}</b> · ${formatDate(h.at)} · ${esc(h.by)}${h.notes ? ` — <span class="text-orange-950 font-medium">"${esc(h.notes)}"</span>` : ''}</li>`).join('');
  const cm = t.comments.map(c => `<li class="text-[11px] p-2.5 rounded-lg border ${c.role === 'admin' ? 'bg-orange-50/80 border-orange-200 text-orange-950' : 'bg-stone-50 border-stone-200 text-stone-800'}"><b>${esc(c.author)}${c.role === 'admin' ? ' (Admin Response)' : ''}</b> · <span class="text-stone-400 text-[10px]">${formatDate(c.at)}</span><p class="mt-1">${esc(c.message)}</p></li>`).join('');
  const att = t.attachments.map(a => a.mime.startsWith('image/') ? `<a href="/api/attachments/${a.id}" target="_blank" rel="noopener"><img src="/api/attachments/${a.id}" alt="${esc(a.name)}" class="max-h-40 rounded-lg border border-orange-200 shadow-sm hover:opacity-90"></a>` : `<a class="text-orange-700 underline text-xs font-semibold" target="_blank" rel="noopener" href="/api/attachments/${a.id}">📄 ${esc(a.name)}</a>`).join(' ');
  const canReopen = !admin && t.status === 'Resolved' && (Date.now() - Date.parse(t.resolvedAt)) / 864e5 <= CONFIG.reopenDays;
  $('detail-extra').innerHTML = `${att ? `<div class="p-3 bg-orange-50/40 rounded-lg border border-orange-200"><div class="text-[10px] uppercase font-bold text-stone-600 mb-1">Attached Evidence</div>${att}</div>` : ''}
    <div><div class="text-[10px] uppercase font-bold text-stone-500 tracking-wider mb-1">Status Audit History</div><ol class="space-y-1 list-decimal pl-4">${hist}</ol></div>
    <div class="space-y-2"><div class="text-[10px] uppercase font-bold text-stone-500 tracking-wider">Communication & Follow-up Thread</div><ul class="space-y-2">${cm || '<li class="text-[11px] text-stone-400 p-2 bg-stone-50 rounded">No messages exchanged yet.</li>'}</ul>
    <div class="flex gap-2 mt-2"><input id="msg-input" maxlength="2000" placeholder="${admin ? 'Reply to student…' : 'Add follow-up message…'}" class="flex-1 border border-stone-300 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-orange-500 focus:outline-none bg-white"><button onclick="sendMessage()" class="btn-primary px-4 text-xs font-semibold">Send</button></div>
    ${canReopen ? '<button onclick="reopenComplaint()" class="btn-secondary px-3.5 py-1.5 text-xs mt-2 border-orange-300 text-orange-800">Reopen Grievance</button>' : ''}</div>`;
  openModal('modal-detail');
}
async function sendMessage() {
  const m = $('msg-input').value.trim(); if (!m) return;
  try { await api('POST', `/api/${role()}/complaints/${encodeURIComponent(activeTicketId)}/comments`, { message: m }); showToast('Message posted', 'success'); await openDetailModal(activeTicketId); loadData(); } catch (e) { showToast(e.message, 'error'); }
}
async function reopenComplaint() {
  try { await api('POST', `/api/student/complaints/${encodeURIComponent(activeTicketId)}/reopen`, { message: $('msg-input').value || 'Student requested reopening.' }); showToast('Grievance reopened', 'success'); closeModal('modal-detail'); loadData(); } catch (e) { showToast(e.message, 'error'); }
}
async function saveAdminStatusChange() {
  const st = $('admin-update-status').value, note = $('admin-update-note').value.trim(), dept = $('admin-update-dept').value, t = activeDetail, id = encodeURIComponent(activeTicketId);
  try {
    if (dept && dept !== t.department) await api('PATCH', `/api/admin/complaints/${id}/department`, { department: dept });
    if (st) await api('PATCH', `/api/admin/complaints/${id}/status`, st === 'Rejected' ? { status: st, reason: note } : { status: st, note });
    else if (note) await api('POST', `/api/admin/complaints/${id}/comments`, { message: note });
    closeModal('modal-detail'); showToast(`Ticket ${activeTicketId} updated successfully.`, 'success'); await loadData();
  } catch (e) { showToast(e.message + (e.fields ? ' (' + Object.keys(e.fields).join(', ') + ' required)' : ''), 'error'); }
}
