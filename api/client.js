// Dragomir Client social features: who plays with Dragomir (badges, capes), friends, online status,
// messages between friends, and the admin view (in game for DRAGOMIR_ADMINS, and the website's /client-admin page).
//
// Players prove who they are with Mojang's session check, the same one Minecraft servers use: the game
// "joins" a random server id, and this function asks Mojang whether that player really did. The player then
// gets a short-lived token signed with DRAGOMIR_SESSION_SECRET. Their Mojang login never reaches this server.
//
// Data lives in Firebase under /client. The database rules don't open /client to anyone, so only this
// function (using a service account, which bypasses the rules) can read or write it.
//
// Environment variables (Vercel > Project > Settings > Environment Variables):
//   FIREBASE_SERVICE_ACCOUNT  the service account key JSON (Firebase console > Project settings > Service accounts)
//   DRAGOMIR_SESSION_SECRET   a long random string used to sign tokens
//   DRAGOMIR_ADMINS           comma-separated Minecraft UUIDs allowed to use the admin commands
//   FIREBASE_DB_URL           optional; defaults to the admin-dragomir database

const crypto = require('crypto');

const DEFAULT_DB_URL = 'https://admin-dragomir-default-rtdb.europe-west1.firebasedatabase.app';
const TOKEN_HOURS = 12;
const ONLINE_MS = 150 * 1000;   // a heartbeat comes every 60 s, so 2.5 min without one means offline
const MAX_FRIENDS = 200;
const MAX_LOOKUP = 100;
const PLAYING_CACHE_MS = 30 * 1000;
const MAX_MESSAGE = 256;
const MAX_INBOX = 100;
const MESSAGES_PER_MINUTE = 20;
const ADMIN_WEB_HOURS = 1;
const ADMIN_MAX_FAILS = 10;
const ADMIN_LOCK_MS = 15 * 60 * 1000;
// Cape styles a player can pick (textures ship with the client).
const CAPES = ['classic', 'crimson', 'ocean', 'emerald', 'gold', 'void'];

const UUID_RE = /^[0-9a-f]{32}$/;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const SERVER_ID_RE = /^[0-9a-f]{16,64}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- helpers

function normUuid(value) {
  const id = String(value || '').toLowerCase().replace(/-/g, '');
  if (!UUID_RE.test(id)) throw new HttpError(400, 'Bad player id');
  return id;
}

