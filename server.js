'use strict';
/* MINICRAFT SURVIVAL - Máy chủ online beta 1.0.1
   Tài khoản (tên + mật khẩu + email), xác nhận email, quên mật khẩu qua Brevo,
   lưu dữ liệu vào MongoDB Atlas (khuyên dùng cho Render free) hoặc file JSON (chạy thử). */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
let WebSocketServer;
try { ({ WebSocketServer } = require('ws')); } catch (e) { console.error('Thiếu thư viện ws. Chạy: npm install'); process.exit(1); }

const VERSION = '1.0.1-beta', PORT = +process.env.PORT || 8080, MAXP = +process.env.MAX_PLAYERS || 50;
const BREVO_KEY = process.env.BREVO_API_KEY || '', MAIL_FROM = process.env.MAIL_FROM || '', MAIL_NAME = process.env.MAIL_FROM_NAME || 'MINICRAFT SURVIVAL';
const REQUIRE_VERIFY = BREVO_KEY ? process.env.REQUIRE_VERIFY !== '0' : process.env.REQUIRE_VERIFY === '1';

// ---------------- chống hack ----------------
const AC = {
  MAX_SPEED: 12, MAX_RISE: 14, TELEPORT: 80, EDIT_REACH: 9.5, EDIT_RATE: 14,
  EXPL_REACH: 150, EXPL_MAX: 600, EXPL_PER_10S: 3, POS_RATE: 25, CHAT_PER_6S: 4, CHAT_LEN: 120,
  SAVE_MIN_GAP: 4, KICK_AT: 10, BAN_STRIKES: 3, BAN_MS: 10 * 60 * 1000, MAX_PAYLOAD: 200 * 1024, MAX_PER_IP: 5,
  UPG_CAP: 0.25, UPG_STEP: 0.01
};

// ---------------- lưu trữ ----------------
class FileStore {
  constructor(dir) { this.dir = dir; this.pdir = path.join(dir, 'players'); fs.mkdirSync(this.pdir, { recursive: true }); this.kind = 'file'; }
  async init() { }
  w(file, obj) { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, file); }
  async getPlayer(n) { try { return JSON.parse(fs.readFileSync(path.join(this.pdir, n.toLowerCase() + '.json'), 'utf8')); } catch (e) { return null; } }
  async putPlayer(r) { this.w(path.join(this.pdir, r.name.toLowerCase() + '.json'), r); }
  async findByEmail(e) { for (const f of fs.readdirSync(this.pdir)) { if (!f.endsWith('.json')) continue; try { const r = JSON.parse(fs.readFileSync(path.join(this.pdir, f), 'utf8')); if (r.emailLower === e) return r; } catch (x) { } } return null; }
  async getWorld() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'world.json'), 'utf8')); } catch (e) { return null; } }
  async putWorld(w) { this.w(path.join(this.dir, 'world.json'), w); }
}
class MongoStore {
  constructor(uri) { this.uri = uri; this.kind = 'mongo'; }
  async init() {
    const { MongoClient } = require('mongodb');
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 15000 }); await this.client.connect();
    this.db = this.client.db(process.env.MONGODB_DB || 'minicraft'); this.pl = this.db.collection('players'); this.wd = this.db.collection('world');
    try { await this.pl.createIndex({ emailLower: 1 }); } catch (e) { }
  }
  async getPlayer(n) { const d = await this.pl.findOne({ _id: n.toLowerCase() }); if (d) delete d._id; return d; }
  async putPlayer(r) { await this.pl.replaceOne({ _id: r.name.toLowerCase() }, Object.assign({ _id: r.name.toLowerCase() }, r), { upsert: true }); }
  async findByEmail(e) { const d = await this.pl.findOne({ emailLower: e }); if (d) delete d._id; return d; }
  async getWorld() { const d = await this.wd.findOne({ _id: 'world' }); if (d) delete d._id; return d; }
  async putWorld(w) { await this.wd.replaceOne({ _id: 'world' }, Object.assign({ _id: 'world' }, w), { upsert: true }); }
}
const store = process.env.MONGODB_URI ? new MongoStore(process.env.MONGODB_URI) : new FileStore(process.env.DATA_DIR || path.join(__dirname, 'data'));
let world = { seed: +process.env.SEED || Math.round(Math.random() * 1e6) / 1000, edits: {} }, worldDirty = false;
const cache = new Map(), dirty = new Set();
async function getRec(name) { const k = name.toLowerCase(); if (cache.has(k)) return cache.get(k); const r = await store.getPlayer(name); if (r) cache.set(k, r); return r; }
function touch(r) { cache.set(r.name.toLowerCase(), r); dirty.add(r.name.toLowerCase()); }
async function flush() {
  for (const k of [...dirty]) { dirty.delete(k); const r = cache.get(k); if (r) { try { await store.putPlayer(r); } catch (e) { console.error('lưu người chơi lỗi', e.message); dirty.add(k); } } }
  if (worldDirty) { worldDirty = false; try { await store.putWorld(world); } catch (e) { console.error('lưu thế giới lỗi', e.message); worldDirty = true; } }
}
const putNow = async r => { touch(r); await flush(); };

