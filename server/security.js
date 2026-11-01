'use strict';
const crypto = require('node:crypto');
const hashPassword = pw => {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};
const verifyPassword = (pw, stored) => {
  const [, s, h] = String(stored).split('$');
  if (!s || !h) return false;
  const got = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  const want = Buffer.from(h, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const token = () => crypto.randomBytes(32).toString('hex');
const strongPassword = p => typeof p === 'string' && p.length >= 8 && /[a-z]/i.test(p) && /\d/.test(p);
function limiter(max, windowMs) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    arr.push(now); hits.set(key, arr);
    return arr.length <= max;
  };
}
function sniff(buf) {
  if (buf.length > 4 && buf.slice(0, 4).toString('latin1') === '%PDF') return { mime: 'application/pdf', ext: 'pdf' };
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))) return { mime: 'image/png', ext: 'png' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  return null;
}
module.exports = { hashPassword, verifyPassword, sha, token, strongPassword, limiter, sniff };
