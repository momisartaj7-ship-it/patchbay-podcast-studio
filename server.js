const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Server } = require('socket.io');
require('dotenv').config();
const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const { mergeEpisode } = require('./merge');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const RECORDINGS_DIR = path.join(__dirname, 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/recordings', express.static(RECORDINGS_DIR));

// ---- Storage: any S3-compatible bucket when configured, local disk otherwise ----
// A real bucket (Backblaze B2, Cloudflare R2, etc.) persists files across
// restarts/redeploys, unlike a host's local disk on most free plans. Set the
// four STORAGE_* env vars to enable it; with none set, recordings save to
// ./recordings as before (fine for local testing, NOT durable on most free
// hosting). Backblaze B2's free tier needs no credit card, unlike R2's.
const useCloudStorage = Boolean(
  process.env.STORAGE_ENDPOINT &&
  process.env.STORAGE_ACCESS_KEY_ID &&
  process.env.STORAGE_SECRET_ACCESS_KEY &&
  process.env.STORAGE_BUCKET_NAME
);

let s3;
if (useCloudStorage) {
  s3 = new S3Client({
    region: process.env.STORAGE_REGION || 'auto',
    // Newer SDK versions add checksum headers by default that some S3-compatible
    // providers (Backblaze B2, R2) can reject on multipart uploads.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    endpoint: process.env.STORAGE_ENDPOINT,
    // Off by default (Backblaze B2 works as-is). Some self-hosted S3 servers need it.
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
    },
  });
  console.log('Storage: cloud bucket (recordings will persist across restarts)');
} else {
  console.log('Storage: local disk (set STORAGE_* env vars for durable storage on free hosting)');
}

function sanitize(value, fallback) {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9-_]/g, '');
  return cleaned || fallback;
}

// Display names are shown on the episode's name plates, so keep them readable
// but strip control characters and cap the length.
function displayName(value, fallback) {
  const cleaned = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30);
  return cleaned || fallback;
}

// ---- ICE servers: STUN alone can't get through symmetric/carrier-grade NAT,
// which is common on mobile networks (a big reason cross-country calls fail
// even though local testing works fine). Set TURN_URL / TURN_USERNAME /
// TURN_CREDENTIAL to your own TURN provider for reliable production use; with
// none set, this falls back to Metered's small public "Open Relay" TURN
// service, which is fine to get unblocked quickly but is a shared public
// resource, not something to depend on for real use. See README.
app.get('/ice-servers', (req, res) => {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];

  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({
      urls: process.env.TURN_URL.split(',').map(s => s.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  } else {
    servers.push({
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    });
  }

  res.json({ iceServers: servers });
});

// ---- Recording sessions ----
// One "session" is one press of Start -> Stop in a room. The server remembers
// who was in the room when it started, so it knows how many recordings to wait
// for before it builds the combined episode.
const EPISODE_HEIGHT = Number(process.env.EPISODE_HEIGHT) === 1080 ? 1080 : 720;
const SESSION_WAIT_MS = 30 * 60 * 1000;        // how long to wait for the other person's upload
const SESSION_KEEP_MS = 6 * 60 * 60 * 1000;    // how long status info is remembered
const PART_KEEP_MS = 2 * 60 * 60 * 1000;       // abandon half-finished uploads after this
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

const sessions = new Map();            // "room:sessionId" -> session
const activeSessionByRoom = new Map(); // room -> sessionId currently recording
const uploadsInProgress = new Map();   // uploadId -> { path, nextIndex, bytes, busy, timer }
const completedUploads = new Map();    // uploadId -> true (so a retried "complete" is harmless)

const sessionKey = (room, sessionId) => `${room}:${sessionId}`;
const cleanId = (value) => String(value || '').replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 80);

function setSessionStatus(session, status) {
  session.status = status;
  session.updatedAt = Date.now();
}

async function moveFile(src, dest) {
  try {
    await fs.promises.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.promises.copyFile(src, dest); // temp folder can be on another disk
    await fs.promises.unlink(src);
  }
}

// In cloud mode a recording's temp copy is kept until the episode is built
// (or the wait expires), then deleted.
function releaseSessionFiles(session) {
  for (const up of session.uploads.values()) {
    if (up.isTemp && up.path) fs.unlink(up.path, () => {});
    up.isTemp = false;
  }
}

async function putToBucket(key, filePath, contentType) {
  await new Upload({
    client: s3,
    params: {
      Bucket: process.env.STORAGE_BUCKET_NAME,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentType,
    },
    // Streams in parts so memory stays small however long the episode is.
    queueSize: 2,
    partSize: 10 * 1024 * 1024,
  }).done();
}

// ---- Building the combined episode ----
// Episodes are built one at a time; ffmpeg is heavy on a small free server.
let mergeQueue = Promise.resolve();

