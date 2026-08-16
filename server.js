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
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;
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
};
const passwordRequests = new Map(); // id -> { id, userId, newPassword, note, status, createdAt, resolvedAt }

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
app.use(express.json({ limit: '15mb' })); // avatars are base64 data URLs
app.use(express.static(path.join(__dirname, 'public'))); // serves index.html (the website itself)

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
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  const user = [...db.users.values()].find(u => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

  const ok = bcrypt.compareSync(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// =========================================================================
// Executives (directory + President-only creation)
// =========================================================================
app.get('/api/executives', authMiddleware, (req, res) => {
  const list = [...db.users.values()].map(publicUser);
  res.json(list);
});

app.post('/api/executives', authMiddleware, requirePresident, (req, res) => {
  const { username, designation, password } = req.body || {};
  if (!username || !designation || !password) {
    return res.status(400).json({ error: 'Username, designation, and password are required.' });
  }
  const exists = [...db.users.values()].some(u => u.username.toLowerCase() === String(username).toLowerCase());
  if (exists) return res.status(409).json({ error: 'That username is already taken.' });

  const user = {
    id: uuid(),
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    role: 'EXECUTIVE',
    displayName: username,
    designation,
    avatarUrl: null,
    bio: '',
    socialLinks: [],
  };
  db.users.set(user.id, user);
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
  res.status(204).end();
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
app.patch('/api/auth/password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const u = req.user;
  if (u.role !== 'PRESIDENT') return res.status(403).json({ error: 'Only the President can change a password directly. Submit a request instead.' });
  if (!currentPassword || !bcrypt.compareSync(currentPassword, u.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters.' });
  u.passwordHash = bcrypt.hashSync(newPassword, 10);
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
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters.' });
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

app.post('/api/password-requests/:id/resolve', authMiddleware, requirePresident, (req, res) => {
  const request = passwordRequests.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'This request was already resolved.' });

  const { action } = req.body || {};
  if (action === 'approve') {
    const u = db.users.get(request.userId);
    if (!u) return res.status(404).json({ error: 'User not found.' });
    u.passwordHash = bcrypt.hashSync(request.newPassword, 10);
    request.status = 'approved';
  } else if (action === 'deny') {
    request.status = 'denied';
  } else {
    return res.status(400).json({ error: 'Action must be "approve" or "deny".' });
  }
  request.newPassword = undefined; // never keep plaintext around after resolution
  request.resolvedAt = Date.now();
  res.json(publicPasswordRequest(request));
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
    messages: msgs.slice(0, 1).map(m => ({ id: m.id, body: m.body, senderId: m.senderId, createdAt: m.createdAt })),
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
// Health check
// =========================================================================
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

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
  addOnline(userId, socket.id);

  // ---- Conversations: rooms + messaging ----
  socket.on('conversation:join', ({ conversationId }) => {
    if (!conversationId) return;
    socket.join('conversation:' + conversationId);
  });
  socket.on('conversation:leave', ({ conversationId }) => {
    if (!conversationId) return;
    socket.leave('conversation:' + conversationId);
  });

  socket.on('message:send', ({ conversationId, body }, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const convo = db.conversations.get(conversationId);
    if (!convo || !convo.participantIds.includes(userId)) {
      return ack({ ok: false, error: 'Conversation not found.' });
    }
    if (!body || !String(body).trim()) {
      return ack({ ok: false, error: 'Message cannot be empty.' });
    }
    const message = {
      id: uuid(),
      conversationId,
      senderId: userId,
      body: String(body).trim(),
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
  socket.on('call:invite', ({ toUserId, conversationId, video }) => {
    emitToUser(toUserId, 'call:incoming', { fromUserId: userId, conversationId, video: !!video });
  });
  socket.on('call:accept', ({ toUserId, conversationId }) => {
    emitToUser(toUserId, 'call:accepted', { fromUserId: userId, conversationId });
  });
  socket.on('call:reject', ({ toUserId, conversationId }) => {
    emitToUser(toUserId, 'call:rejected', { fromUserId: userId, conversationId });
  });
  socket.on('call:signal', ({ toUserId, data }) => {
    emitToUser(toUserId, 'call:signal', { fromUserId: userId, data });
  });
  socket.on('call:end', ({ toUserId }) => {
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
    // Leave any active meetings this socket was part of if the user has no other sockets connected
    if (!isOnline(userId)) {
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