function checkName(value) {
  const name = String(value || '');
  if (!NAME_RE.test(name)) throw new HttpError(400, 'Bad player name');
  return name;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function createHandler(deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const now = deps.now || (() => Date.now());
  const env = deps.env || process.env;

  // ------------------------------------------------------------ tokens for players

  function sign(payload) {
    const body = b64url(JSON.stringify(payload));
    const mac = b64url(crypto.createHmac('sha256', env.DRAGOMIR_SESSION_SECRET).update(body).digest());
    return `${body}.${mac}`;
  }

  function verify(token) {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) throw new HttpError(401, 'Sign in again');
    const expected = b64url(crypto.createHmac('sha256', env.DRAGOMIR_SESSION_SECRET).update(body).digest());
    const a = Buffer.from(mac), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Sign in again');
    const payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
    if (!payload.exp || payload.exp < now()) throw new HttpError(401, 'Sign in again');
    return payload;
  }

  function isAdmin(uuid) {
    return String(env.DRAGOMIR_ADMINS || '').split(',').map((s) => s.trim().toLowerCase().replace(/-/g, '')).includes(uuid);
  }

  // ------------------------------------------------------------ Firebase (REST, signed in as the service account)

  let googleToken = null;
  let googleUntil = 0;

  async function accessToken() {
    if (googleToken && now() < googleUntil) return googleToken;
    const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    const iat = Math.floor(now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
      aud: account.token_uri || 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600
    }));
    const signature = b64url(crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(account.private_key));
    const res = await fetchFn(account.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }).toString()
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) throw new Error(`Google sign-in failed (${res.status})`);
    googleToken = data.access_token;
    googleUntil = now() + (data.expires_in - 120) * 1000;
    return googleToken;
  }

  async function db(method, path, value) {
    const base = (env.FIREBASE_DB_URL || DEFAULT_DB_URL).replace(/\/+$/, '');
    const url = `${base}/${path}.json?access_token=${encodeURIComponent(await accessToken())}`;
    const res = await fetchFn(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: value === undefined ? undefined : JSON.stringify(value)
    });
    if (!res.ok) throw new Error(`Database ${method} ${path} failed (${res.status})`);
    return res.json();
  }

  const get = (path) => db('GET', `client/${path}`);
  // One PATCH at the root writes several places at once (all or nothing). null deletes.
  const update = (changes) => db('PATCH', 'client', changes);

  // ------------------------------------------------------------ actions

  async function auth(body) {
    const name = checkName(body.name);
    const serverId = String(body.serverId || '');
    if (!SERVER_ID_RE.test(serverId)) throw new HttpError(400, 'Bad server id');
    const url = `https://sessionserver.mojang.com/session/minecraft/hasJoined?username=${encodeURIComponent(name)}&serverId=${serverId}`;
    const res = await fetchFn(url);
    if (res.status !== 200) throw new HttpError(401, 'Mojang could not confirm your account');
    const profile = await res.json();
    const uuid = normUuid(profile.id);
    const realName = checkName(profile.name);
    const lower = realName.toLowerCase();
    await update({
      [`users/${uuid}/name`]: realName,
      [`users/${uuid}/nameLower`]: lower,
      [`users/${uuid}/lastSeen`]: now(),
      [`names/${lower}`]: uuid
    });
    return { token: sign({ u: uuid, n: realName, exp: now() + TOKEN_HOURS * 3600 * 1000 }), uuid, name: realName, admin: isAdmin(uuid) };
  }

  async function heartbeat(me, body) {
    const server = String(body.server || '').slice(0, 100);
    // 1.8+ clients send capeStyle; older ones only send cape: true/false, which means the classic cape.
    const style = body.capeStyle === undefined ? (body.cape ? 'classic' : null) : capeStyle(body.capeStyle);
    await update({
      [`presence/${me.u}`]: { at: now(), server, hidden: !!body.hidden },
      [`users/${me.u}/lastSeen`]: now(),
      [`users/${me.u}/cape`]: !!style,
      [`users/${me.u}/capeStyle`]: style,
      [`users/${me.u}/badge`]: body.badge !== false
    });
    // Only clients that can show messages ask for them (1.8+), so older clients don't swallow them unseen.
    const [state, playing, messages] = await Promise.all([friendState(me.u), playingNow(), body.wantsMessages ? takeMessages(me.u) : []]);
    return { ...state, playing, messages };
  }

  function capeStyle(value) {
    if (value === null || value === '' || value === false) return null;
    const style = String(value);
    if (!CAPES.includes(style)) throw new HttpError(400, 'Unknown cape');
    return style;
  }

  // How many Dragomir players are online right now (not counting anyone appearing offline). Cached briefly,
  // since every heartbeat asks and the answer only needs to be roughly current.
  let playingCache = null;
  let playingUntil = 0;

  async function playingNow() {
    if (playingCache !== null && now() < playingUntil) return playingCache;
    const presence = (await get('presence')) || {};
    playingCache = Object.values(presence).filter((p) => p && !p.hidden && now() - p.at < ONLINE_MS).length;
    playingUntil = now() + PLAYING_CACHE_MS;
    return playingCache;
  }

  // ------------------------------------------------------------ messages between friends

  // Keys sort in sending order: time, then a counter for messages sent in the same millisecond.
  let messageSeq = 0;
  function messageKey() {
    messageSeq = (messageSeq + 1) % 1000000;
    return `${String(now()).padStart(15, '0')}-${String(messageSeq).padStart(6, '0')}-${crypto.randomBytes(3).toString('hex')}`;
  }

  async function areFriends(a, b) {
    return (await get(`friends/${a}/${b}`)) === 'friends';
  }

  async function sendMessage(me, body) {
    const to = normUuid(body.to);
    // Printable text only: colour codes (§ + a character) removed, line breaks and control characters become spaces.
    const text = String(body.text || '').replace(/§./gs, '').replace(/[\u0000-\u001f\u007f§]/g, ' ').trim().slice(0, MAX_MESSAGE);
    if (!text) throw new HttpError(400, 'Empty message');
    if (!(await areFriends(me.u, to))) throw new HttpError(403, 'You can only message friends');

    // At most MESSAGES_PER_MINUTE per sender, so a stuck key can't flood someone's inbox.
    const window = (await get(`users/${me.u}/msgWindow`)) || { start: 0, count: 0 };
    const fresh = now() - window.start >= 60 * 1000;
    const count = fresh ? 1 : window.count + 1;
    if (count > MESSAGES_PER_MINUTE) throw new HttpError(429, 'Slow down a little');

    const inbox = (await get(`messages/${to}`)) || {};
    const changes = {
      [`users/${me.u}/msgWindow`]: { start: fresh ? now() : window.start, count },
      [`messages/${to}/${messageKey()}`]: { from: me.u, name: me.n, text, at: now() }
    };
    // Keep the inbox bounded if someone stays offline for a long time: drop the oldest.
    const keys = Object.keys(inbox).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_INBOX + 1))) changes[`messages/${to}/${key}`] = null;
    await update(changes);
    return { sent: true };
  }

  // Messages waiting for this player, oldest first. They're removed once handed over.
  async function takeMessages(uuid) {
    const inbox = (await get(`messages/${uuid}`)) || {};
    const keys = Object.keys(inbox).sort();
    if (!keys.length) return [];
    const changes = {};
    for (const key of keys) changes[`messages/${uuid}/${key}`] = null;
    await update(changes);
    return keys.map((key) => inbox[key]).filter(Boolean).map((m) => ({ from: m.from, name: m.name, text: m.text, at: m.at }));
  }

  async function friendState(uuid) {
    const links = (await get(`friends/${uuid}`)) || {};
    const ids = Object.keys(links);
    const [users, presence] = await Promise.all([
      Promise.all(ids.map((id) => get(`users/${id}/name`))),
      Promise.all(ids.map((id) => get(`presence/${id}`)))
    ]);
    const friends = [], incoming = [], outgoing = [];
    ids.forEach((id, i) => {
      const entry = { uuid: id, name: users[i] || '?' };
      if (links[id] === 'friends') {
        const p = presence[i];
        const online = !!p && !p.hidden && now() - p.at < ONLINE_MS;
        friends.push({ ...entry, online, server: online ? p.server : '' });
      } else if (links[id] === 'in') incoming.push(entry);
      else if (links[id] === 'out') outgoing.push(entry);
    });
    friends.sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    return { friends, incoming, outgoing };
  }

  // Badges and capes for the players you can see. Only says whether someone uses Dragomir, nothing else.
  async function cosmetics(me, body) {
    const ids = Array.isArray(body.uuids) ? body.uuids.slice(0, MAX_LOOKUP).map(normUuid) : [];
    const records = await Promise.all(ids.map((id) => get(`users/${id}`)));
    const users = {};
    ids.forEach((id, i) => {
      const r = records[i];
      if (r) users[id] = { badge: r.badge !== false, cape: !!r.cape, capeStyle: r.cape ? (r.capeStyle || 'classic') : null };
    });
    return { users };
  }

  async function uuidForName(name) {
    const lower = checkName(name).toLowerCase();
    const uuid = await get(`names/${lower}`);
    if (!uuid) throw new HttpError(404, `${name} hasn't used Dragomir Client yet`);
    // Names can move to another account; trust it only if that account still has the name.
    const current = await get(`users/${uuid}/nameLower`);
    if (current !== lower) throw new HttpError(404, `${name} hasn't used Dragomir Client yet`);
    return uuid;
  }

  async function friend(me, body) {
    const op = String(body.op || '');
    if (op === 'add') {
      const target = await uuidForName(body.name);
      if (target === me.u) throw new HttpError(400, "You can't add yourself");
      const mine = (await get(`friends/${me.u}`)) || {};
      if (mine[target] === 'friends') throw new HttpError(400, 'You are already friends');
      if (Object.keys(mine).length >= MAX_FRIENDS) throw new HttpError(400, 'Friends list is full');
      if (mine[target] === 'in') {
        await update({ [`friends/${me.u}/${target}`]: 'friends', [`friends/${target}/${me.u}`]: 'friends' });
      } else {
        await update({ [`friends/${me.u}/${target}`]: 'out', [`friends/${target}/${me.u}`]: 'in' });
      }
    } else if (op === 'accept') {
      const target = normUuid(body.uuid);
      if ((await get(`friends/${me.u}/${target}`)) !== 'in') throw new HttpError(400, 'No request from that player');
      await update({ [`friends/${me.u}/${target}`]: 'friends', [`friends/${target}/${me.u}`]: 'friends' });
    } else if (op === 'remove') {
      // Also declines a request or cancels one you sent.
      const target = normUuid(body.uuid);
      await update({ [`friends/${me.u}/${target}`]: null, [`friends/${target}/${me.u}`]: null });
    } else {
      throw new HttpError(400, 'Unknown friend action');
    }
    return friendState(me.u);
  }

  // ------------------------------------------------------------ admin

  // The website admin page signs in with the site's master passcode. It's checked here against the
  // PBKDF2 hash the admin page stores in /adminAuth, so the check happens on the server, not in the browser.
  async function adminLogin(body) {
    const passcode = String(body.passcode || '');
    if (!passcode || passcode.length > 200) throw new HttpError(400, 'Enter the passcode');
    const fails = (await get('adminWeb/fails')) || { start: 0, count: 0 };
    const fresh = now() - fails.start >= ADMIN_LOCK_MS;
    if (!fresh && fails.count >= ADMIN_MAX_FAILS) throw new HttpError(429, 'Too many wrong passcodes. Try again in 15 minutes.');

    const creds = await db('GET', 'adminAuth');
    if (!creds || !creds.salt || !creds.hash) throw new HttpError(503, 'The admin passcode is not set up');
    const hash = crypto.pbkdf2Sync(passcode, Buffer.from(String(creds.salt), 'hex'), 100000, 32, 'sha256').toString('hex');
    const a = Buffer.from(hash), b = Buffer.from(String(creds.hash));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await update({ 'adminWeb/fails': { start: fresh ? now() : fails.start, count: fresh ? 1 : fails.count + 1 } });
      throw new HttpError(401, 'Wrong passcode');
    }
    await update({ 'adminWeb/fails': null });
    return { token: sign({ web: true, exp: now() + ADMIN_WEB_HOURS * 3600 * 1000 }) };
  }

  // Admins see everyone online, including players who chose "Appear offline" (the client tells players this).
  // Allowed for players listed in DRAGOMIR_ADMINS, and for the website admin page after adminLogin.
  async function admin(me, body) {
    if (!(me.web || isAdmin(me.u))) throw new HttpError(403, 'Admins only');
    const op = String(body.op || '');
    if (op === 'players') {
      const [presence, users, friends] = await Promise.all([get('presence'), get('users'), get('friends')]);
      const players = Object.entries(users || {}).map(([id, u]) => {
        const p = presence && presence[id];
        const online = !!p && now() - p.at < ONLINE_MS;
        const links = (friends && friends[id]) || {};
        return {
          uuid: id, name: u.name || '?', lastSeen: u.lastSeen || 0, online, server: online ? p.server : '',
          hidden: !!(p && p.hidden), capeStyle: u.cape ? (u.capeStyle || 'classic') : null,
          friends: Object.values(links).filter((v) => v === 'friends').length
        };
      }).sort((x, y) => (y.online - x.online) || (y.lastSeen - x.lastSeen));
      return { players };
    }
    if (op === 'online') {
      const [presence, users] = await Promise.all([get('presence'), get('users')]);
      const online = Object.entries(presence || {})
        .filter(([, p]) => now() - p.at < ONLINE_MS)
        .map(([id, p]) => ({ uuid: id, name: (users && users[id] && users[id].name) || '?', server: p.server, hidden: !!p.hidden }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { online, total: Object.keys(users || {}).length };
    }
    if (op === 'whois') {
      const uuid = await uuidForName(body.name);
      const [user, p, links] = await Promise.all([get(`users/${uuid}`), get(`presence/${uuid}`), get(`friends/${uuid}`)]);
      const friends = Object.values(links || {}).filter((v) => v === 'friends').length;
      return {
        uuid, name: user.name, lastSeen: user.lastSeen || 0,
        online: !!p && now() - p.at < ONLINE_MS, server: p ? p.server : '', hidden: !!(p && p.hidden), friends
      };
    }
    throw new HttpError(400, 'Unknown admin action');
  }

  // ------------------------------------------------------------ entry point

  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (!env.FIREBASE_SERVICE_ACCOUNT || !env.DRAGOMIR_SESSION_SECRET) {
      return res.status(503).json({ error: 'Dragomir social features are not set up on the server yet.' });
    }
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const action = String(body.action || '');
      if (action === 'auth') return res.status(200).json(await auth(body));
      if (action === 'adminLogin') return res.status(200).json(await adminLogin(body));
      const me = verify(body.token);
      let result;
      if (action === 'admin') result = await admin(me, body);
      else if (!me.u) throw new HttpError(403, 'Players only');   // admin web tokens can only do admin things
      else if (action === 'heartbeat') result = await heartbeat(me, body);
      else if (action === 'cosmetics') result = await cosmetics(me, body);
      else if (action === 'friend') result = await friend(me, body);
      else if (action === 'message') result = await sendMessage(me, body);
      else if (action === 'inbox') result = { messages: await takeMessages(me.u) };
      else throw new HttpError(400, 'Unknown action');
      return res.status(200).json(result);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error(err);
      return res.status(500).json({ error: 'Something went wrong on the server' });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
