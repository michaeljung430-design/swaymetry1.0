const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { analyzeAssessment } = require('./ai-analysis');

const app = express();
app.get('/healthz', (_request, response) => response.json({ ok: true }));
app.use(express.json({ limit: '10mb' }));
// The desktop app loads its page from a local http://localhost server (for
// camera secure-context reasons) but must still reach this Render-hosted
// endpoint, making this a cross-origin request -- so it needs CORS headers.
// No cookies/credentials are involved, so an open origin is fine here.
app.use('/api/analyze', (_request, response, next) => {
  response.header('Access-Control-Allow-Origin', '*');
  response.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.options('/api/analyze', (_request, response) => response.sendStatus(204));

// Basic per-IP rate limit: this endpoint has no auth (it's called directly
// from a public web page) and forwards to a billed OpenAI key, so an
// unmetered endpoint is a real cost-abuse risk. This isn't a security
// boundary against a determined attacker, just a cheap guard against casual
// or scripted abuse of the open URL.
const analyzeRequestLog = new Map();
const ANALYZE_RATE_WINDOW_MS = 60_000;
const ANALYZE_RATE_MAX = 10;
function isRateLimited(ip) {
  const now = Date.now();
  const recent = (analyzeRequestLog.get(ip) || []).filter(t => now - t < ANALYZE_RATE_WINDOW_MS);
  recent.push(now);
  analyzeRequestLog.set(ip, recent);
  return recent.length > ANALYZE_RATE_MAX;
}
app.post('/api/analyze', async (request, response) => {
  const ip = request.headers['x-forwarded-for']?.split(',')[0].trim() || request.socket.remoteAddress;
  if (isRateLimited(ip)) {
    return response.status(429).json({ error: 'Too many analysis requests from this address. Please wait a minute and try again.' });
  }
  const assessment = request.body;
  if (!assessment || !Array.isArray(assessment.trials)) {
    return response.status(400).json({ error: 'Request body must be a completed assessment JSON with a trials array.' });
  }
  try {
    const result = await analyzeAssessment(assessment);
    response.json(result);
  } catch (error) {
    console.error('AI analysis failed:', error.message, error.detail || '');
    response.status(error.status || 502).json({ error: error.message || 'AI analysis failed.', detail: error.detail });
  }
});
app.use(express.static(__dirname));

const server = http.createServer(app);
const websocketServer = new WebSocketServer({ server });
const rooms = new Map();

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function roomFor(session) {
  if (!rooms.has(session)) rooms.set(session, new Set());
  return rooms.get(session);
}

function validSession(session) {
  return typeof session === 'string' && /^[a-zA-Z0-9-]{4,64}$/.test(session);
}

websocketServer.on('connection', socket => {
  let session;
  let role;

  socket.on('message', raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: 'error', message: 'Invalid message.' });
      return;
    }

    if (!validSession(message.session)) {
      send(socket, { type: 'error', message: 'Invalid session code.' });
      return;
    }

    if (message.type === 'join') {
      if (!['camera', 'sensor', 'side'].includes(message.role)) {
        send(socket, { type: 'error', message: 'Invalid device role.' });
        return;
      }
      session = message.session;
      role = message.role;
      socket.role = role;
      const room = roomFor(session);
      // A new connection with a role already present in the room replaces the
      // old one (e.g. a phone reconnecting after a dropped WiFi connection),
      // instead of both staying joined and silently interleaving data from two
      // physical devices into the same trial.
      for (const existing of [...room]) {
        if (existing.role === role) {
          room.delete(existing);
          send(existing, { type: 'error', message: 'Replaced by a new connection with the same role.' });
          existing.close();
        }
      }
      // Tell the new joiner about everyone already in the room (it would
      // otherwise never learn about a peer that connected before it did).
      for (const peer of room) send(socket, { type: 'peer', role: peer.role, connected: true });
      room.add(socket);
      send(socket, { type: 'joined', session, role });
      for (const peer of room) if (peer !== socket) send(peer, { type: 'peer', role, connected: true });
      return;
    }

    if (!session || message.session !== session) return;
    if (message.type === 'sample' && role !== 'sensor') return;
    if (message.type === 'control' && role !== 'camera') return;
    if (['pose', 'side_status'].includes(message.type) && role !== 'side') return;
    if (!['sample', 'control', 'pose', 'side_status'].includes(message.type)) return;
    if (message.type === 'pose' && (!message.frame || typeof message.frame !== 'object' || raw.length > 16000)) return;

    for (const peer of roomFor(session)) if (peer !== socket) send(peer, message);
  });

  socket.on('close', () => {
    if (!session) return;
    const room = rooms.get(session);
    if (!room) return;
    room.delete(socket);
    for (const peer of room) send(peer, { type: 'peer', role, connected: false });
    if (!room.size) rooms.delete(session);
  });
});

const port = Number(process.env.PORT || 10000);
server.listen(port, '0.0.0.0', () => console.log(`Movement relay listening on ${port}`));