async function buildEpisode(session) {
  const ups = [...session.uploads.values()];
  const host = ups.find((u) => u.isHost) || ups[0];
  const guest = ups.find((u) => u !== host);

  // Each browser reported (in server-clock time) when its recorder really
  // started. Whoever started later is delayed by the difference so both
  // sides line up.
  let hostDelay = 0;
  let guestDelay = 0;
  if (host.startedAt > 0 && guest.startedAt > 0) {
    const diff = host.startedAt - guest.startedAt;
    if (Math.abs(diff) <= 60000) {
      if (diff > 0) hostDelay = diff;
      else guestDelay = -diff;
    }
  }

  const outName = `episode-podcast-${session.sessionId}.mp4`;
  const tmpOut = path.join(os.tmpdir(), `patchbay-${session.room}-${session.sessionId}.mp4`);
  try {
    console.log(`Building episode for room "${session.room}" (host delay ${hostDelay}ms, guest delay ${guestDelay}ms)`);
    await mergeEpisode({
      host: { file: host.path, name: `${host.name} (host)`, delayMs: hostDelay },
      guest: { file: guest.path, name: guest.name, delayMs: guestDelay },
      outputPath: tmpOut,
      height: EPISODE_HEIGHT,
    });

    if (useCloudStorage) {
      await putToBucket(`${session.room}/${outName}`, tmpOut, 'video/mp4');
      fs.unlink(tmpOut, () => {});
    } else {
      await moveFile(tmpOut, path.join(RECORDINGS_DIR, session.room, outName));
    }
    setSessionStatus(session, 'ready');
    console.log(`Episode ready: ${session.room}/${outName}`);
  } catch (err) {
    console.error(`Episode build failed for room "${session.room}":`, err.message);
    fs.unlink(tmpOut, () => {});
    setSessionStatus(session, 'failed');
  } finally {
    releaseSessionFiles(session);
  }
}

function onUploadRegistered(session) {
  const expected = session.participants.size;
  if (expected < 2) {
    setSessionStatus(session, 'saved'); // recorded alone: nothing to combine
    releaseSessionFiles(session);
    return;
  }
  if (session.uploads.size >= expected) {
    clearTimeout(session.waitTimer);
    setSessionStatus(session, 'processing');
    mergeQueue = mergeQueue.then(() => buildEpisode(session)).catch(() => {});
    return;
  }
  setSessionStatus(session, 'uploading');
  if (!session.waitTimer) {
    session.waitTimer = setTimeout(() => {
      if (session.status === 'uploading') {
        console.warn(`Gave up waiting for the other recording in room "${session.room}"`);
        setSessionStatus(session, 'incomplete');
        releaseSessionFiles(session);
      }
    }, SESSION_WAIT_MS);
    session.waitTimer.unref?.();
  }
}

// Forget old sessions (and free any leftover temp files) now and then.
setInterval(() => {
  const cutoff = Date.now() - SESSION_KEEP_MS;
  for (const [key, session] of sessions) {
    if (session.updatedAt < cutoff) {
      releaseSessionFiles(session);
      sessions.delete(key);
    }
  }
}, 30 * 60 * 1000).unref?.();

// ---- Chunked, resumable uploads ----
// Each recording is sent in small pieces. A piece that fails (common on long
// distance links) is simply retried by the browser, instead of restarting a
// multi-hundred-MB upload from zero.
function dropUpload(uploadId) {
  const up = uploadsInProgress.get(uploadId);
  if (!up) return;
  clearTimeout(up.timer);
  uploadsInProgress.delete(uploadId);
  fs.unlink(up.path, () => {});
}

app.post('/upload-chunk', express.raw({ type: '*/*', limit: '32mb' }), (req, res) => {
  const uploadId = cleanId(req.query.uploadId);
  const index = Number.parseInt(req.query.index, 10);
  const body = req.body;
  if (!uploadId || !Number.isInteger(index) || index < 0 || !Buffer.isBuffer(body) || body.length === 0) {
    return res.status(400).json({ ok: false, error: 'Bad chunk' });
  }

  let up = uploadsInProgress.get(uploadId);
  if (!up) {
    if (index !== 0) return res.status(409).json({ ok: false, error: 'Unknown upload' });
    up = { path: path.join(os.tmpdir(), `patchbay-${uploadId}.part`), nextIndex: 0, bytes: 0, busy: false };
    fs.writeFileSync(up.path, '');
    up.timer = setTimeout(() => dropUpload(uploadId), PART_KEEP_MS);
    up.timer.unref?.();
    uploadsInProgress.set(uploadId, up);
  }

  if (up.busy) return res.status(503).json({ ok: false, error: 'Busy, retry' });
  if (index < up.nextIndex) return res.json({ ok: true, duplicate: true }); // a retry of a chunk we already have
  if (index > up.nextIndex) return res.status(409).json({ ok: false, error: 'Out of order', expected: up.nextIndex });
  if (up.bytes + body.length > MAX_UPLOAD_BYTES) {
    dropUpload(uploadId);
    return res.status(413).json({ ok: false, error: 'Recording too large' });
  }

  up.busy = true;
  fs.appendFile(up.path, body, (err) => {
    up.busy = false;
    if (err) {
      console.error('Chunk write failed:', err.message);
      return res.status(500).json({ ok: false, error: 'Could not store chunk' });
    }
    up.nextIndex += 1;
    up.bytes += body.length;
    res.json({ ok: true });
  });
});