// ---------------- tiện ích ----------------
const nameOk = n => typeof n === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(n);
const emailOk = e => typeof e === 'string' && e.length <= 100 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const passOk = p => typeof p === 'string' && p.length >= 6 && p.length <= 64;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const scrypt = (p, salt) => new Promise((res, rej) => crypto.scrypt(p, salt, 64, (e, k) => e ? rej(e) : res(k.toString('hex'))));
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
async function setPassword(rec, pass) { rec.salt = crypto.randomBytes(16).toString('hex'); rec.hash = await scrypt(pass, rec.salt); }
const code6 = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
async function sendMail(to, subject, html) {
  if (!BREVO_KEY || !MAIL_FROM) { console.log('[MAIL thử nghiệm - chưa cấu hình Brevo]', to, subject, html.replace(/<[^>]+>/g, ' ').slice(0, 160)); return false; }
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': BREVO_KEY, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ sender: { name: MAIL_NAME, email: MAIL_FROM }, to: [{ email: to }], subject, htmlContent: html }) });
    if (!r.ok) { console.error('Brevo lỗi', r.status, (await r.text()).slice(0, 200)); return false; } return true;
  } catch (e) { console.error('Brevo lỗi', e.message); return false; }
}
const mailBody = (title, code) => '<div style="font-family:Arial,sans-serif"><h2>MINICRAFT SURVIVAL</h2><p>' + title + '</p><p style="font-size:28px;letter-spacing:6px"><b>' + code + '</b></p><p>Mã có hiệu lực 15 phút. Nếu không phải bạn yêu cầu, hãy bỏ qua email này.</p></div>';

const bans = new Map(), strikes = new Map(), online = new Map(), byName = new Map(), ipCount = new Map(), ipTry = new Map();
let nextId = 1;
const send = (c, o) => { try { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); } catch (e) { } };
const bcast = (o, except) => { const s = JSON.stringify(o); for (const c of online.values()) if (c !== except) { try { if (c.ws.readyState === 1) c.ws.send(s); } catch (e) { } } };
function log(c, what, extra) { console.log(new Date().toISOString() + ' [AC] ' + (c ? c.name : '-') + ' ' + what + (extra ? ' ' + extra : '')); }
function allow(c, key, max, perMs) { const now = Date.now(), a = c.rl[key] || (c.rl[key] = []); while (a.length && now - a[0] > perMs) a.shift(); if (a.length >= max) return false; a.push(now); return true; }
function allowKey(map, key, max, perMs) { const now = Date.now(), a = (map.get(key) || []).filter(t => now - t < perMs); if (a.length >= max) { map.set(key, a); return false; } a.push(now); map.set(key, a); return true; }
function violate(c, why, w) {
  c.vl += w; log(c, why, 'vl=' + c.vl.toFixed(1));
  if (c.vl >= AC.KICK_AT) {
    const key = c.name.toLowerCase(), now = Date.now(), s = (strikes.get(key) || []).filter(t => now - t < 30 * 60 * 1000); s.push(now); strikes.set(key, s);
    if (s.length >= AC.BAN_STRIKES) { bans.set(key, now + AC.BAN_MS); log(c, 'BAN', why); }
    kick(c, 'Phát hiện gian lận (' + why + ')');
  }
}
function kick(c, reason) { send(c, { t: 'kick', reason }); try { c.ws.close(); } catch (e) { } }

