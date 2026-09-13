# Patchbay — Video Podcast Studio

A browser-based, two-person video podcast studio. Riverside-style: each
participant's camera and mic are recorded **locally in their own browser**
at full quality, then uploaded to the host's server after the session —
so a shaky internet connection during the call never touches the final
recording quality. The live call itself runs over WebRTC just so both of
you can see and hear each other while you talk.

## How it works

- **Live call:** peer-to-peer WebRTC, connected via a small signaling
  server (Socket.io). Video never passes through the server — only
  connection setup messages do.
- **Recording:** when the host clicks "Start recording," every browser
  in the room starts capturing its own local stream via the
  `MediaRecorder` API. When the host stops, each browser uploads its
  own `.webm` file to the server.
- **Files:** saved under `recordings/<room-code>/<name>-av-<timestamp>.webm`,
  downloadable from the "session wrapped" screen at the end.

## Setup

```bash
npm install
npm start
```

Then open `http://localhost:3000` in two browser windows (or two
different machines on the same network, using your machine's local IP
instead of `localhost`), enter the same room code in both, and you're
connected.

By default, recordings save to a local `recordings/` folder — fine for
testing, but most free hosting platforms wipe that folder on every
restart or redeploy. To make recordings durable, connect a free
Cloudflare R2 bucket instead (see below).

## Durable storage (recommended before real use)

By default, recordings save to a local `recordings/` folder — fine for
testing, but most free hosting platforms wipe that folder on every
restart or redeploy. Connect a real bucket instead using the four
`STORAGE_*` environment variables — the app works with any S3-compatible
provider.

### Option A: Backblaze B2 (no credit card required)

1. Sign up at [backblaze.com/sign-up/cloud-storage](https://www.backblaze.com/sign-up/cloud-storage) — no card needed.
2. Go to **B2 Cloud Storage** → **Create a Bucket** (any name, e.g. `podcast-recordings`). Note the region shown next to it (e.g. `us-west-004`).
3. Go to **Application Keys** → **Add a New Application Key**. Give it read/write access to your bucket, then create it. Copy the **keyID** and **applicationKey** immediately — the key is only shown once.
4. Copy `.env.example` to `.env` and fill in:

```
STORAGE_ENDPOINT=https://s3.us-west-004.backblazeb2.com
STORAGE_REGION=us-west-004
STORAGE_ACCESS_KEY_ID=your-keyID
STORAGE_SECRET_ACCESS_KEY=your-applicationKey
STORAGE_BUCKET_NAME=podcast-recordings
```

(Swap `us-west-004` for whatever region your bucket actually shows.)

### Option B: Cloudflare R2 (requires a card, even for the free tier)

1. Create a bucket under **R2 Object Storage** in the Cloudflare dashboard, and an API token with Object Read & Write access.
2. Fill in `.env` with:

```
STORAGE_ENDPOINT=https://<your-account-id>.r2.cloudflarestorage.com
STORAGE_REGION=auto
STORAGE_ACCESS_KEY_ID=your-r2-access-key-id
STORAGE_SECRET_ACCESS_KEY=your-r2-secret-access-key
STORAGE_BUCKET_NAME=podcast-recordings
```

### Either way

- Restart the server — the startup log will say `Storage: cloud bucket` instead of `Storage: local disk` once it's picked up.
- **On Render (or any host):** add the same variables under your service's "Environment" tab instead of a `.env` file — `.env` files aren't committed to Git (see `.gitignore`) and won't exist on the server otherwise.
- Download links for recordings are generated as signed URLs valid for 7 days (the maximum), so download anything you want to keep within that window.

## Notes for going further

- **HTTPS required off localhost.** Browsers only allow camera/mic
  access (`getUserMedia`) on `localhost` or an HTTPS origin. To let a
  remote guest join, deploy behind HTTPS (e.g. a reverse proxy with
  Let's Encrypt, or a host like Render/Railway/Fly.io that provides TLS).
- **More than 2 people:** the signaling server is written for exactly
  one host + one guest. Supporting group sessions means moving from a
  full-mesh WebRTC setup to an SFU (e.g. mediasoup or LiveKit).
- **Separate audio/video tracks:** currently each participant uploads
  one combined `.webm`. If you want separate audio-only and video-only
  files (handy for podcast editing), record two `MediaRecorder`
  instances from separate `MediaStream` objects (one audio-only, one
  video-only) and upload both.
- **Chunked/resumable uploads:** for very long episodes, switch the
  `/upload` endpoint to accept periodic chunks (e.g. every 60 seconds)
  instead of one upload at the end, so a crash mid-recording doesn't
  lose the whole file.
