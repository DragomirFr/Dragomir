// Dragomir Client social features: who plays with Dragomir (badges, capes), friends, online status,
// messages between friends, parties, shared locations and pictures, profiles, cosmetic unlocks and gifts, settings
// sync, bug reports, announcements and feature flags, and the admin view (in game for DRAGOMIR_ADMINS, and the website's /client-admin page).
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
// Cape styles a player can pick (textures ship with the client). anim_* capes are animated.
const CAPES = ['classic', 'crimson', 'ocean', 'emerald', 'gold', 'void', 'aurora', 'sunset', 'cherry', 'frost',
  'founder', 'anim_rainbow', 'anim_flame', 'anim_galaxy'];
// Cosmetic extras (drawn by the client, no textures needed). Must match the lists in the client's Cosmetics class.
const HATS = ['halo', 'crown', 'horns', 'tophat', 'catears', 'bunnyears', 'pumpkin', 'santa'];
const WINGS = ['angel', 'demon', 'butterfly', 'phoenix'];
const TRAILS = ['hearts', 'flames', 'sparkles', 'notes', 'petals', 'souls', 'magic', 'snow'];
const ACCESSORIES = ['backpack', 'scarf', 'aura'];
const PETS = ['crystal', 'orb', 'bee'];
// Cosmetics that have to be unlocked (everything else is free). The client shows the same rules, but the server decides.
//   hours: total time played with Dragomir; founder: an account first seen before FOUNDER_UNTIL; month: worn only in
//   that month (0 = January). Anything can also be unlocked by a friend's gift.
const UNLOCKS = {
  'cape:founder': { founder: true },
  'cape:anim_flame': { hours: 5 },
  'cape:anim_galaxy': { hours: 20 },
  'pet:crystal': { hours: 10 },
  'pet:bee': { founder: true },
  'accessory:aura': { hours: 30 },
  'hat:pumpkin': { month: 9 },
  'hat:santa': { month: 11 }
};
const FOUNDER_UNTIL = Date.UTC(2026, 11, 1);
const GIFTS_PER_DAY = 1;
const MAX_WAYPOINT_NAME = 24;
const DIMENSION_RE = /^[a-z0-9_.-]{1,32}:[a-z0-9_/.-]{1,48}$/;
const MAX_STATUS = 40;
const MAX_BIO = 160;
const MAX_SETUP = 16 * 1024;
const MAX_SYNC = 256 * 1024;
const MAX_SHOT = 900 * 1024;          // base64 characters (about 650 KB of JPEG)
const SHOTS_PER_DAY = 20;
const SHOT_KEEP_MS = 7 * 24 * 3600 * 1000;
const MAX_PARTY = 8;
const PARTY_INVITE_MS = 10 * 60 * 1000;
const INVITE_CODE_MS = 24 * 3600 * 1000;
const MAX_SHARE_MINUTES = 120;
const MAX_BUG = 4000;
const MAX_BUG_LOG = 64 * 1024;
const BUGS_PER_HOUR = 3;
const MAX_ANNOUNCEMENT = 200;
const FLAG_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

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
    const firstSeen = await get(`users/${uuid}/firstSeen`);
    await update({
      ...(firstSeen ? {} : { [`users/${uuid}/firstSeen`]: now() }),
      [`users/${uuid}/name`]: realName,
      [`users/${uuid}/nameLower`]: lower,
      [`users/${uuid}/lastSeen`]: now(),
      [`names/${lower}`]: uuid
    });
    return { token: sign({ u: uuid, n: realName, exp: now() + TOKEN_HOURS * 3600 * 1000 }), uuid, name: realName, admin: isAdmin(uuid) };
  }

  async function heartbeat(me, body) {
    const server = String(body.server || '').slice(0, 100);
    const hidden = !!body.hidden;
    const [user, prev] = await Promise.all([get(`users/${me.u}`), get(`presence/${me.u}`)]);
    const u = user || {};
    // 1.8+ clients send capeStyle; older ones only send cape: true/false, which means the classic cape.
    // Locked cosmetics someone hasn't unlocked are quietly dropped rather than refusing the heartbeat.
    let style = body.capeStyle === undefined ? (body.cape ? 'classic' : null) : capeStyle(body.capeStyle);
    if (style && !owns(u, `cape:${style}`)) style = null;
    const changes = {
      [`presence/${me.u}/at`]: now(),
      [`presence/${me.u}/server`]: server,
      [`presence/${me.u}/hidden`]: hidden,
      [`users/${me.u}/lastSeen`]: now(),
      [`users/${me.u}/cape`]: !!style,
      [`users/${me.u}/capeStyle`]: style,
      [`users/${me.u}/badge`]: body.badge !== false
    };
    // "Last seen" for friends only moves while you're visible, so going hidden looks exactly like logging off.
    if (!hidden) changes[`presence/${me.u}/seen`] = now();
    // Time played: the gap since the last heartbeat, if it was recent (otherwise the game was closed in between).
    if (prev && prev.at && now() - prev.at < 2 * 60 * 1000) changes[`users/${me.u}/playMs`] = (u.playMs || 0) + (now() - prev.at);
    // 1.10+ clients send their cosmetic extras; older ones leave whatever was there.
    if (body.extras !== undefined) changes[`users/${me.u}/extras`] = extras(body.extras, u);
    // 1.11+: a short status, Do Not Disturb, and where you are (only sent while sharing your location).
    if (body.status !== undefined) changes[`presence/${me.u}/status`] = cleanText(body.status).slice(0, MAX_STATUS);
    if (body.dnd !== undefined) changes[`presence/${me.u}/dnd`] = !!body.dnd;
    if (body.version !== undefined) changes[`presence/${me.u}/version`] = String(body.version).slice(0, 20);
    changes[`presence/${me.u}/pos`] = position(body.pos);
    if (Array.isArray(body.mods)) {
      changes[`usage/${me.u}`] = { at: now(), version: String(body.version || '').slice(0, 20),
        mods: body.mods.slice(0, 150).map((m) => String(m).slice(0, 40)) };
    }
    await update(changes);
    // Only clients that can show messages ask for them (1.8+), so older clients don't swallow them unseen.
    const [state, playing, messages, partyNow, notice] = await Promise.all([
      friendState(me.u), playingNow(), body.wantsMessages ? takeMessages(me.u) : [], partyState(me.u, u.party), notices()
    ]);
    const after = { ...u, playMs: changes[`users/${me.u}/playMs`] || u.playMs || 0 };
    return { ...state, playing, messages, party: partyNow, ...notice,
      me: { playMs: after.playMs, unlocked: unlocked(after), gifts: Object.keys(u.gifts || {}), inviteCode: u.inviteCode || null } };
  }

  function capeStyle(value) {
    if (value === null || value === '' || value === false) return null;
    const style = String(value);
    if (!CAPES.includes(style)) throw new HttpError(400, 'Unknown cape');
    return style;
  }

  // Printable text only: colour codes (§ + a character) removed, line breaks and control characters become spaces.
  function cleanText(value) {
    return String(value || '').replace(/§./gs, '').replace(/[\u0000-\u001f\u007f§]/g, ' ').trim();
  }

  // Whether this player may wear a cosmetic ("cape:founder", "hat:santa", ...): free, unlocked by its rule, or a gift.
  function owns(user, item) {
    const rule = UNLOCKS[item];
    if (!rule) return true;
    if (user.gifts && user.gifts[item]) return true;
    if (rule.hours && (user.playMs || 0) >= rule.hours * 3600 * 1000) return true;
    if (rule.founder && user.firstSeen && user.firstSeen < FOUNDER_UNTIL) return true;
    if (rule.month !== undefined && new Date(now()).getUTCMonth() === rule.month) return true;
    return false;
  }

  function unlocked(user) {
    return Object.keys(UNLOCKS).filter((item) => owns(user, item));
  }

  function colour(value) {
    return Number.isInteger(value) && value >= 0 && value <= 0xffffff ? value : null;
  }

  function extras(value, user) {
    const v = value && typeof value === 'object' ? value : {};
    const pick = (x, list, kind) => (list.includes(String(x)) && owns(user || {}, `${kind}:${x}`) ? String(x) : null);
    return {
      hat: pick(v.hat, HATS, 'hat'), wings: pick(v.wings, WINGS, 'wings'), trail: pick(v.trail, TRAILS, 'trail'),
      accessory: pick(v.accessory, ACCESSORIES, 'accessory'), pet: pick(v.pet, PETS, 'pet'),
      color: colour(v.color), nameColor: colour(v.nameColor)
    };
  }

  // A position the client chose to share: x, y, z and a dimension. Anything else means "not sharing".
  function position(value) {
    if (!value || typeof value !== 'object') return null;
    const [x, y, z] = [value.x, value.y, value.z].map(Number);
    const dim = String(value.dim || '');
    if (![x, y, z].every(Number.isFinite) || Math.abs(x) > 3e7 || Math.abs(z) > 3e7 || Math.abs(y) > 4096 || !DIMENSION_RE.test(dim)) return null;
    return { x: Math.round(x), y: Math.round(y), z: Math.round(z), dim, at: now() };
  }
  // A waypoint attached to a message: a name, a position and a dimension, nothing else.
  function waypoint(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object') throw new HttpError(400, 'Bad waypoint');
    const name = cleanText(value.name).slice(0, MAX_WAYPOINT_NAME);
    const [x, y, z] = [value.x, value.y, value.z].map(Number);
    const dim = String(value.dim || '');
    const finite = [x, y, z].every(Number.isFinite);
    if (!name || !finite || Math.abs(x) > 30000000 || Math.abs(z) > 30000000 || Math.abs(y) > 4096 || !DIMENSION_RE.test(dim)) {
      throw new HttpError(400, 'Bad waypoint');
    }
    const color = Number.isInteger(value.color) ? value.color & 0xffffff : 0xffffff;
    return { name, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, z: Math.round(z * 10) / 10, dim, color };
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
    const text = cleanText(body.text).slice(0, MAX_MESSAGE);
    if (!text) throw new HttpError(400, 'Empty message');
    const shared = waypoint(body.waypoint);
    // To one friend, or (party: true) to everyone else in your party.
    let recipients;
    let partyId = null;
    if (body.party) {
      partyId = await get(`users/${me.u}/party`);
      const p = partyId ? await get(`parties/${partyId}`) : null;
      if (!p || !p.members || !p.members[me.u]) throw new HttpError(400, "You're not in a party");
      recipients = Object.keys(p.members).filter((id) => id !== me.u);
      if (!recipients.length) throw new HttpError(400, "There's nobody else in your party yet");
    } else {
      const to = normUuid(body.to);
      if (!(await areFriends(me.u, to))) throw new HttpError(403, 'You can only message friends');
      if (await isBlockedBy(to, me.u)) throw new HttpError(403, "You can't message that player");
      recipients = [to];
    }

    // At most MESSAGES_PER_MINUTE per sender, so a stuck key can't flood someone's inbox.
    const window = (await get(`users/${me.u}/msgWindow`)) || { start: 0, count: 0 };
    const fresh = now() - window.start >= 60 * 1000;
    const count = fresh ? 1 : window.count + 1;
    if (count > MESSAGES_PER_MINUTE) throw new HttpError(429, 'Slow down a little');

    const inboxes = await Promise.all(recipients.map((to) => get(`messages/${to}`)));
    const changes = { [`users/${me.u}/msgWindow`]: { start: fresh ? now() : window.start, count } };
    recipients.forEach((to, i) => {
      changes[`messages/${to}/${messageKey()}`] = {
        from: me.u, name: me.n, text, at: now(), ...(shared ? { waypoint: shared } : {}), ...(partyId ? { party: partyId } : {})
      };
      // Keep the inbox bounded if someone stays offline for a long time: drop the oldest.
      const keys = Object.keys(inboxes[i] || {}).sort();
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_INBOX + 1))) changes[`messages/${to}/${key}`] = null;
    });
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
    return keys.map((key) => inbox[key]).filter(Boolean).map((m) => ({ from: m.from, name: m.name, text: m.text, at: m.at, ...(m.waypoint ? { waypoint: m.waypoint } : {}),
      ...(m.party ? { party: m.party } : {}), ...(m.gift ? { gift: m.gift } : {}), ...(m.shot ? { shot: m.shot } : {}) }));
  }

  async function friendState(uuid) {
    const links = (await get(`friends/${uuid}`)) || {};
    const ids = Object.keys(links);
    const [users, presence, shares, blocks] = await Promise.all([
      Promise.all(ids.map((id) => get(`users/${id}/name`))),
      Promise.all(ids.map((id) => get(`presence/${id}`))),
      Promise.all(ids.map((id) => (links[id] === 'friends' ? get(`locshare/${id}/${uuid}`) : null))),
      get(`blocks/${uuid}`)
    ]);
    const friends = [], incoming = [], outgoing = [];
    ids.forEach((id, i) => {
      const entry = { uuid: id, name: users[i] || '?' };
      if (links[id] === 'friends') {
        const p = presence[i];
        const online = !!p && !p.hidden && now() - p.at < ONLINE_MS;
        // lastSeen only counts time spent visible (see heartbeat), so it never gives away Appear Offline.
        const f = { ...entry, online, server: online ? p.server : '', lastSeen: (p && p.seen) || 0 };
        if (online) {
          if (p.status) f.status = p.status;
          if (p.dnd) f.dnd = true;
          // Their position, only while they're sharing it with you (and it's fresh).
          if (shares[i] && shares[i] > now() && p.pos && now() - p.pos.at < ONLINE_MS) f.pos = p.pos;
        }
        friends.push(f);
      } else if (links[id] === 'in') incoming.push(entry);
      else if (links[id] === 'out') outgoing.push(entry);
    });
    friends.sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    const blockedIds = Object.keys(blocks || {});
    const blockedNames = await Promise.all(blockedIds.map((id) => get(`users/${id}/name`)));
    const sharing = (await get(`locshare/${uuid}`)) || {};
    return {
      friends, incoming, outgoing,
      blocked: blockedIds.map((id, i) => ({ uuid: id, name: blockedNames[i] || '?' })),
      // Who you're sharing your location with, and until when.
      sharing: Object.entries(sharing).filter(([, until]) => until > now()).map(([id, until]) => ({ uuid: id, until }))
    };
  }

  // ------------------------------------------------------------ parties

  async function partyState(uuid, partyId) {
    const invites = (await get(`partyInvites/${uuid}`)) || {};
    const pending = Object.entries(invites).filter(([, inv]) => inv && now() - inv.at < PARTY_INVITE_MS)
      .map(([id, inv]) => ({ party: id, from: inv.from }));
    if (!partyId) return { invites: pending };
    const party = await get(`parties/${partyId}`);
    if (!party || !party.members || !party.members[uuid]) return { invites: pending };
    const ids = Object.keys(party.members);
    const [names, presence] = await Promise.all([
      Promise.all(ids.map((id) => get(`users/${id}/name`))),
      Promise.all(ids.map((id) => get(`presence/${id}`)))
    ]);
    const members = ids.map((id, i) => {
      const p = presence[i];
      // Appear Offline counts here too: hidden members show as offline, with no position.
      const online = !!p && (!p.hidden || id === uuid) && now() - p.at < ONLINE_MS;
      const m = { uuid: id, name: names[i] || '?', online, server: online ? p.server : '' };
      if (online && p.pos && now() - p.pos.at < ONLINE_MS) m.pos = p.pos;
      return m;
    });
    return { id: partyId, leader: party.leader, members, invites: pending };
  }

  async function party(me, body) {
    const op = String(body.op || '');
    const user = (await get(`users/${me.u}`)) || {};
    const current = user.party ? await get(`parties/${user.party}`) : null;
    const inParty = current && current.members && current.members[me.u];
    if (op === 'create') {
      if (inParty) throw new HttpError(400, "You're already in a party");
      const id = crypto.randomBytes(6).toString('hex');
      await update({ [`parties/${id}`]: { leader: me.u, created: now(), members: { [me.u]: now() } }, [`users/${me.u}/party`]: id });
    } else if (op === 'invite') {
      if (!inParty) throw new HttpError(400, 'Make a party first');
      const to = normUuid(body.uuid);
      if (!(await areFriends(me.u, to))) throw new HttpError(403, 'You can only invite friends');
      if (Object.keys(current.members).length >= MAX_PARTY) throw new HttpError(400, `Parties have room for ${MAX_PARTY}`);
      await update({ [`partyInvites/${to}/${user.party}`]: { from: me.n, at: now() } });
    } else if (op === 'accept') {
      const id = String(body.party || '');
      if (!/^[0-9a-f]{12}$/.test(id)) throw new HttpError(400, 'Bad party');
      const inv = await get(`partyInvites/${me.u}/${id}`);
      const target = await get(`parties/${id}`);
      if (!inv || now() - inv.at >= PARTY_INVITE_MS || !target) throw new HttpError(400, 'That invite has expired');
      if (Object.keys(target.members || {}).length >= MAX_PARTY) throw new HttpError(400, 'That party is full');
      const changes = { [`parties/${id}/members/${me.u}`]: now(), [`users/${me.u}/party`]: id, [`partyInvites/${me.u}/${id}`]: null };
      if (inParty) Object.assign(changes, leaveChanges(me.u, user.party, current));
      await update(changes);
    } else if (op === 'decline') {
      await update({ [`partyInvites/${me.u}/${String(body.party || '').replace(/[^0-9a-f]/g, '') || 'x'}`]: null });
    } else if (op === 'leave') {
      if (inParty) await update(leaveChanges(me.u, user.party, current));
      else await update({ [`users/${me.u}/party`]: null });
    } else if (op === 'kick') {
      const who = normUuid(body.uuid);
      if (!inParty || current.leader !== me.u) throw new HttpError(403, 'Only the party leader can do that');
      if (who === me.u || !current.members[who]) throw new HttpError(400, "They're not in your party");
      await update({ [`parties/${user.party}/members/${who}`]: null, [`users/${who}/party`]: null });
    } else {
      throw new HttpError(400, 'Unknown party action');
    }
    const fresh = (await get(`users/${me.u}/party`)) || null;
    return { party: await partyState(me.u, fresh) };
  }

  // Leaving hands the lead to whoever joined first, and an empty party is removed.
  function leaveChanges(uuid, partyId, party) {
    const rest = Object.entries(party.members).filter(([id]) => id !== uuid).sort((a, b) => a[1] - b[1]);
    const changes = { [`users/${uuid}/party`]: null };
    if (!rest.length) changes[`parties/${partyId}`] = null;
    else {
      changes[`parties/${partyId}/members/${uuid}`] = null;
      if (party.leader === uuid) changes[`parties/${partyId}/leader`] = rest[0][0];
    }
    return changes;
  }

  // ------------------------------------------------------------ location sharing, blocking, invite codes

  async function shareLocation(me, body) {
    const to = normUuid(body.to);
    const minutes = Math.max(0, Math.min(MAX_SHARE_MINUTES, Math.round(Number(body.minutes) || 0)));
    if (minutes > 0 && !(await areFriends(me.u, to))) throw new HttpError(403, 'You can only share with friends');
    await update({ [`locshare/${me.u}/${to}`]: minutes > 0 ? now() + minutes * 60 * 1000 : null });
    return friendState(me.u);
  }

  async function isBlockedBy(target, me) {
    return !!(await get(`blocks/${target}/${me}`));
  }

  function newInviteCode() {
    // No look-alike characters (0/O, 1/I/L), so codes can be read out loud.
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    for (const b of crypto.randomBytes(8)) code += alphabet[b % alphabet.length];
    return code;
  }

  async function invite(me, body) {
    const op = String(body.op || '');
    if (op === 'create') {
      const old = await get(`users/${me.u}/inviteCode`);
      const code = newInviteCode();
      const changes = { [`inviteCodes/${code}`]: { uuid: me.u, exp: now() + INVITE_CODE_MS }, [`users/${me.u}/inviteCode`]: code };
      if (old && /^[A-Z0-9]{8}$/.test(old)) changes[`inviteCodes/${old}`] = null;
      await update(changes);
      return { code, expires: now() + INVITE_CODE_MS };
    }
    if (op === 'redeem') {
      const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!/^[A-Z0-9]{8}$/.test(code)) throw new HttpError(400, 'Codes are 8 letters and numbers');
      const entry = await get(`inviteCodes/${code}`);
      if (!entry || entry.exp < now()) throw new HttpError(404, 'That code has expired or is wrong');
      const other = entry.uuid;
      if (other === me.u) throw new HttpError(400, "That's your own code");
      if (await isBlockedBy(other, me.u)) throw new HttpError(404, 'That code has expired or is wrong');
      const mine = (await get(`friends/${me.u}`)) || {};
      if (Object.keys(mine).length >= MAX_FRIENDS) throw new HttpError(400, 'Friends list is full');
      // Sharing a code is an invitation, so using it makes you friends straight away.
      await update({ [`friends/${me.u}/${other}`]: 'friends', [`friends/${other}/${me.u}`]: 'friends' });
      return friendState(me.u);
    }
    throw new HttpError(400, 'Unknown invite action');
  }

  // ------------------------------------------------------------ profiles, gifts, settings sync

  async function profile(me, body) {
    const id = normUuid(body.uuid);
    if (id !== me.u && !(await areFriends(me.u, id)) && !isAdmin(me.u)) throw new HttpError(403, 'Profiles are for friends');
    const [u, p] = await Promise.all([get(`users/${id}`), get(`presence/${id}`)]);
    if (!u) throw new HttpError(404, 'No such player');
    const visible = !!p && !p.hidden && now() - p.at < ONLINE_MS;
    return {
      uuid: id, name: u.name, bio: u.bio || '', online: visible || id === me.u, server: visible ? p.server : '',
      status: visible ? p.status || '' : '', lastSeen: (p && p.seen) || 0, playMs: u.playMs || 0,
      firstSeen: u.firstSeen || 0, capeStyle: u.cape ? u.capeStyle || 'classic' : null, extras: u.extras || null,
      setup: u.setup || null, unlocked: unlocked(u)
    };
  }

  async function setProfile(me, body) {
    const changes = {};
    if (body.bio !== undefined) changes[`users/${me.u}/bio`] = cleanText(body.bio).slice(0, MAX_BIO);
    if (body.setup !== undefined) {
      const setup = body.setup === null ? null : String(body.setup);
      if (setup && (setup.length > MAX_SETUP || !/^[A-Za-z0-9+/=_-]+$/.test(setup))) throw new HttpError(400, 'Bad setup code');
      changes[`users/${me.u}/setup`] = setup || null;
    }
    if (Object.keys(changes).length) await update(changes);
    return profile(me, { uuid: me.u });
  }

  async function gift(me, body) {
    const to = normUuid(body.to);
    const item = String(body.item || '');
    if (!UNLOCKS[item]) throw new HttpError(400, "That can't be gifted");
    if (!(await areFriends(me.u, to))) throw new HttpError(403, 'You can only give gifts to friends');
    const [mine, theirs] = await Promise.all([get(`users/${me.u}`), get(`users/${to}`)]);
    if (!owns(mine || {}, item)) throw new HttpError(403, "You can only give something you've unlocked");
    if (owns(theirs || {}, item)) throw new HttpError(400, 'They already have it');
    const day = (mine && mine.giftDay) || { start: 0, count: 0 };
    const fresh = now() - day.start >= 24 * 3600 * 1000;
    const count = fresh ? 1 : day.count + 1;
    if (count > GIFTS_PER_DAY) throw new HttpError(429, 'One gift a day');
    await update({
      [`users/${to}/gifts/${item}`]: { from: me.n, at: now() },
      [`users/${me.u}/giftDay`]: { start: fresh ? now() : day.start, count },
      [`messages/${to}/${messageKey()}`]: { from: me.u, name: me.n, text: `Gave you a gift: ${item}`, at: now(), gift: item }
    });
    return { sent: true };
  }

  async function sync(me, body) {
    const op = String(body.op || '');
    if (op === 'put') {
      const data = String(body.data || '');
      if (!data || data.length > MAX_SYNC) throw new HttpError(400, 'Settings are too big to sync');
      await update({ [`sync/${me.u}`]: { data, at: now() } });
      return { saved: true, at: now() };
    }
    if (op === 'get') {
      const saved = await get(`sync/${me.u}`);
      return saved ? { data: saved.data, at: saved.at } : { data: null };
    }
    throw new HttpError(400, 'Unknown sync action');
  }

  // ------------------------------------------------------------ screenshots between friends

  async function shot(me, body) {
    const op = String(body.op || '');
    if (op === 'send') {
      const to = normUuid(body.to);
      const data = String(body.jpeg || '');
      if (!data || data.length > MAX_SHOT || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new HttpError(400, 'That picture is too big');
      if (!(await areFriends(me.u, to))) throw new HttpError(403, 'You can only send pictures to friends');
      if (await isBlockedBy(to, me.u)) throw new HttpError(403, "You can't send that player pictures");
      const mine = (await get(`shotsBy/${me.u}`)) || {};
      const recent = Object.values(mine).filter((at) => now() - at < 24 * 3600 * 1000).length;
      if (recent >= SHOTS_PER_DAY) throw new HttpError(429, `${SHOTS_PER_DAY} pictures a day`);
      const id = crypto.randomBytes(9).toString('hex');
      const changes = {
        [`shots/${id}`]: { from: me.u, to, data, at: now() },
        [`shotsBy/${me.u}/${id}`]: now(),
        [`messages/${to}/${messageKey()}`]: { from: me.u, name: me.n, text: 'Sent you a screenshot', at: now(), shot: id }
      };
      // Old pictures are cleared out as you send new ones.
      for (const [old, at] of Object.entries(mine)) {
        if (now() - at > SHOT_KEEP_MS) {
          changes[`shots/${old}`] = null;
          changes[`shotsBy/${me.u}/${old}`] = null;
        }
      }
      await update(changes);
      return { sent: true, id };
    }
    if (op === 'get') {
      const id = String(body.id || '');
      if (!/^[0-9a-f]{18}$/.test(id)) throw new HttpError(400, 'Bad picture');
      const s = await get(`shots/${id}`);
      if (!s || (s.to !== me.u && s.from !== me.u) || now() - s.at > SHOT_KEEP_MS) throw new HttpError(404, 'That picture is gone');
      return { jpeg: s.data, at: s.at };
    }
    throw new HttpError(400, 'Unknown picture action');
  }

  // ------------------------------------------------------------ announcements, feature flags, bug reports

  let noticeCache = null;
  let noticeUntil = 0;

  // The current announcement and feature flags, for every heartbeat. Cached briefly like the online count.
  async function notices() {
    if (noticeCache && now() < noticeUntil) return noticeCache;
    const [a, flags] = await Promise.all([get('announcement'), get('flags')]);
    noticeCache = { announcement: a && a.until > now() ? { id: a.id, text: a.text } : null, flags: flags || {} };
    noticeUntil = now() + PLAYING_CACHE_MS;
    return noticeCache;
  }

  async function bug(me, body) {
    const text = cleanText(body.text).slice(0, MAX_BUG);
    if (!text) throw new HttpError(400, 'Say what went wrong');
    const log = String(body.log || '').slice(-MAX_BUG_LOG);
    const window = (await get(`users/${me.u}/bugWindow`)) || { start: 0, count: 0 };
    const fresh = now() - window.start >= 3600 * 1000;
    const count = fresh ? 1 : window.count + 1;
    if (count > BUGS_PER_HOUR) throw new HttpError(429, 'Thanks! Try again in a while');
    await update({
      [`users/${me.u}/bugWindow`]: { start: fresh ? now() : window.start, count },
      [`bugs/${messageKey()}`]: { from: me.u, name: me.n, text, log, version: String(body.version || '').slice(0, 20), at: now() }
    });
    return { sent: true };
  }

  // Badges and capes for the players you can see. Only says whether someone uses Dragomir, nothing else.
  async function cosmetics(me, body) {
    const ids = Array.isArray(body.uuids) ? body.uuids.slice(0, MAX_LOOKUP).map(normUuid) : [];
    const records = await Promise.all(ids.map((id) => get(`users/${id}`)));
    const users = {};
    ids.forEach((id, i) => {
      const r = records[i];
      if (r) {
        users[id] = { badge: r.badge !== false, cape: !!r.cape, capeStyle: r.cape ? (r.capeStyle || 'classic') : null };
        if (r.extras) {
          const e = r.extras;
          users[id].extras = { hat: e.hat || null, wings: e.wings || null, trail: e.trail || null, accessory: e.accessory || null,
            pet: e.pet || null, color: e.color ?? null, nameColor: e.nameColor ?? null };
        }
      }
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
      // Someone who blocked you looks like they don't use Dragomir, so a block isn't announced.
      if (await isBlockedBy(target, me.u)) throw new HttpError(404, `${body.name} hasn't used Dragomir Client yet`);
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
    } else if (op === 'block') {
      const target = normUuid(body.uuid);
      if (target === me.u) throw new HttpError(400, "You can't block yourself");
      await update({ [`blocks/${me.u}/${target}`]: true, [`friends/${me.u}/${target}`]: null, [`friends/${target}/${me.u}`]: null,
        [`locshare/${me.u}/${target}`]: null, [`locshare/${target}/${me.u}`]: null });
    } else if (op === 'unblock') {
      await update({ [`blocks/${me.u}/${normUuid(body.uuid)}`]: null });
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
          friends: Object.values(links).filter((v) => v === 'friends').length,
          playMs: u.playMs || 0, version: (p && p.version) || ''
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
    if (op === 'announce') {
      const text = cleanText(body.text).slice(0, MAX_ANNOUNCEMENT);
      const hours = Math.max(1, Math.min(168, Number(body.hours) || 24));
      if (!text) throw new HttpError(400, 'Write the announcement');
      const announcement = { id: crypto.randomBytes(4).toString('hex'), text, at: now(), until: now() + hours * 3600 * 1000 };
      await update({ announcement });
      noticeCache = null;
      return { announcement };
    }
    if (op === 'announceClear') {
      await update({ announcement: null });
      noticeCache = null;
      return { announcement: null };
    }
    if (op === 'getNotices') {
      const [announcement, flags] = await Promise.all([get('announcement'), get('flags')]);
      return { announcement: announcement && announcement.until > now() ? announcement : null, flags: flags || {} };
    }
    if (op === 'flags') {
      const flags = body.flags && typeof body.flags === 'object' ? body.flags : {};
      const clean = {};
      for (const [k, v] of Object.entries(flags)) {
        if (!FLAG_RE.test(k)) throw new HttpError(400, `Bad flag name: ${k}`);
        clean[k] = v === null ? null : !!v;
      }
      const changes = {};
      for (const [k, v] of Object.entries(clean)) changes[`flags/${k}`] = v;
      if (Object.keys(changes).length) await update(changes);
      noticeCache = null;
      return { flags: (await get('flags')) || {} };
    }
    if (op === 'usage') {
      // How many players (seen in the last 30 days) have each mod turned on.
      const usage = (await get('usage')) || {};
      const counts = {}, versions = {};
      let players = 0;
      for (const u of Object.values(usage)) {
        if (!u || now() - u.at > 30 * 24 * 3600 * 1000) continue;
        players++;
        for (const m of u.mods || []) counts[m] = (counts[m] || 0) + 1;
        if (u.version) versions[u.version] = (versions[u.version] || 0) + 1;
      }
      const mods = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
      return { players, mods, versions };
    }
    if (op === 'bugs') {
      const bugs = (await get('bugs')) || {};
      const list = Object.entries(bugs).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 100)
        .map(([key, b]) => ({ key, name: b.name, text: b.text, version: b.version, at: b.at, hasLog: !!b.log }));
      return { bugs: list };
    }
    if (op === 'bug') {
      const key = String(body.key || '');
      if (!/^[0-9a-f-]{20,40}$/.test(key)) throw new HttpError(400, 'Bad report');
      const b = await get(`bugs/${key}`);
      if (!b) throw new HttpError(404, 'No such report');
      return { key, ...b };
    }
    if (op === 'bugDelete') {
      const key = String(body.key || '');
      if (!/^[0-9a-f-]{20,40}$/.test(key)) throw new HttpError(400, 'Bad report');
      await update({ [`bugs/${key}`]: null });
      return { deleted: true };
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
      else if (action === 'party') result = await party(me, body);
      else if (action === 'shareLocation') result = await shareLocation(me, body);
      else if (action === 'invite') result = await invite(me, body);
      else if (action === 'profile') result = await profile(me, body);
      else if (action === 'setProfile') result = await setProfile(me, body);
      else if (action === 'gift') result = await gift(me, body);
      else if (action === 'sync') result = await sync(me, body);
      else if (action === 'shot') result = await shot(me, body);
      else if (action === 'bug') result = await bug(me, body);
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