// ---------------- kiểm tra dữ liệu lưu ----------------
const fin = v => typeof v === 'number' && isFinite(v);
function validateSnap(prev, s, dt) {
  if (!s || typeof s !== 'object') return 'snap';
  for (const k of ['hp', 'maxhp', 'xp', 'lvl', 'food', 'arrows', 'bullets', 'rockets', 'atkM', 'movM', 'dmgM']) if (!fin(s[k])) return 'field ' + k;
  if (!Array.isArray(s.pos) || s.pos.length !== 3 || !s.pos.every(fin) || s.pos.some(v => Math.abs(v) > 1e6)) return 'pos';
  if (s.lvl < 1 || s.lvl > 500) return 'lvl';
  if (s.maxhp > 20 + 2 * (s.lvl - 1) + 2 || s.hp > s.maxhp + 1) return 'hp';
  if (s.food < 0 || s.food > 20) return 'food';
  let up = 0; for (const k of ['atkM', 'movM', 'dmgM']) { if (s[k] < 1 || s[k] > 1 + AC.UPG_CAP + 1e-6) return 'mult-cap'; up += s[k] - 1; }
  if (up > AC.UPG_STEP * Math.max(0, s.lvl - 1) + 0.012) return 'mult-level';
  if (!s.inv || typeof s.inv !== 'object' || !Array.isArray(s.own) || !Array.isArray(s.IT) || !Array.isArray(s.eq) || !Array.isArray(s.fd)) return 'shape';
  if (s.own.length > 200 || s.IT.length > 9 || s.eq.length > 4 || s.fd.length > 8) return 'len';
  if (!s.own.every(fin) || !s.IT.every(fin) || !s.eq.every(fin)) return 'ids';
  const cap = Math.max(80, dt * 12);
  for (const b in s.inv) { const n = s.inv[b], id = +b; if (!(id >= 2 && id < 256) || !fin(n) || n < 0 || n > 9999) return 'inv'; const old = prev && prev.inv ? (prev.inv[b] || 0) : 0; if (prev && n - old > cap) return 'item-gain ' + b + '+' + (n - old); }
  if (prev) {
    if (s.lvl - prev.lvl > 3 + dt / 10) return 'lvl-jump';
    if (s.own.length - (prev.own || []).length > 6 + dt / 30) return 'tool-gain';
    for (const k of ['arrows', 'bullets', 'rockets']) if (s[k] - (prev[k] || 0) > Math.max(250, dt * 25)) return k + '-gain';
    const pd = Math.hypot(s.pos[0] - (prev.pos ? prev.pos[0] : s.pos[0]), s.pos[2] - (prev.pos ? prev.pos[2] : s.pos[2]));
    if (pd > AC.MAX_SPEED * Math.max(dt, 1) + 60) return 'pos-jump';
  }
  return null;
}

// ---------------- NPC ----------------
const ROLES = ['merchant', 'smith', 'villager', 'villager', 'guard', 'villager'];
const npcs = ROLES.map((role, i) => ({ id: 's' + (i + 1), role, x: 180 + Math.random() * 40, z: 180 + Math.random() * 40, tx: 200, tz: 200, t: 0 }));
setInterval(() => { for (const n of npcs) { n.t -= 0.2; if (n.t <= 0) { n.t = 3 + Math.random() * 5; n.tx = 130 + Math.random() * 140; n.tz = 130 + Math.random() * 140; } const dx = n.tx - n.x, dz = n.tz - n.z, d = Math.hypot(dx, dz); if (d > 0.5) { n.x += dx / d * 0.28; n.z += dz / d * 0.28; } } }, 200);
const npcList = () => npcs.map(n => ({ id: n.id, role: n.role, x: +n.x.toFixed(2), z: +n.z.toFixed(2) }));
setInterval(() => { if (online.size) bcast({ t: 'npc', list: npcList() }); }, 1000);

