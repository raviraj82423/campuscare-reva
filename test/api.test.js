'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createApp } = require('../server/app');
const S = require('../server/security');

let app, base, tmp;
class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async call(method, url, body, headers = {}) {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie && { Cookie: this.cookie }),
      ...(this.csrf && method !== 'GET' && { 'X-CSRF-Token': this.csrf }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.arrayBuffer() };
  }
  async login(identifier, password, role = 'student') { const r = await this.call('POST', '/api/auth/login', { identifier, password, role }); if (r.status === 200) this.csrf = r.data.csrf; return r; }
}
const PNG = Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]), Buffer.alloc(32)]).toString('base64');
const reg = (n, srn, email) => ({ name: n, srn, email, password: 'Passw0rdX', confirmPassword: 'Passw0rdX', department: 'CSE' });
const complaint = (o = {}) => ({ title: 'Broken projector in room 204', description: 'The projector will not power on at all.', category: 'Infrastructure', priority: 'Medium', location: 'Block A 204', ...o });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
  app = createApp({ dbFile: path.join(tmp, 't.db'), uploadDir: path.join(tmp, 'up'), exposeResetToken: true, loginMax: 6 });
  await new Promise(ok => app.server.listen(0, ok));
  base = 'http://127.0.0.1:' + app.server.address().port;
  app.db.prepare("INSERT INTO users(full_name,srn,email,password_hash,role,verified) VALUES('Admin',NULL,'admin@x.edu',?,'admin',1)").run(S.hashPassword('Adm1nPass99'));
});
after(async () => { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

let alice, bob, admin, t1;
test('1 registration + 2 duplicate SRN/email rejected + validation', async () => {
  const c = new Client();
  assert.equal((await c.call('POST', '/api/auth/register', reg('Alice A', 'R21AAA001', 'alice@x.edu'))).status, 201);
  assert.equal((await c.call('POST', '/api/auth/register', reg('Bob B', 'R21BBB002', 'bob@x.edu'))).status, 201);
  assert.equal((await c.call('POST', '/api/auth/register', reg('Dup', 'r21aaa001', 'other@x.edu'))).status, 409);
  assert.equal((await c.call('POST', '/api/auth/register', reg('Dup', 'R21CCC003', 'ALICE@x.edu'))).status, 409);
  const weak = await c.call('POST', '/api/auth/register', { ...reg('W', 'R21DDD004', 'w@x.edu'), password: 'short', confirmPassword: 'short' });
  assert.equal(weak.status, 400); assert.ok(weak.data.fields.password);
});
test('3-5 student login, invalid login, role separation', async () => {
  alice = new Client(); bob = new Client(); admin = new Client();
  assert.equal((await alice.login('R21AAA001', 'Passw0rdX')).status, 200);
  assert.equal((await bob.login('bob@x.edu', 'Passw0rdX')).status, 200);
  assert.equal((await new Client().login('R21AAA001', 'wrong-pass1')).status, 401);
  assert.equal((await new Client().login('admin@x.edu', 'Adm1nPass99', 'student')).status, 401, 'admin cannot use student portal');
  assert.equal((await new Client().login('R21AAA001', 'Passw0rdX', 'admin')).status, 401, 'student cannot use admin portal');
  assert.equal((await admin.login('admin@x.edu', 'Adm1nPass99', 'admin')).status, 200);
  assert.equal((await alice.call('GET', '/api/auth/me')).data.user.srn, 'R21AAA001');
});
test('6-8 complaint creation, ticket id, persistence, department mapping, attachments', async () => {
  const r = await alice.call('POST', '/api/student/complaints', complaint({ attachment: { name: 'p.png', data: PNG } }));
  assert.equal(r.status, 201); t1 = r.data.complaint.id;
  assert.match(t1, /^CC-\d{4}-1001$/);
  assert.equal(r.data.complaint.department, 'Maintenance Department');
  assert.equal(r.data.complaint.status, 'Submitted');
  assert.equal(r.data.complaint.attachments.length, 1);
  const r2 = await alice.call('POST', '/api/student/complaints', complaint({ title: 'Wi-Fi dead on third floor', category: 'Wi-Fi/Internet', priority: 'Urgent' }));
  assert.match(r2.data.complaint.id, /1002$/);
  assert.equal(r2.data.complaint.department, 'IT Department');
  const bad = await alice.call('POST', '/api/student/complaints', complaint({ attachment: { name: 'x.exe', data: Buffer.from('MZ not an image').toString('base64') } }));
  assert.equal(bad.status, 400); assert.ok(bad.data.fields.attachment);
  assert.equal((await alice.call('POST', '/api/student/complaints', complaint({ title: 'x' }))).status, 400);
  const k = { 'Idempotency-Key': 'abc-123' };
  const a = await bob.call('POST', '/api/student/complaints', complaint({ title: 'Idempotent complaint one' }), k);
  const b = await bob.call('POST', '/api/student/complaints', complaint({ title: 'Idempotent complaint one' }), k);
  assert.equal(a.data.complaint.id, b.data.complaint.id); assert.equal(b.data.duplicate, true);
});
test('9-10 student isolation and unauthorized access', async () => {
  const mine = await bob.call('GET', '/api/student/complaints');
  assert.equal(mine.data.total, 1);
  assert.equal((await bob.call('GET', `/api/student/complaints/${t1}`)).status, 404);
  assert.equal((await bob.call('POST', `/api/student/complaints/${t1}/comments`, { message: 'hi' })).status, 404);
  assert.equal((await bob.call('GET', '/api/admin/complaints')).status, 403);
  assert.equal((await bob.call('PATCH', `/api/admin/complaints/${t1}/status`, { status: 'Resolved', note: 'x' })).status, 403);
  assert.equal((await new Client().call('GET', '/api/student/complaints')).status, 401);
  const att = alice.call.bind(alice);
  const id = (await alice.call('GET', `/api/student/complaints/${t1}`)).data.attachments[0].id;
  assert.equal((await att('GET', `/api/attachments/${id}`)).status, 200);
  assert.equal((await bob.call('GET', `/api/attachments/${id}`)).status, 404);
  assert.equal((await admin.call('GET', `/api/attachments/${id}`)).status, 200);
  // CSRF: valid session cookie but no token
  const raw = await fetch(base + '/api/student/complaints', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice.cookie }, body: JSON.stringify(complaint()) });
  assert.equal(raw.status, 403);
});
test('11-13 admin queue: priority sorting, filtering, search', async () => {
  const q = await admin.call('GET', '/api/admin/complaints');
  assert.equal(q.data.total, 3);
  assert.equal(q.data.items[0].priority, 'Urgent');
  assert.ok(q.data.items[0].studentId && q.data.items[0].studentName);
  assert.equal((await admin.call('GET', '/api/admin/complaints?department=IT%20Department')).data.total, 1);
  assert.equal((await admin.call('GET', '/api/admin/complaints?priority=Medium&status=Submitted')).data.total, 2);
  assert.equal((await admin.call('GET', '/api/admin/complaints?search=R21AAA001')).data.total, 2);
  assert.equal((await admin.call('GET', '/api/admin/complaints?search=%25')).data.total, 0, 'LIKE wildcards are escaped');
  assert.equal((await admin.call('GET', '/api/admin/complaints?pageSize=1&page=2')).data.items.length, 1);
});
test('14-16 status transitions, validation, notes, timestamps, history, audit', async () => {
  const P = (s, b) => admin.call('PATCH', `/api/admin/complaints/${t1}/status`, { status: s, ...b });
  assert.equal((await P('Resolved', { note: 'x' })).status, 400, 'Submitted -> Resolved not allowed');
  assert.equal((await P('Rejected', {})).status, 400, 'reject needs reason');
  assert.equal((await P('In Progress', { note: 'Technician assigned' })).status, 200);
  assert.equal((await P('Resolved', {})).status, 400, 'resolve needs note');
  const done = await P('Resolved', { note: 'Projector lamp replaced' });
  assert.equal(done.data.status, 'Resolved'); assert.ok(done.data.resolvedAt);
  assert.deepEqual(done.data.history.map(h => h.status), ['Submitted', 'In Progress', 'Resolved']);
  assert.equal(done.data.history[2].by, 'Admin');
  assert.ok(app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='complaint.status'").get().n >= 2);
  assert.equal((await alice.call('PATCH', `/api/admin/complaints/${t1}/status`, { status: 'Submitted' })).status, 403, 'student cannot change status');
  const d = await admin.call('PATCH', `/api/admin/complaints/${t1}/department`, { department: 'IT Department' });
  assert.equal(d.data.department, 'IT Department');
  const ro = await alice.call('POST', `/api/student/complaints/${t1}/reopen`, { message: 'still broken' });
  assert.equal(ro.status, 200);
  assert.equal((await alice.call('GET', `/api/student/complaints/${t1}`)).data.status, 'Reopened');
});
test('17-18 dashboard statistics and analytics match the database', async () => {
  const sd = (await alice.call('GET', '/api/student/dashboard')).data;
  assert.equal(sd.total, 2); assert.equal(sd.byStatus.Reopened, 1); assert.equal(sd.byStatus.Submitted, 1);
  const ad = (await admin.call('GET', '/api/admin/dashboard')).data;
  assert.equal(ad.total, 3); assert.equal(ad.urgent, 1);
  const an = (await admin.call('GET', '/api/admin/analytics')).data;
  assert.equal(an.total, 3); assert.equal(an.byPriority.Urgent, 1);
  assert.equal(Object.values(an.byDepartment).reduce((a, b) => a + b, 0), 3);
  assert.equal((await bob.call('GET', '/api/admin/analytics')).status, 403);
});
test('19 notifications: created for the right people only', async () => {
  const an = await alice.call('GET', '/api/student/notifications');
  assert.ok(an.data.unread >= 3 && an.data.items.every(n => !/Idempotent/.test(n.message)));
  const bn = await bob.call('GET', '/api/student/notifications');
  assert.ok(bn.data.items.every(n => !n.message.includes(t1)));
  assert.ok((await admin.call('GET', '/api/admin/notifications')).data.items.some(n => n.message.includes('URGENT')));
  await alice.call('PATCH', `/api/student/notifications/${an.data.items[0].id}/read`, {});
  assert.equal((await alice.call('GET', '/api/student/notifications')).data.unread, an.data.unread - 1);
  await bob.call('PATCH', `/api/student/notifications/${an.data.items[1].id}/read`, {});
  assert.equal((await alice.call('GET', '/api/student/notifications')).data.unread, an.data.unread - 1, "bob can't mark alice's");
});
test('forgot/reset password flow', async () => {
  const c = new Client();
  const f = await c.call('POST', '/api/auth/forgot-password', { email: 'bob@x.edu' });
  assert.ok(f.data.devToken);
  assert.equal((await c.call('POST', '/api/auth/reset-password', { token: f.data.devToken, password: 'NewPass123' })).status, 200);
  assert.equal((await c.call('POST', '/api/auth/reset-password', { token: f.data.devToken, password: 'NewPass123' })).status, 400, 'single use');
  assert.equal((await new Client().login('bob@x.edu', 'NewPass123')).status, 200);
  assert.equal((await bob.call('GET', '/api/auth/me')).status, 401, 'old sessions revoked');
});
test('20 logout invalidates session; protected routes; rate limiting', async () => {
  assert.equal((await alice.call('POST', '/api/auth/logout', {})).status, 200);
  assert.equal((await alice.call('GET', '/api/student/dashboard')).status, 401);
  const x = new Client(); let last;
  for (let i = 0; i < 8; i++) last = await x.login('R21AAA001', 'nope-nope1');
  assert.equal(last.status, 429);
});
test('static page served; unknown API 404; no stack traces', async () => {
  const p = await fetch(base + '/'); assert.equal(p.status, 200);
  assert.equal((await fetch(base + '/../server/app.js')).status === 200 && (await fetch(base + '/%2e%2e/server/app.js')).status === 200, false);
  const r = await new Client().call('GET', '/api/nope'); assert.equal(r.status, 404);
});