app.post('/upload-complete', express.json(), async (req, res) => {
  const b = req.body || {};
  const uploadId = cleanId(b.uploadId);
  if (completedUploads.has(uploadId)) return res.json({ ok: true, duplicate: true });

  const up = uploadsInProgress.get(uploadId);
  if (!up) return res.status(404).json({ ok: false, error: 'Unknown upload' });
  if (up.busy) return res.status(503).json({ ok: false, error: 'Busy, retry' });
  if (Number(b.totalChunks) !== up.nextIndex) {
    return res.status(409).json({ ok: false, error: 'Missing chunks', have: up.nextIndex });
  }

  up.busy = true;
  try {
    const room = sanitize(b.room, 'unknown-room');
    const sessionId = cleanId(b.sessionId);
    const session = sessions.get(sessionKey(room, sessionId));
    const participantId = String(b.participantId || '');
    const who = session?.participants.get(participantId);

    const name = sanitize(who?.name || b.participant, 'guest');
    const role = who ? (who.isHost ? 'host' : 'guest') : 'solo';
    const ext = b.ext === 'mp4' ? 'mp4' : 'webm';
    const fileName = `${name}-${role}-${sessionId || Date.now()}.${ext}`;
    const contentType = ext === 'mp4' ? 'video/mp4' : 'video/webm';

    let keptPath;
    let keptIsTemp = false;
    if (useCloudStorage) {
      await putToBucket(`${room}/${fileName}`, up.path, contentType);
      keptPath = up.path;   // kept until the episode is built
      keptIsTemp = true;
    } else {
      const dir = path.join(RECORDINGS_DIR, room);
      fs.mkdirSync(dir, { recursive: true });
      keptPath = path.join(dir, fileName);
      await moveFile(up.path, keptPath);
    }

    clearTimeout(up.timer);
    uploadsInProgress.delete(uploadId);
    completedUploads.set(uploadId, true);
    if (completedUploads.size > 1000) completedUploads.delete(completedUploads.keys().next().value);

    if (session && who) {
      const previous = session.uploads.get(participantId);
      if (previous?.isTemp && previous.path !== keptPath) fs.unlink(previous.path, () => {});
      session.uploads.set(participantId, {
        name: who.name,
        isHost: who.isHost,
        path: keptPath,
        isTemp: keptIsTemp,
        startedAt: Number(b.startedAt) || 0,
      });
      onUploadRegistered(session);
    } else if (keptIsTemp) {
      fs.unlink(keptPath, () => {}); // nothing will merge this one
    }

    res.json({ ok: true, fileName });
  } catch (err) {
    up.busy = false; // leave the file so the browser can retry "complete"
    console.error('Finalizing upload failed:', err.message);
    res.status(500).json({ ok: false, error: 'Could not store the recording' });
  }
});

// The browser polls this after uploading to show "building episode…" and so on.
app.get('/episode-status/:room', (req, res) => {
  const room = sanitize(req.params.room, 'unknown-room');
  const list = [...sessions.values()]
    .filter((s) => s.room === room)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)
    .map((s) => ({ sessionId: s.sessionId, status: s.status }));
  res.json({ sessions: list });
});