// ---------------- bạn bè ----------------
async function friendInfo(rec) { const out = []; for (const n of (rec.friends || [])) { const r = await getRec(n); out.push({ name: r ? r.name : n, on: byName.has(n.toLowerCase()) }); } return out; }
async function reqNames(rec) { const out = []; for (const n of (rec.pending || [])) { const r = await getRec(n); out.push(r ? r.name : n); } return out; }
async function pushFriends(c) { send(c, { t: 'fr', friends: await friendInfo(c.rec), req: await reqNames(c.rec) }); }
async function handleFriend(c, m) {
  if (!allow(c, 'fr', 10, 10000) || !nameOk(m.name)) return;
  const me = c.rec, key = m.name.toLowerCase(), mk = me.name.toLowerCase(); if (key === mk) return;
  const other = await getRec(m.name); if (!other) return send(c, { t: 'sys', text: 'Không tìm thấy người chơi ' + m.name });
  me.friends = me.friends || []; me.pending = me.pending || []; other.friends = other.friends || []; other.pending = other.pending || [];
  if (m.op === 'add') {
    if (me.friends.includes(key)) return;
    if (me.pending.includes(key)) { me.pending = me.pending.filter(x => x !== key); me.friends.push(key); other.friends.push(mk); send(c, { t: 'sys', text: 'Bạn và ' + other.name + ' đã là bạn bè' }); }
    else if (!other.pending.includes(mk)) { other.pending.push(mk); send(c, { t: 'sys', text: 'Đã gửi lời mời tới ' + other.name }); }
  } else if (m.op === 'accept') {
    if (!me.pending.includes(key)) return; me.pending = me.pending.filter(x => x !== key); if (!me.friends.includes(key)) me.friends.push(key); if (!other.friends.includes(mk)) other.friends.push(mk);
  } else if (m.op === 'remove') { me.friends = me.friends.filter(x => x !== key); other.friends = other.friends.filter(x => x !== mk); } else return;
  touch(me); touch(other); await pushFriends(c);
  const oc = byName.get(key); if (oc) { await pushFriends(oc); if (m.op === 'add') send(oc, { t: 'sys', text: me.name + ' muốn kết bạn với bạn' }); }
}

