const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');
require('dotenv').config();
const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

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
    endpoint: process.env.STORAGE_ENDPOINT,
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
  return (value || fallback).replace(/[^a-zA-Z0-9-_]/g, '');
}

// ---- Upload handling: each participant uploads their own local recording ----
const storage = useCloudStorage
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => {
        const room = sanitize(req.body.room, 'unknown-room');
        const dir = path.join(RECORDINGS_DIR, room);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const name = sanitize(req.body.participant, 'guest');
        const track = sanitize(req.body.track, 'av');
        cb(null, `${name}-${track}-${Date.now()}.webm`);
      }
    });
const upload = multer({ storage, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

app.post('/upload', upload.single('recording'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file received' });

  if (!useCloudStorage) {
    return res.json({ ok: true, filename: req.file.filename });
  }

  const room = sanitize(req.body.room, 'unknown-room');
  const name = sanitize(req.body.participant, 'guest');
  const track = sanitize(req.body.track, 'av');
  const key = `${room}/${name}-${track}-${Date.now()}.webm`;

  try {
    await s3.send(new PutObjectCommand({
      Bucket: process.env.STORAGE_BUCKET_NAME,
      Key: key,
      Body: req.file.buffer,
      ContentType: 'video/webm',
    }));
    res.json({ ok: true, filename: key });
  } catch (err) {
    console.error('Cloud storage upload failed:', err.message);
    res.status(500).json({ ok: false, error: 'Upload to storage failed' });
  }
});


// Force recordings to download instead of opening in the browser.
app.get('/download-recording/:room/:filename', async (req, res) => {
  try {
    const room = String(req.params.room || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const filename = String(req.params.filename || '');
    if (!room || !filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).send('Invalid recording path');
    }

    const key = `recordings/${room}/${filename}`;

    // S3-compatible storage: fetch the object and force attachment disposition.
    if (s3Client && GetObjectCommand) {
      const obj = await s3Client.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
      }));

      res.setHeader('Content-Type', obj.ContentType || 'video/webm');
      res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
      if (obj.ContentLength != null) res.setHeader('Content-Length', String(obj.ContentLength));
      if (obj.Body?.pipe) return obj.Body.pipe(res);

      const chunks = [];
      for await (const chunk of obj.Body) chunks.push(chunk);
      return res.end(Buffer.concat(chunks));
    }

    // Local storage fallback.
    const filePath = path.join(RECORDINGS_DIR, room, filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Recording not found');

    res.download(filePath, filename);
  } catch (err) {
    console.error('Download recording error:', err);
    res.status(500).send('Could not download recording');
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
    socket.emit('joined', { selfId: socket.id, isHost: members.size === 1 });
    others.forEach(id => {
      io.to(id).emit('peer-joined', { peerId: socket.id, name });
      socket.emit('peer-joined', { peerId: id, name: io.sockets.sockets.get(id)?.data?.name });
    });
  });

  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // Host-driven synchronized recording control, relayed to all peers in room
  socket.on('recording-command', ({ room, command }) => {
    io.to(room).emit('recording-command', { command, ts: Date.now() });
  });

  socket.on('chat-message', ({ room, name, text }) => {
    io.to(room).emit('chat-message', { name, text, ts: Date.now() });
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room && rooms.has(room)) {
      const members = rooms.get(room);
      members.delete(socket.id);
      if (members.size === 0) rooms.delete(room);
      else rooms.set(room, members);
      socket.to(room).emit('peer-left', { peerId: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Podcast studio running at http://localhost:${PORT}`);
});