// Force recordings to download instead of opening in the browser.
app.get('/download-recording/:room/:filename', async (req, res) => {
  try {
    const room = String(req.params.room || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const filename = String(req.params.filename || '');

    if (
      !room ||
      !filename ||
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\')
    ) {
      return res.status(400).send('Invalid recording path');
    }

    // Cloud storage
    if (useCloudStorage) {
      const obj = await s3.send(new GetObjectCommand({
        Bucket: process.env.STORAGE_BUCKET_NAME,
        Key: `${room}/${filename}`,
      }));

      res.setHeader('Content-Type', obj.ContentType || 'video/webm');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename.replace(/"/g, '')}"`
      );

      if (obj.ContentLength != null) {
        res.setHeader('Content-Length', String(obj.ContentLength));
      }

      if (obj.Body?.pipe) {
        return obj.Body.pipe(res);
      }

      const chunks = [];
      for await (const chunk of obj.Body) {
        chunks.push(chunk);
      }

      return res.end(Buffer.concat(chunks));
    }

    // Local storage
    const filePath = path.join(RECORDINGS_DIR, room, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).send('Recording not found');
    }

    res.download(filePath, filename);

  } catch (err) {
    console.error('Download recording error:', err);

    if (!res.headersSent) {
      res.status(500).send('Could not download recording');
    }
  }
});
app.get('/recordings-list/:room', async (req, res) => {
  const room = sanitize(req.params.room, 'unknown-room');

  if (!useCloudStorage) {
    const dir = path.join(RECORDINGS_DIR, room);
    if (!fs.existsSync(dir)) return res.json({ files: [] });
    const files = fs.readdirSync(dir).map(f => ({
      name: f,
      url: `/recordings/${room}/${f}`,
      size: fs.statSync(path.join(dir, f)).size
    }));
    return res.json({ files });
  }

  try {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.STORAGE_BUCKET_NAME,
      Prefix: `${room}/`,
    }));
    const files = await Promise.all((list.Contents || []).map(async (obj) => {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: process.env.STORAGE_BUCKET_NAME, Key: obj.Key }),
        { expiresIn: 604800 } // 7 days — the maximum SigV4 presigned URLs allow
      );
      return { name: obj.Key.split('/').pop(), url, size: obj.Size };
    }));
    res.json({ files });
  } catch (err) {
    console.error('Cloud storage list failed:', err.message);
    res.json({ files: [] });
  }
});

// ---- Signaling: WebRTC offer/answer/ICE relay + session controls ----
// Rooms are capped at 2 participants (host + guest) for this MVP.
const rooms = new Map(); // roomId -> Set of socket ids

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, name }) => {
    const members = rooms.get(room) || new Set();
    if (members.size >= 2) {
      socket.emit('room-full');
      return;
    }
    members.add(socket.id);
    rooms.set(room, members);
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name;

    const others = [...members].filter(id => id !== socket.id);
    socket.data.isHost = members.size === 1;
    socket.emit('joined', { selfId: socket.id, isHost: socket.data.isHost });
    others.forEach(id => {
      io.to(id).emit('peer-joined', { peerId: socket.id, name });
      socket.emit('peer-joined', { peerId: id, name: io.sockets.sockets.get(id)?.data?.name });
    });
  });

  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // Lets each browser work out how far its clock is from the server's, so the
  // moments two people's recorders actually started can be compared fairly.
  socket.on('time-sync', (ack) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  // Host-driven synchronized recording control, relayed to everyone in the room.
  socket.on('recording-command', ({ command }) => {
    const room = socket.data.room;
    if (!room || !socket.data.isHost) return;

    if (command === 'start') {
      const previous = activeSessionByRoom.get(room);
      const previousSession = previous && sessions.get(sessionKey(room, previous));
      if (previousSession && previousSession.status === 'recording') setSessionStatus(previousSession, 'incomplete');

      const sessionId = String(Date.now());
      const participants = new Map();
      for (const id of rooms.get(room) || []) {
        const member = io.sockets.sockets.get(id);
        participants.set(id, {
          name: displayName(member?.data?.name, 'Guest'),
          isHost: Boolean(member?.data?.isHost),
        });
      }
      const session = {
        room, sessionId, participants,
        uploads: new Map(),
        status: 'recording',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        waitTimer: null,
      };
      sessions.set(sessionKey(room, sessionId), session);
      activeSessionByRoom.set(room, sessionId);
      io.to(room).emit('recording-command', { command: 'start', sessionId, ts: Date.now() });
    } else if (command === 'stop') {
      const sessionId = activeSessionByRoom.get(room);
      if (!sessionId) return;
      activeSessionByRoom.delete(room);
      const session = sessions.get(sessionKey(room, sessionId));
      if (session) setSessionStatus(session, 'uploading');
      io.to(room).emit('recording-command', { command: 'stop', sessionId, ts: Date.now() });
    }
  });

  socket.on('chat-message', ({ room, name, text }) => {
    io.to(room).emit('chat-message', { name, text, ts: Date.now() });
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room && rooms.has(room)) {
      const members = rooms.get(room);
      members.delete(socket.id);
      if (members.size === 0) {
        rooms.delete(room);
        // Everyone left mid-recording: the recorders stop on their own; now just wait for uploads.
        const sessionId = activeSessionByRoom.get(room);
        activeSessionByRoom.delete(room);
        const session = sessionId && sessions.get(sessionKey(room, sessionId));
        if (session && session.status === 'recording') setSessionStatus(session, 'uploading');
      } else {
        rooms.set(room, members);
      }
      socket.to(room).emit('peer-left', { peerId: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Podcast studio running at http://localhost:${PORT}`);
});