// ---------------- đăng nhập / đăng ký ----------------
const res = (c, ok, msg, extra) => send(c, Object.assign({ t: 'authres', ok, msg }, extra || {}));
async function join(c, rec, sessToken) {
  const key = rec.name.toLowerCase(), old = byName.get(key);
  if (old && old !== c) kick(old, 'Tài khoản đăng nhập ở nơi khác');
  if (online.size >= MAXP && !old) return res(c, false, 'Máy chủ đầy', { stage: 'login' });
  if ((bans.get(key) || 0) > Date.now()) return res(c, false, 'Tài khoản đang bị cấm tạm thời', { stage: 'login' });
  rec.lastSeen = Date.now(); touch(rec);
  c.rec = rec; c.name = rec.name; c.id = 'p' + (nextId++); c.joined = Date.now(); c.grace = Date.now() + 6000; c.pos = null; online.set(c.id, c); byName.set(key, c);
  const all = Object.entries(world.edits), conv = ([k, v]) => { const a = k.split(',').map(Number); return [a[0], a[1], a[2], v]; };
  send(c, { t: 'authres', ok: true, stage: 'ok', msg: 'Đăng nhập thành công', name: rec.name, sess: sessToken || undefined });
  send(c, { t: 'welcome', id: c.id, seed: world.seed, snap: rec.snap, edits: all.slice(0, 8000).map(conv), friends: await friendInfo(rec), req: await reqNames(rec), npcs: npcList(), ver: VERSION });
  for (let i = 8000; i < all.length; i += 4000) send(c, { t: 'edits', list: all.slice(i, i + 4000).map(conv) });
  bcast({ t: 'sys', text: rec.name + ' đã vào server' }, c);
  for (const f of (rec.friends || [])) { const fc = byName.get(f); if (fc) pushFriends(fc); }
  console.log('join', c.name);
}
async function newSession(rec) { const tok = crypto.randomBytes(24).toString('hex'); rec.sess = (rec.sess || []).filter(s => s.exp > Date.now()).slice(-4); rec.sess.push({ h: sha(tok), exp: Date.now() + 30 * 24 * 3600 * 1000 }); await putNow(rec); return tok; }
async function onAuth(c, m) {
  if (c.rec) return;
  if (!allow(c, 'auth', 10, 60000)) return res(c, false, 'Thao tác quá nhanh, thử lại sau');
  const op = m.op;
  try {
    if (op === 'register') {
      if (!nameOk(m.name)) return res(c, false, 'Tên chỉ gồm chữ, số, dấu _ (3-16 ký tự)', { stage: 'reg' });
      if (!emailOk(m.email)) return res(c, false, 'Email không hợp lệ', { stage: 'reg' });
      if (!passOk(m.pass)) return res(c, false, 'Mật khẩu từ 6 đến 64 ký tự', { stage: 'reg' });
      if (!allowKey(ipTry, 'reg:' + c.ip, 5, 3600 * 1000)) return res(c, false, 'Bạn tạo tài khoản quá nhiều, thử lại sau', { stage: 'reg' });
      if (await getRec(m.name)) return res(c, false, 'Tên này đã có người dùng', { stage: 'reg' });
      const el = m.email.toLowerCase();
      if (await store.findByEmail(el)) return res(c, false, 'Email này đã được dùng', { stage: 'reg' });
      const rec = { name: m.name, email: m.email, emailLower: el, verified: !REQUIRE_VERIFY, snap: null, friends: [], pending: [], created: Date.now(), sess: [] };
      await setPassword(rec, m.pass);
      if (REQUIRE_VERIFY) {
        const code = code6(); rec.vcode = { h: sha(code), exp: Date.now() + 15 * 60 * 1000, tries: 0 }; await putNow(rec);
        const ok = await sendMail(m.email, 'Mã xác nhận MINICRAFT SURVIVAL', mailBody('Mã xác nhận email của bạn:', code));
        return res(c, true, ok ? 'Đã gửi mã xác nhận tới email của bạn' : 'Không gửi được email, thử lại sau', { stage: ok ? 'verify' : 'reg', name: rec.name });
      }
      await putNow(rec); const tok = await newSession(rec); return join(c, rec, tok);
    }
    if (op === 'verify') {
      if (!nameOk(m.name)) return res(c, false, 'Tên không hợp lệ', { stage: 'verify' });
      const rec = await getRec(m.name); if (!rec || rec.verified || !rec.vcode) return res(c, false, 'Không có yêu cầu xác nhận', { stage: 'login' });
      if (rec.vcode.exp < Date.now() || rec.vcode.tries >= 5) return res(c, false, 'Mã hết hạn hoặc nhập sai quá nhiều lần. Hãy đăng ký lại sau ít phút', { stage: 'reg' });
      rec.vcode.tries++; touch(rec);
      if (!safeEq(sha(String(m.code || '').trim()), rec.vcode.h)) return res(c, false, 'Mã không đúng', { stage: 'verify', name: rec.name });
      rec.verified = true; delete rec.vcode; await putNow(rec); const tok = await newSession(rec); return join(c, rec, tok);
    }
    if (op === 'login') {
      if (!nameOk(m.name) || !passOk(m.pass)) return res(c, false, 'Sai tên hoặc mật khẩu', { stage: 'login' });
      if (!allowKey(ipTry, 'login:' + c.ip + ':' + m.name.toLowerCase(), 8, 10 * 60 * 1000)) return res(c, false, 'Sai quá nhiều lần, thử lại sau 10 phút', { stage: 'login' });
      const rec = await getRec(m.name);
      if (!rec || !rec.hash || !safeEq(await scrypt(m.pass, rec.salt), rec.hash)) return res(c, false, 'Sai tên hoặc mật khẩu', { stage: 'login' });
      if (!rec.verified) return res(c, false, 'Tài khoản chưa xác nhận email', { stage: 'login' });
      const tok = await newSession(rec); return join(c, rec, tok);
    }
    if (op === 'resume') {
      if (!nameOk(m.name) || typeof m.sess !== 'string' || m.sess.length > 80) return res(c, false, 'Phiên không hợp lệ, hãy đăng nhập', { stage: 'login' });
      const rec = await getRec(m.name); const h = sha(m.sess);
      if (!rec || !rec.verified || !(rec.sess || []).some(s => s.exp > Date.now() && safeEq(s.h, h))) return res(c, false, 'Phiên hết hạn, hãy đăng nhập lại', { stage: 'login' });
      return join(c, rec, null);
    }
    if (op === 'forgot') {
      const who = String(m.who || '').trim().slice(0, 100);
      if (!who) return res(c, false, 'Nhập tên tài khoản hoặc email', { stage: 'forgot' });
      if (!allowKey(ipTry, 'forgot:' + c.ip, 4, 3600 * 1000)) return res(c, false, 'Bạn yêu cầu quá nhiều, thử lại sau', { stage: 'forgot' });
      const rec = emailOk(who) ? await store.findByEmail(who.toLowerCase()) : (nameOk(who) ? await getRec(who) : null);
      if (rec && rec.verified && allowKey(ipTry, 'forgotacc:' + rec.name.toLowerCase(), 3, 3600 * 1000)) {
        const code = code6(); rec.reset = { h: sha(code), exp: Date.now() + 15 * 60 * 1000, tries: 0 }; cache.set(rec.name.toLowerCase(), rec); await putNow(rec);
        await sendMail(rec.email, 'Mã đặt lại mật khẩu MINICRAFT SURVIVAL', mailBody('Mã đặt lại mật khẩu của tài khoản <b>' + rec.name + '</b>:', code));
      }
      return res(c, true, 'Nếu tài khoản tồn tại, mã đã được gửi tới email đã đăng ký', { stage: 'reset', name: rec ? rec.name : who });
    }
    if (op === 'reset') {
      if (!passOk(m.pass)) return res(c, false, 'Mật khẩu mới từ 6 đến 64 ký tự', { stage: 'reset', name: m.name });
      const rec = nameOk(m.name) ? await getRec(m.name) : null;
      if (!rec || !rec.reset || rec.reset.exp < Date.now() || rec.reset.tries >= 5) return res(c, false, 'Mã hết hạn hoặc không hợp lệ. Hãy yêu cầu mã mới', { stage: 'forgot' });
      rec.reset.tries++; touch(rec);
      if (!safeEq(sha(String(m.code || '').trim()), rec.reset.h)) return res(c, false, 'Mã không đúng', { stage: 'reset', name: rec.name });
      await setPassword(rec, m.pass); delete rec.reset; rec.sess = []; await putNow(rec);
      const oc = byName.get(rec.name.toLowerCase()); if (oc) kick(oc, 'Mật khẩu đã được đổi');
      return res(c, true, 'Đã đổi mật khẩu. Hãy đăng nhập', { stage: 'login', name: rec.name });
    }
  } catch (e) { console.error('auth error', e.message); res(c, false, 'Lỗi máy chủ, thử lại sau'); }
}

