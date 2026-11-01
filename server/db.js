'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(`
CREATE TABLE IF NOT EXISTS departments(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS category_map(
  category TEXT PRIMARY KEY, department_id INTEGER NOT NULL REFERENCES departments(id));
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, srn TEXT UNIQUE, email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('student','admin')),
  department TEXT, course TEXT, semester TEXT,
  verified INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reset_tokens(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS complaints(
  id INTEGER PRIMARY KEY, ticket_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, subcategory TEXT,
  priority TEXT NOT NULL CHECK(priority IN('Urgent','High','Medium','Normal')),
  location TEXT NOT NULL, department_id INTEGER REFERENCES departments(id),
  status TEXT NOT NULL DEFAULT 'Submitted'
    CHECK(status IN('Submitted','Acknowledged','In Progress','Resolved','Rejected','Reopened')),
  admin_note TEXT, rejection_reason TEXT, idem_key TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT,
  UNIQUE(user_id, idem_key));
CREATE INDEX IF NOT EXISTS ix_c_user ON complaints(user_id);
CREATE INDEX IF NOT EXISTS ix_c_status ON complaints(status);
CREATE INDEX IF NOT EXISTS ix_c_dept ON complaints(department_id);
CREATE TABLE IF NOT EXISTS status_history(
  id INTEGER PRIMARY KEY, complaint_id INTEGER NOT NULL REFERENCES complaints(id),
  prev_status TEXT, new_status TEXT NOT NULL, changed_by INTEGER NOT NULL REFERENCES users(id),
  notes TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY, complaint_id INTEGER NOT NULL REFERENCES complaints(id),
  author_id INTEGER NOT NULL REFERENCES users(id), message TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attachments(
  id INTEGER PRIMARY KEY, complaint_id INTEGER NOT NULL REFERENCES complaints(id),
  original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  complaint_id INTEGER REFERENCES complaints(id), message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_n_user ON notifications(user_id, is_read);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id TEXT,
  detail TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY, value INTEGER NOT NULL);
`);
  const depts = ['IT Department','Maintenance Department','Housekeeping Department','Transport Department',
    'Hostel Administration','Library Administration','Security Office','General Administration'];
  const ins = db.prepare('INSERT OR IGNORE INTO departments(name) VALUES(?)');
  depts.forEach(d => ins.run(d));
  const map = {
    'Wi-Fi/Internet':'IT Department','Infrastructure':'Maintenance Department',
    'Cleanliness':'Housekeeping Department','Housekeeping':'Housekeeping Department',
    'Transport':'Transport Department','Hostel':'Hostel Administration',
    'Classroom/Lab Equipment':'Maintenance Department','Library':'Library Administration',
    'Security/Safety':'Security Office','Water/Washroom':'Maintenance Department','Other':'General Administration'};
  const m = db.prepare('INSERT OR IGNORE INTO category_map(category,department_id) SELECT ?, id FROM departments WHERE name=?');
  Object.entries(map).forEach(([c, d]) => m.run(c, d));
  return db;
}
module.exports = { open };
