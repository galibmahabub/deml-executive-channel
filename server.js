/**
 * DEML Executive Channel — backend
 * REST API + Socket.IO server, in-memory data store (resets on restart).
 *
 * Run:
 *   npm install
 *   node server.js
 *
 * Then open the frontend HTML file in your browser (double-click it, or
 * serve it however you like). It talks to http://localhost:4000.
 *
 * A President account is seeded on first boot — see the console output
 * when you start the server for the generated username/password.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcryptjs'); // async .hash/.compare used below to avoid blocking the event loop
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;

if (!process.env.JWT_SECRET) {
  console.warn('\n⚠️  WARNING: JWT_SECRET is not set. Using an insecure default.');
  console.warn('   Anyone who can see this code (e.g. a public GitHub repo) can forge');
  console.warn('   login sessions, including a President session. Set a real JWT_SECRET');
  console.warn('   environment variable before deploying. See DEPLOY.md.\n');
}
const JWT_SECRET = process.env.JWT_SECRET || 'deml-dev-secret-change-me';

// =========================================================================
// In-memory data store
// =========================================================================
const db = {
  users: new Map(),          // id -> user
  todos: new Map(),          // id -> todo
  conversations: new Map(),  // id -> conversation
  messages: new Map(),       // id -> message
  meetings: new Map(),       // id -> meeting
  announcements: new Map(),  // id -> announcement
  events: new Map(),         // id -> event
};
const passwordRequests = new Map(); // id -> { id, userId, newPassword, note, status, createdAt, resolvedAt }
const profileRequests = new Map(); // id -> { id, name, email, phone, password, status, createdAt, resolvedAt }

// =========================================================================
// File-based persistence — saves the store above to a local JSON file so a
// restart doesn't wipe every user, message, and login.
//
// What this covers: a crash-restart, or a Render free-tier sleep/wake
// cycle, reuses the SAME container and disk — so this file survives those,
// and is exactly what fixes "everything reset when the site woke back up."
//
// What this does NOT cover: an actual redeploy (pushing new code, or
// clicking "Deploy latest commit") builds a brand-new container from
// scratch on Render's free tier, and this file will NOT carry over —
// there's no way to persist local files across a redeploy without a paid
// persistent disk. If you need data to survive redeploys too, it has to
// live in an external database (e.g. Render's free PostgreSQL) instead of
// a local file. This section is a genuine improvement either way, and is
// a drop-in stepping stone to a real database later — the load/save shape
// here maps directly onto database reads/writes if you make that switch.
// =========================================================================
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

function serializeState() {
  return {
    savedAt: Date.now(),
    users: [...db.users.values()],
    todos: [...db.todos.values()],
    conversations: [...db.conversations.values()],
    messages: [...db.messages.values()],
    // No meeting survives a restart as "live" — nobody is actually
    // connected via socket anymore once the process comes back up.
    meetings: [...db.meetings.values()].map(m => ({ ...m, active: false })),
    announcements: [...db.announcements.values()],
    events: [...db.events.values()],
    passwordRequests: [...passwordRequests.values()],
    profileRequests: [...profileRequests.values()],
  };
}

function saveState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Write to a temp file then rename — an atomic swap, so a crash
    // mid-write can never leave behind a half-written, unreadable file.
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(serializeState()));
    fs.renameSync(tmpFile, DATA_FILE);
  } catch (e) {
    console.error('Failed to save data file:', e.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return false;
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    (saved.users || []).forEach(u => db.users.set(u.id, u));
    (saved.todos || []).forEach(t => db.todos.set(t.id, t));
    (saved.conversations || []).forEach(c => db.conversations.set(c.id, c));
    (saved.messages || []).forEach(m => db.messages.set(m.id, m));
    (saved.meetings || []).forEach(m => db.meetings.set(m.id, m));
    (saved.announcements || []).forEach(a => db.announcements.set(a.id, a));
    (saved.events || []).forEach(e => db.events.set(e.id, e));
    (saved.passwordRequests || []).forEach(r => passwordRequests.set(r.id, r));
    (saved.profileRequests || []).forEach(r => profileRequests.set(r.id, r));
    console.log('Restored saved data from data/store.json (' + db.users.size + ' users, saved ' + new Date(saved.savedAt).toLocaleString() + ').');
    return true;
  } catch (e) {
    console.error('Failed to load data file, starting fresh:', e.message);
    return false;
  }
}

loadState();
// Periodic autosave, so a hard crash loses at most a few seconds of data.
setInterval(saveState, 15000);
// Flush immediately on a graceful shutdown — this is what Render sends
// right before it stops the process for a sleep/redeploy/restart, so this
// is the save that actually matters most in practice.
['SIGTERM', 'SIGINT'].forEach(sig => {
  process.on(sig, () => {
    console.log('\nReceived ' + sig + ', saving data before exit...');
    saveState();
    process.exit(0);
  });
});

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    designation: u.designation,
    role: u.role,
    avatarUrl: u.avatarUrl || null,
  };
}

function seedPresident() {
  const existing = [...db.users.values()].find(u => u.role === 'PRESIDENT');
  if (existing) return existing;

  const username = 'president';
  const password = 'President#' + Math.floor(1000 + Math.random() * 9000);
  const user = {
    id: uuid(),
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    role: 'PRESIDENT',
    displayName: 'President',
    designation: 'President',
    avatarUrl: null,
    bio: '',
    socialLinks: [],
  };
  db.users.set(user.id, user);
  saveState(); // save immediately — this is a brand-new President account, don't risk losing it to the 15s window

  console.log('\n============================================');
  console.log(' President account created (first boot only)');
  console.log(' Username: ' + username);
  console.log(' Password: ' + password);
  console.log(' Save these — they will not be shown again.');
  console.log('============================================\n');
  return user;
}
seedPresident();

// =========================================================================
// App setup
// =========================================================================
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '20mb' })); // avatars + chat attachments are base64 data URLs
app.use(express.static(path.join(__dirname, 'public'))); // serves index.html (the website itself)

// =========================================================================
// Chat attachment helpers
// =========================================================================
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8MB, before base64 overhead
const DATA_URL_RE = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

function parseAttachment(raw) {
  if (!raw || typeof raw !== 'object') return { error: null, attachment: null };
  const { name, mimeType, dataUrl } = raw;
  if (!name || !String(name).trim()) return { error: 'Attachment name is required.', attachment: null };
  if (!dataUrl || typeof dataUrl !== 'string') return { error: 'Attachment data is missing.', attachment: null };
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return { error: 'Attachment format is invalid.', attachment: null };
  const declaredType = mimeType || match[1];
  const base64Body = match[2];
  const approxBytes = Math.floor(base64Body.length * 0.75);
  if (approxBytes > MAX_ATTACHMENT_BYTES) {
    return { error: 'Attachments must be 8MB or smaller.', attachment: null };
  }
  return {
    error: null,
    attachment: {
      name: String(name).trim().slice(0, 150),
      mimeType: declaredType,
      size: approxBytes,
      dataUrl,
    },
  };
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// userId -> Set of socket ids currently connected
const onlineSockets = new Map();
function addOnline(userId, socketId) {
  if (!onlineSockets.has(userId)) onlineSockets.set(userId, new Set());
  onlineSockets.get(userId).add(socketId);
}
function removeOnline(userId, socketId) {
  const set = onlineSockets.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) onlineSockets.delete(userId);
}
function isOnline(userId) {
  return onlineSockets.has(userId);
}
function emitToUser(userId, event, payload) {
  const set = onlineSockets.get(userId);
  if (!set) return false;
  set.forEach(socketId => io.to(socketId).emit(event, payload));
  return true;
}

// =========================================================================
// Auth helpers
// =========================================================================
function signToken(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authorization token.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.users.get(payload.sub);
    if (!user) return res.status(401).json({ error: 'Invalid session.' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

function requirePresident(req, res, next) {
  if (req.user.role !== 'PRESIDENT') return res.status(403).json({ error: 'President access required.' });
  next();
}

// =========================================================================
// Auth routes
// =========================================================================
// Very simple in-memory rate limiter for login attempts, keyed by IP.
// Not a substitute for a real rate-limiting layer at scale, but stops
// naive brute-force attempts against a small deployment like this one.
const LOGIN_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map(); // ip -> { count, windowStart }

function loginRateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return next();
  }
  entry.count += 1;
  if (entry.count > LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many login attempts. Please wait a few minutes and try again.' });
  }
  next();
}

// Same idea, separately keyed, for the public (unauthenticated) profile-request
// endpoint — stops naive spam submissions to a form anyone on the internet can reach.
const PROFILE_REQUEST_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const PROFILE_REQUEST_MAX_ATTEMPTS = 5;
const profileRequestAttempts = new Map(); // ip -> { count, windowStart }

function profileRequestRateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = profileRequestAttempts.get(ip);
  if (!entry || now - entry.windowStart > PROFILE_REQUEST_WINDOW_MS) {
    profileRequestAttempts.set(ip, { count: 1, windowStart: now });
    return next();
  }
  entry.count += 1;
  if (entry.count > PROFILE_REQUEST_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many requests. Please wait a while and try again.' });
  }
  next();
}

app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  const user = [...db.users.values()].find(u => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// =========================================================================
// Executives (directory + President-only creation)
// =========================================================================
app.get('/api/executives', authMiddleware, (req, res) => {
  const list = [...db.users.values()].map(u => ({ ...publicUser(u), online: isOnline(u.id) }));
  res.json(list);
});

app.post('/api/executives', authMiddleware, requirePresident, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const designation = String(req.body?.designation || '').trim();
  const password = req.body?.password;
  if (!username || !designation || !password) {
    return res.status(400).json({ error: 'Username, designation, and password are required.' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const exists = [...db.users.values()].some(u => u.username.toLowerCase() === username.toLowerCase());
  if (exists) return res.status(409).json({ error: 'That username is already taken.' });

  const user = {
    id: uuid(),
    username,
    passwordHash: await bcrypt.hash(password, 10),
    role: 'EXECUTIVE',
    displayName: username,
    designation,
    avatarUrl: null,
    bio: '',
    socialLinks: [],
  };
  db.users.set(user.id, user);
  saveState();
  res.status(201).json(publicUser(user));
});

app.delete('/api/executives/:id', authMiddleware, requirePresident, (req, res) => {
  const user = db.users.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Executive not found.' });
  if (user.role === 'PRESIDENT') return res.status(400).json({ error: 'The President account cannot be removed.' });

  db.users.delete(user.id);
  for (const [id, r] of passwordRequests) if (r.userId === user.id) passwordRequests.delete(id);
  for (const c of db.conversations.values()) c.participantIds = c.participantIds.filter(pid => pid !== user.id);
  for (const m of db.meetings.values()) {
    m.participantIds = m.participantIds.filter(pid => pid !== user.id);
    if (m.hostId === user.id) m.active = false;
  }
  for (const ev of db.events.values()) {
    ev.attendeeIds = ev.attendeeIds.filter(id => id !== user.id);
  }
  saveState();
  res.status(204).end();
});

// =========================================================================
// Announcements — President posts to every executive; everyone can read.
// =========================================================================
function publicAnnouncement(a) {
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    author: publicUser(db.users.get(a.authorId)),
    createdAt: a.createdAt,
  };
}

app.get('/api/announcements', authMiddleware, (req, res) => {
  const list = [...db.announcements.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicAnnouncement);
  res.json(list);
});

app.post('/api/announcements', authMiddleware, requirePresident, (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
  if (!body || !body.trim()) return res.status(400).json({ error: 'Announcement body is required.' });

  const announcement = {
    id: uuid(),
    authorId: req.user.id,
    title: title.trim(),
    body: body.trim(),
    createdAt: Date.now(),
  };
  db.announcements.set(announcement.id, announcement);

  const payload = publicAnnouncement(announcement);
  // Broadcast to every user who's currently connected (including the poster).
  db.users.forEach(u => emitToUser(u.id, 'announcement:new', payload));

  res.status(201).json(payload);
});

app.delete('/api/announcements/:id', authMiddleware, requirePresident, (req, res) => {
  const announcement = db.announcements.get(req.params.id);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
  db.announcements.delete(req.params.id);
  db.users.forEach(u => emitToUser(u.id, 'announcement:removed', { id: req.params.id }));
  res.status(204).end();
});

// =========================================================================
// Events — President posts; everyone can view and RSVP ("Going").
// =========================================================================
function publicEvent(e) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    location: e.location,
    startsAt: e.startsAt,
    author: publicUser(db.users.get(e.authorId)),
    createdAt: e.createdAt,
    attendees: e.attendeeIds.map(id => publicUser(db.users.get(id))).filter(Boolean),
  };
}

app.get('/api/events', authMiddleware, (req, res) => {
  const list = [...db.events.values()]
    .sort((a, b) => a.startsAt - b.startsAt)
    .map(publicEvent);
  res.json(list);
});

app.post('/api/events', authMiddleware, requirePresident, (req, res) => {
  const title = String(req.body?.title || '').trim();
  const description = String(req.body?.description || '').trim();
  const location = String(req.body?.location || '').trim();
  const startsAtRaw = req.body?.startsAt;
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const startsAt = Date.parse(startsAtRaw);
  if (!startsAtRaw || Number.isNaN(startsAt)) return res.status(400).json({ error: 'A valid date/time is required.' });

  const event = {
    id: uuid(),
    authorId: req.user.id,
    title,
    description,
    location,
    startsAt,
    createdAt: Date.now(),
    attendeeIds: [],
  };
  db.events.set(event.id, event);

  const payload = publicEvent(event);
  db.users.forEach(u => emitToUser(u.id, 'event:new', payload));

  res.status(201).json(payload);
});

app.delete('/api/events/:id', authMiddleware, requirePresident, (req, res) => {
  const event = db.events.get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  db.events.delete(req.params.id);
  db.users.forEach(u => emitToUser(u.id, 'event:removed', { id: req.params.id }));
  res.status(204).end();
});

app.post('/api/events/:id/rsvp', authMiddleware, (req, res) => {
  const event = db.events.get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const attending = !!req.body?.attending;
  event.attendeeIds = event.attendeeIds.filter(id => id !== req.user.id);
  if (attending) event.attendeeIds.push(req.user.id);

  const payload = publicEvent(event);
  db.users.forEach(u => emitToUser(u.id, 'event:updated', payload));

  res.json(payload);
});

// =========================================================================
// Profile
// =========================================================================
app.get('/api/profile/me', authMiddleware, (req, res) => {
  const u = req.user;
  res.json({ avatarUrl: u.avatarUrl || null, bio: u.bio || '', socialLinks: u.socialLinks || [] });
});

app.patch('/api/profile/me', authMiddleware, (req, res) => {
  const { bio, socialLinks, avatarUrl } = req.body || {};
  const u = req.user;
  if (typeof bio === 'string') u.bio = bio;
  if (Array.isArray(socialLinks)) u.socialLinks = socialLinks;
  if (typeof avatarUrl === 'string') u.avatarUrl = avatarUrl;
  res.json({ avatarUrl: u.avatarUrl || null, bio: u.bio || '', socialLinks: u.socialLinks || [] });
});

// =========================================================================
// Passwords — President changes their own directly; executives submit a
// request that only the President can approve (which sets it permanently)
// or deny.
// =========================================================================
app.patch('/api/auth/password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const u = req.user;
  if (u.role !== 'PRESIDENT') return res.status(403).json({ error: 'Only the President can change a password directly. Submit a request instead.' });
  if (!currentPassword || !(await bcrypt.compare(currentPassword, u.passwordHash))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  u.passwordHash = await bcrypt.hash(newPassword, 10);
  saveState();
  res.json({ ok: true });
});

function publicPasswordRequest(r) {
  return {
    id: r.id,
    userId: r.userId,
    user: publicUser(db.users.get(r.userId)),
    newPassword: r.status === 'pending' ? r.newPassword : undefined,
    note: r.note,
    status: r.status,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
  };
}

app.post('/api/password-requests', authMiddleware, (req, res) => {
  const { newPassword, note } = req.body || {};
  const u = req.user;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  const pending = [...passwordRequests.values()].some(r => r.userId === u.id && r.status === 'pending');
  if (pending) return res.status(409).json({ error: 'You already have a pending request.' });

  const request = {
    id: uuid(),
    userId: u.id,
    newPassword, // held only until the President approves or denies
    note: (note || '').trim(),
    status: 'pending',
    createdAt: Date.now(),
    resolvedAt: null,
  };
  passwordRequests.set(request.id, request);
  res.status(201).json(publicPasswordRequest(request));
});

// President sees every request; executives see only their own.
app.get('/api/password-requests', authMiddleware, (req, res) => {
  const all = [...passwordRequests.values()].sort((a, b) => b.createdAt - a.createdAt);
  const list = req.user.role === 'PRESIDENT' ? all : all.filter(r => r.userId === req.user.id);
  res.json(list.map(publicPasswordRequest));
});

app.post('/api/password-requests/:id/resolve', authMiddleware, requirePresident, async (req, res) => {
  const request = passwordRequests.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'This request was already resolved.' });

  const { action } = req.body || {};
  if (action === 'approve') {
    const u = db.users.get(request.userId);
    if (!u) return res.status(404).json({ error: 'User not found.' });
    u.passwordHash = await bcrypt.hash(request.newPassword, 10);
    request.status = 'approved';
  } else if (action === 'deny') {
    request.status = 'denied';
  } else {
    return res.status(400).json({ error: 'Action must be "approve" or "deny".' });
  }
  request.newPassword = undefined; // never keep plaintext around after resolution
  request.resolvedAt = Date.now();
  saveState();
  res.json(publicPasswordRequest(request));
});

// =========================================================================
// Profile requests — anyone (not yet a member) can submit a request with
// the account details they'd like. This is NOT self-registration: nothing
// is created automatically. The President reviews the request and, if
// approved, contacts the person and creates their account manually from
// the "Manage Executives" tab, same as always.
// =========================================================================
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicProfileRequest(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    password: r.status === 'pending' ? r.password : undefined,
    status: r.status,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
  };
}

// Public — no authentication. This is the only endpoint in the app someone
// without an account can call (besides login and the public stats count).
app.post('/api/profile-requests', profileRequestRateLimit, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim();
  const phone = String(req.body?.phone || '').trim();
  const password = req.body?.password;

  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
  if (!phone) return res.status(400).json({ error: 'Phone number is required.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const request = {
    id: uuid(),
    name: name.slice(0, 100),
    email: email.slice(0, 150),
    phone: phone.slice(0, 40),
    password,
    status: 'pending',
    createdAt: Date.now(),
    resolvedAt: null,
  };
  profileRequests.set(request.id, request);

  const payload = publicProfileRequest(request);
  db.users.forEach(u => { if (u.role === 'PRESIDENT') emitToUser(u.id, 'profile-request:new', payload); });

  res.status(201).json({ ok: true });
});

app.get('/api/profile-requests', authMiddleware, requirePresident, (req, res) => {
  const list = [...profileRequests.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicProfileRequest);
  res.json(list);
});

app.post('/api/profile-requests/:id/resolve', authMiddleware, requirePresident, (req, res) => {
  const request = profileRequests.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'This request was already resolved.' });

  const { action } = req.body || {};
  if (action !== 'contacted' && action !== 'dismiss') {
    return res.status(400).json({ error: 'Action must be "contacted" or "dismiss".' });
  }
  request.status = action === 'contacted' ? 'contacted' : 'dismissed';
  request.password = undefined; // never keep plaintext around after resolution
  request.resolvedAt = Date.now();
  res.json(publicProfileRequest(request));
});

// =========================================================================
// Todos (private per user)
// =========================================================================
app.get('/api/todos', authMiddleware, (req, res) => {
  const list = [...db.todos.values()]
    .filter(t => t.userId === req.user.id)
    .sort((a, b) => a.createdAt - b.createdAt);
  res.json(list.map(({ id, content, done }) => ({ id, content, done })));
});

app.post('/api/todos', authMiddleware, (req, res) => {
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'Task content is required.' });
  const todo = { id: uuid(), userId: req.user.id, content: content.trim(), done: false, createdAt: Date.now() };
  db.todos.set(todo.id, todo);
  res.status(201).json({ id: todo.id, content: todo.content, done: todo.done });
});

app.patch('/api/todos/:id', authMiddleware, (req, res) => {
  const todo = db.todos.get(req.params.id);
  if (!todo || todo.userId !== req.user.id) return res.status(404).json({ error: 'Task not found.' });
  if (typeof req.body.done === 'boolean') todo.done = req.body.done;
  if (typeof req.body.content === 'string') todo.content = req.body.content;
  res.json({ id: todo.id, content: todo.content, done: todo.done });
});

app.delete('/api/todos/:id', authMiddleware, (req, res) => {
  const todo = db.todos.get(req.params.id);
  if (!todo || todo.userId !== req.user.id) return res.status(404).json({ error: 'Task not found.' });
  db.todos.delete(req.params.id);
  res.status(204).end();
});

// =========================================================================
// Conversations & messages
// =========================================================================
function hydrateConversation(convo, viewerId) {
  const participants = convo.participantIds.map(uid => ({ userId: uid, user: publicUser(db.users.get(uid)) }));
  const msgs = [...db.messages.values()]
    .filter(m => m.conversationId === convo.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  return {
    id: convo.id,
    isGroup: convo.isGroup,
    title: convo.title || null,
    participants,
    messages: msgs.slice(0, 1).map(m => ({ id: m.id, body: m.body, attachment: m.attachment || null, senderId: m.senderId, createdAt: m.createdAt })),
  };
}

app.get('/api/conversations', authMiddleware, (req, res) => {
  const list = [...db.conversations.values()]
    .filter(c => c.participantIds.includes(req.user.id))
    .map(c => hydrateConversation(c, req.user.id));
  res.json(list);
});

app.post('/api/conversations/direct', authMiddleware, (req, res) => {
  const { otherUserId } = req.body || {};
  const other = db.users.get(otherUserId);
  if (!other) return res.status(404).json({ error: 'Executive not found.' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'Cannot start a conversation with yourself.' });

  let convo = [...db.conversations.values()].find(c =>
    !c.isGroup &&
    c.participantIds.length === 2 &&
    c.participantIds.includes(req.user.id) &&
    c.participantIds.includes(other.id)
  );

  if (!convo) {
    convo = { id: uuid(), isGroup: false, title: null, participantIds: [req.user.id, other.id], createdAt: Date.now() };
    db.conversations.set(convo.id, convo);
  }
  res.status(201).json(hydrateConversation(convo, req.user.id));
});

app.get('/api/conversations/:id/messages', authMiddleware, (req, res) => {
  const convo = db.conversations.get(req.params.id);
  if (!convo || !convo.participantIds.includes(req.user.id)) return res.status(404).json({ error: 'Conversation not found.' });

  const msgs = [...db.messages.values()]
    .filter(m => m.conversationId === convo.id)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(m => ({
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      sender: publicUser(db.users.get(m.senderId)),
      body: m.body,
      attachment: m.attachment || null,
      createdAt: m.createdAt,
      readBy: m.readBy,
    }));
  res.json(msgs);
});

// =========================================================================
// Meetings (President-hosted, max 10 participants)
// =========================================================================
const MAX_MEETING_PARTICIPANTS = 10;

app.get('/api/meetings', authMiddleware, (req, res) => {
  const list = [...db.meetings.values()]
    .filter(m => m.active)
    .map(m => ({
      id: m.id,
      title: m.title,
      host: publicUser(db.users.get(m.hostId)),
      participantCount: m.participantIds.length,
      maxParticipants: MAX_MEETING_PARTICIPANTS,
    }));
  res.json(list);
});

app.post('/api/meetings', authMiddleware, requirePresident, (req, res) => {
  const { title } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Meeting title is required.' });
  const meeting = {
    id: uuid(),
    title: title.trim(),
    hostId: req.user.id,
    participantIds: [req.user.id],
    active: true,
    createdAt: Date.now(),
  };
  db.meetings.set(meeting.id, meeting);
  res.status(201).json({
    id: meeting.id,
    title: meeting.title,
    host: publicUser(req.user),
    participantCount: meeting.participantIds.length,
    maxParticipants: MAX_MEETING_PARTICIPANTS,
  });
});

app.post('/api/meetings/:id/join', authMiddleware, (req, res) => {
  const meeting = db.meetings.get(req.params.id);
  if (!meeting || !meeting.active) return res.status(404).json({ error: 'Meeting not found.' });
  if (!meeting.participantIds.includes(req.user.id)) {
    if (meeting.participantIds.length >= MAX_MEETING_PARTICIPANTS) {
      return res.status(409).json({ error: 'This meeting is full.' });
    }
    meeting.participantIds.push(req.user.id);
  }
  res.json({ ok: true });
});

app.post('/api/meetings/:id/leave', authMiddleware, (req, res) => {
  const meeting = db.meetings.get(req.params.id);
  if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });
  meeting.participantIds = meeting.participantIds.filter(id => id !== req.user.id);
  if (meeting.hostId === req.user.id) {
    // President left — close the meeting for everyone.
    meeting.active = false;
  }
  res.json({ ok: true });
});

// =========================================================================
// Search — messages the user can see (their own conversations) + all
// announcements. Simple case-insensitive substring match, capped result
// counts since this is an in-memory store with no indexing.
// =========================================================================
const SEARCH_RESULT_LIMIT = 30;

app.get('/api/search', authMiddleware, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ messages: [], announcements: [] });

  const myConvoIds = new Set(
    [...db.conversations.values()].filter(c => c.participantIds.includes(req.user.id)).map(c => c.id)
  );

  const messageResults = [...db.messages.values()]
    .filter(m => myConvoIds.has(m.conversationId) && m.body && m.body.toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, SEARCH_RESULT_LIMIT)
    .map(m => {
      const convo = db.conversations.get(m.conversationId);
      const other = convo && !convo.isGroup ? convo.participantIds.find(pid => pid !== req.user.id) : null;
      return {
        id: m.id,
        conversationId: m.conversationId,
        conversationLabel: convo?.isGroup ? (convo.title || 'Group') : publicUser(db.users.get(other))?.displayName || 'Conversation',
        senderId: m.senderId,
        sender: publicUser(db.users.get(m.senderId)),
        body: m.body,
        createdAt: m.createdAt,
      };
    });

  const announcementResults = [...db.announcements.values()]
    .filter(a => a.title.toLowerCase().includes(q) || a.body.toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, SEARCH_RESULT_LIMIT)
    .map(publicAnnouncement);

  res.json({ messages: messageResults, announcements: announcementResults });
});

// =========================================================================
// Health check
// =========================================================================
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// Public, unauthenticated — just a headline count for the landing page.
// Exposes nothing about who the executives are, only how many accounts exist.
app.get('/api/public/stats', (req, res) => {
  res.json({ profileCount: db.users.size });
});

// =========================================================================
// Socket.IO
// =========================================================================
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Missing auth token'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.users.get(payload.sub);
    if (!user) return next(new Error('Invalid session'));
    socket.userId = user.id;
    next();
  } catch (e) {
    next(new Error('Invalid or expired session'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  const wasOnline = isOnline(userId);
  addOnline(userId, socket.id);
  // First socket for this user going online — tell everyone else.
  if (!wasOnline) {
    db.users.forEach(u => { if (u.id !== userId) emitToUser(u.id, 'presence:update', { userId, online: true }); });
  }

  // ---- Conversations: rooms + messaging ----
  socket.on('conversation:join', ({ conversationId }) => {
    if (!conversationId) return;
    socket.join('conversation:' + conversationId);
  });
  socket.on('conversation:leave', ({ conversationId }) => {
    if (!conversationId) return;
    socket.leave('conversation:' + conversationId);
  });

  socket.on('message:send', ({ conversationId, body, attachment: rawAttachment }, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const convo = db.conversations.get(conversationId);
    if (!convo || !convo.participantIds.includes(userId)) {
      return ack({ ok: false, error: 'Conversation not found.' });
    }
    const trimmedBody = body ? String(body).trim() : '';

    let attachment = null;
    if (rawAttachment) {
      const parsed = parseAttachment(rawAttachment);
      if (parsed.error) return ack({ ok: false, error: parsed.error });
      attachment = parsed.attachment;
    }

    if (!trimmedBody && !attachment) {
      return ack({ ok: false, error: 'Message cannot be empty.' });
    }
    const message = {
      id: uuid(),
      conversationId,
      senderId: userId,
      body: trimmedBody,
      attachment,
      createdAt: Date.now(),
      readBy: [userId],
    };
    db.messages.set(message.id, message);

    const payload = {
      id: message.id,
      conversationId,
      senderId: userId,
      sender: publicUser(db.users.get(userId)),
      body: message.body,
      attachment: message.attachment,
      createdAt: message.createdAt,
    };

    // Deliver to every participant (whether or not they have the room open)
    convo.participantIds.forEach(pid => emitToUser(pid, 'message:new', payload));

    // Mark delivered for any recipient currently online
    const anyoneOnline = convo.participantIds.some(pid => pid !== userId && isOnline(pid));
    if (anyoneOnline) {
      emitToUser(userId, 'message:delivered', { messageId: message.id });
    }

    ack({ ok: true, id: message.id });
  });

  socket.on('message:read', ({ messageId, conversationId }) => {
    const message = db.messages.get(messageId);
    if (!message) return;
    if (!message.readBy.includes(userId)) message.readBy.push(userId);
    const convo = db.conversations.get(message.conversationId || conversationId);
    if (!convo) return;
    // Notify the sender (and everyone else) that it's been read
    convo.participantIds.forEach(pid => emitToUser(pid, 'message:read', { messageId }));
  });

  socket.on('typing:start', ({ conversationId }) => {
    const convo = db.conversations.get(conversationId);
    if (!convo) return;
    convo.participantIds.filter(id => id !== userId).forEach(pid =>
      emitToUser(pid, 'typing:update', { conversationId, typing: true })
    );
  });
  socket.on('typing:stop', ({ conversationId }) => {
    const convo = db.conversations.get(conversationId);
    if (!convo) return;
    convo.participantIds.filter(id => id !== userId).forEach(pid =>
      emitToUser(pid, 'typing:update', { conversationId, typing: false })
    );
  });

  // ---- 1:1 calls (WebRTC signaling relay) ----
  // Only allow signaling between two users who actually share a conversation,
  // so an authenticated user can't spam calls/signals at arbitrary others.
  function shareConversation(otherUserId) {
    return [...db.conversations.values()].some(
      c => c.participantIds.includes(userId) && c.participantIds.includes(otherUserId)
    );
  }
  socket.on('call:invite', ({ toUserId, conversationId, video }) => {
    if (!shareConversation(toUserId)) return;
    emitToUser(toUserId, 'call:incoming', { fromUserId: userId, conversationId, video: !!video });
  });
  socket.on('call:accept', ({ toUserId, conversationId }) => {
    if (!shareConversation(toUserId)) return;
    emitToUser(toUserId, 'call:accepted', { fromUserId: userId, conversationId });
  });
  socket.on('call:reject', ({ toUserId, conversationId }) => {
    if (!shareConversation(toUserId)) return;
    emitToUser(toUserId, 'call:rejected', { fromUserId: userId, conversationId });
  });
  socket.on('call:signal', ({ toUserId, data }) => {
    if (!shareConversation(toUserId)) return;
    emitToUser(toUserId, 'call:signal', { fromUserId: userId, data });
  });
  socket.on('call:end', ({ toUserId }) => {
    if (!shareConversation(toUserId)) return;
    emitToUser(toUserId, 'call:ended', { fromUserId: userId });
  });

  // ---- Meetings (multi-peer WebRTC mesh signaling relay) ----
  socket.on('meeting:join', ({ meetingId }, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const meeting = db.meetings.get(meetingId);
    if (!meeting || !meeting.active) return ack({ ok: false, error: 'Meeting not found.' });
    if (!meeting.participantIds.includes(userId)) {
      if (meeting.participantIds.length >= MAX_MEETING_PARTICIPANTS) {
        return ack({ ok: false, error: 'This meeting is full.' });
      }
      meeting.participantIds.push(userId);
    }
    socket.join('meeting:' + meetingId);
    const peers = meeting.participantIds.filter(id => id !== userId && isOnline(id));
    peers.forEach(pid => emitToUser(pid, 'meeting:peer-joined', { userId }));
    ack({ ok: true, peers });
  });

  socket.on('meeting:signal', ({ meetingId, toUserId, data }) => {
    const meeting = db.meetings.get(meetingId);
    if (!meeting || !meeting.active) return;
    if (!meeting.participantIds.includes(userId) || !meeting.participantIds.includes(toUserId)) return;
    emitToUser(toUserId, 'meeting:signal', { fromUserId: userId, data });
  });

  socket.on('meeting:leave', ({ meetingId }) => {
    const meeting = db.meetings.get(meetingId);
    if (!meeting) return;
    meeting.participantIds = meeting.participantIds.filter(id => id !== userId);
    if (meeting.hostId === userId) meeting.active = false;
    socket.leave('meeting:' + meetingId);
    meeting.participantIds.forEach(pid => emitToUser(pid, 'meeting:peer-left', { userId }));
  });

  // ---- Disconnect cleanup ----
  socket.on('disconnect', () => {
    removeOnline(userId, socket.id);
    // Last socket for this user going offline — tell everyone else.
    if (!isOnline(userId)) {
      db.users.forEach(u => { if (u.id !== userId) emitToUser(u.id, 'presence:update', { userId, online: false }); });
      db.meetings.forEach(meeting => {
        if (meeting.participantIds.includes(userId)) {
          meeting.participantIds = meeting.participantIds.filter(id => id !== userId);
          if (meeting.hostId === userId) meeting.active = false;
          meeting.participantIds.forEach(pid => emitToUser(pid, 'meeting:peer-left', { userId }));
        }
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`DEML Executive Channel backend listening on http://localhost:${PORT}`);
});
