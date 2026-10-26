// Dragomir Client social features: who plays with Dragomir (badges, capes), friends and online status.
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
    await update({
      [`presence/${me.u}`]: { at: now(), server, hidden: !!body.hidden },
      [`users/${me.u}/lastSeen`]: now(),
      [`users/${me.u}/cape`]: !!body.cape,
      [`users/${me.u}/badge`]: body.badge !== false
    });
    return friendState(me.u);
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
      if (r) users[id] = { badge: r.badge !== false, cape: !!r.cape };
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

  // Admins see everyone online, including players who chose "Appear offline" (the client tells players this).
  async function admin(me, body) {
    if (!isAdmin(me.u)) throw new HttpError(403, 'Admins only');
    const op = String(body.op || '');
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
      const me = verify(body.token);
      let result;
      if (action === 'heartbeat') result = await heartbeat(me, body);
      else if (action === 'cosmetics') result = await cosmetics(me, body);
      else if (action === 'friend') result = await friend(me, body);
      else if (action === 'admin') result = await admin(me, body);
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