// ---------------- xử lý gói tin trong game ----------------
const intp = Number.isInteger;
function onPos(c, m) {
  if (!c.rec) return;
  if (!allow(c, 'pos', AC.POS_RATE, 1000)) return violate(c, 'pos-flood', 1);
  if (![m.x, m.y, m.z].every(fin)) return violate(c, 'pos-nan', 5);
  const now = Date.now();
  if (m.y < -20 || m.y > 220 || Math.abs(m.x) > 1e6 || Math.abs(m.z) > 1e6) return violate(c, 'pos-range', 5);
  if (!c.pos) c.pos = { x: m.x, y: m.y, z: m.z, t: now };
  else {
    const dt = Math.min(Math.max((now - c.pos.t) / 1000, 0.02), 3), dx = m.x - c.pos.x, dz = m.z - c.pos.z, dy = m.y - c.pos.y, h = Math.hypot(dx, dz);
    if (now > c.grace) {
      if (h > AC.TELEPORT && dt < 3) { violate(c, 'teleport ' + h.toFixed(0), 5); return send(c, { t: 'tp', x: c.pos.x, y: c.pos.y, z: c.pos.z }); }
      if (h > AC.MAX_SPEED * dt + 1.5) { violate(c, 'speed ' + (h / dt).toFixed(1) + 'u/s', 2); return send(c, { t: 'tp', x: c.pos.x, y: c.pos.y, z: c.pos.z }); }
      if (dy > AC.MAX_RISE * dt + 2) { violate(c, 'fly ' + (dy / dt).toFixed(1) + 'u/s', 2); return send(c, { t: 'tp', x: c.pos.x, y: c.pos.y, z: c.pos.z }); }
    }
    c.pos = { x: m.x, y: m.y, z: m.z, t: now };
  }
  c.yaw = fin(m.yaw) ? m.yaw : 0; c.hp = fin(m.hp) ? m.hp : 20;
}
function onEdit(c, m) {
  if (!c.rec || !c.pos) return;
  if (!allow(c, 'edit', AC.EDIT_RATE, 1000)) return violate(c, 'edit-flood', 2);
  if (!intp(m.x) || !intp(m.y) || !intp(m.z) || !intp(m.id) || m.id < 0 || m.id > 255 || m.y < 1 || m.y > 127 || Math.abs(m.x) > 1e6 || Math.abs(m.z) > 1e6) return violate(c, 'edit-bad', 3);
  if (Math.hypot(m.x + .5 - c.pos.x, m.y + .5 - c.pos.y, m.z + .5 - c.pos.z) > AC.EDIT_REACH + 2) return violate(c, 'reach', 2);
  if (m.id === 9 || m.id === 15) return violate(c, 'edit-liquid', 2);
  world.edits[m.x + ',' + m.y + ',' + m.z] = m.id; worldDirty = true;
  bcast({ t: 'edit', x: m.x, y: m.y, z: m.z, id: m.id }, c);
}
function onEdits(c, m) {
  if (!c.rec || !c.pos || !m.ex || !Array.isArray(m.list)) return;
  if (!allow(c, 'expl', AC.EXPL_PER_10S, 10000)) return violate(c, 'explosion-flood', 3);
  if (m.list.length > AC.EXPL_MAX || ![m.cx, m.cy, m.cz].every(fin)) return violate(c, 'explosion-bad', 4);
  if (Math.hypot(m.cx - c.pos.x, m.cy - c.pos.y, m.cz - c.pos.z) > AC.EXPL_REACH) return violate(c, 'explosion-reach', 3);
  for (const e of m.list) {
    if (!Array.isArray(e) || e.length !== 4 || !e.every(intp) || e[3] !== 0 || e[1] < 1 || e[1] > 127) return violate(c, 'explosion-cell', 4);
    if (Math.hypot(e[0] - m.cx, e[1] - m.cy, e[2] - m.cz) > 9) return violate(c, 'explosion-radius', 4);
  }
  for (const e of m.list) world.edits[e[0] + ',' + e[1] + ',' + e[2]] = 0; worldDirty = true;
  bcast({ t: 'edits', list: m.list }, c);
}
function onChat(c, m) {
  if (!c.rec) return;
  if (!allow(c, 'chat', AC.CHAT_PER_6S, 6000)) return send(c, { t: 'sys', text: 'Bạn nhắn quá nhanh' });
  const text = String(m.text || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, AC.CHAT_LEN); if (!text) return;
  const w = /^@([A-Za-z0-9_]{3,16})\s+(.+)$/.exec(text);
  if (w) { const t = byName.get(w[1].toLowerCase()); if (!t) return send(c, { t: 'sys', text: w[1] + ' không online' }); send(t, { t: 'chat', from: c.name + ' (riêng)', text: w[2] }); return send(c, { t: 'chat', from: 'Bạn -> ' + t.name, text: w[2] }); }
  bcast({ t: 'chat', from: c.name, text });
}
function onSave(c, m) {
  if (!c.rec) return;
  const now = Date.now(); if (c.lastSave && now - c.lastSave < AC.SAVE_MIN_GAP * 1000) return;
  const dt = c.lastSave ? (now - c.lastSave) / 1000 : (now - c.joined) / 1000;
  const err = validateSnap(c.rec.snap, m.snap, dt);
  if (err) return violate(c, 'save:' + err, 4);
  c.lastSave = now; c.rec.snap = m.snap; touch(c.rec);
}
async function onMessage(c, raw) {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
  let m; try { m = JSON.parse(raw.toString()); } catch (e) { return violate(c, 'json', 1); }
  if (!m || typeof m.t !== 'string') return;
  if (!allow(c, 'all', 120, 1000)) return violate(c, 'msg-flood', 3);
  switch (m.t) {
    case 'auth': return onAuth(c, m);
    case 'pos': return onPos(c, m);
    case 'edit': return onEdit(c, m);
    case 'edits': return onEdits(c, m);
    case 'chat': return onChat(c, m);
    case 'save': return onSave(c, m);
    case 'friend': return c.rec && handleFriend(c, m);
  }
}

// ---------------- khởi động ----------------
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, version: VERSION, players: online.size, storage: store.kind, mail: !!BREVO_KEY })); }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('MINICRAFT SURVIVAL server ' + VERSION + '\nNgười chơi online: ' + online.size + '\n');
});
const wss = new WebSocketServer({ server, maxPayload: AC.MAX_PAYLOAD });
wss.on('connection', (ws, req) => {
  const ip = String((req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '?')).split(',')[0].trim();
  if ((ipCount.get(ip) || 0) >= AC.MAX_PER_IP) { ws.close(); return; }
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  const c = { ws, ip, rec: null, name: '?', vl: 0, rl: {}, alive: Date.now() };
  ws.on('pong', () => { c.alive = Date.now(); });
  ws.on('message', raw => { c.alive = Date.now(); Promise.resolve().then(() => onMessage(c, raw)).catch(e => console.error('msg error', e.message)); });
  ws.on('close', () => {
    ipCount.set(ip, Math.max(0, (ipCount.get(ip) || 1) - 1));
    if (c.rec && online.get(c.id) === c) { online.delete(c.id); if (byName.get(c.name.toLowerCase()) === c) byName.delete(c.name.toLowerCase()); c.rec.lastSeen = Date.now(); touch(c.rec); bcast({ t: 'sys', text: c.name + ' đã thoát' }); for (const f of (c.rec.friends || [])) { const fc = byName.get(f); if (fc) pushFriends(fc); } console.log('leave', c.name); }
  });
});
setInterval(() => { const list = []; for (const c of online.values()) if (c.pos) list.push({ id: c.id, name: c.name, x: +c.pos.x.toFixed(2), y: +c.pos.y.toFixed(2), z: +c.pos.z.toFixed(2), yaw: +(c.yaw || 0).toFixed(2), hp: c.hp }); if (list.length) bcast({ t: 'pl', list }); }, 100);
setInterval(() => { const now = Date.now(); for (const c of online.values()) { c.vl = Math.max(0, c.vl - 1); } for (const w of wss.clients || []) { try { w.ping(); } catch (e) { } } for (const [k, v] of bans) if (v < now) bans.delete(k); for (const c of online.values()) if (now - c.alive > 60000) { try { c.ws.terminate(); } catch (e) { } } }, 20000);
setInterval(flush, 4000);
async function shutdown() { console.log('Đang lưu dữ liệu...'); try { for (const c of online.values()) if (c.rec) touch(c.rec); worldDirty = true; await flush(); } catch (e) { } process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
async function main() {
  await store.init();
  const w = await store.getWorld(); if (w && w.seed != null) world = Object.assign(world, w); else { worldDirty = true; await flush(); }
  server.listen(PORT, () => console.log('MINICRAFT SURVIVAL server ' + VERSION + ' cổng ' + PORT + ' | lưu trữ: ' + store.kind + ' | email: ' + (BREVO_KEY ? 'Brevo' : 'CHƯA cấu hình (chỉ in mã ra log)') + ' | xác nhận email: ' + REQUIRE_VERIFY + ' | seed ' + world.seed));
}
main().catch(e => { console.error('Không khởi động được:', e.message); process.exit(1); });
module.exports = { validateSnap, AC };
