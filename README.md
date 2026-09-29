# Patchbay — Video Podcast Studio

A browser-based, two-person video podcast studio, Riverside-style: **each
participant records their own camera and mic locally**, on their own
computer, so the recording quality never depends on how good the call
between them was — even a call that drops entirely doesn't lose the
recording. After both people upload their own file, the server combines
them into one podcast-style side-by-side episode with mixed audio. The
live call itself just runs over WebRTC so the two of you can see and hear
each other while you talk — it isn't what gets recorded.

## How it works

- **Live call:** peer-to-peer WebRTC, connected via a small signaling
  server (Socket.io). Video never passes through the server — only
  connection setup messages do.
- **Recording:** when the host clicks "Start recording," every browser in
  the room starts recording its own camera/mic via `MediaRecorder`. When
  the host clicks "Stop," everyone's browser stops and uploads its own
  file — in small chunks, so a shaky connection just retries a piece
  instead of failing the whole upload.
- **Combining:** once both people's recordings have arrived, the server
  uses `ffmpeg` to build one side-by-side `.mp4` episode with name plates
  and mixed audio, correcting for the two recordings not having started
  at the exact same instant. This can take a couple of minutes; the
  Recordings list shows "building your episode…" until it's ready and
  refreshes on its own.
- **Files:** saved under `recordings/<room-code>/` — each person's own
  original recording (`<name>-host-...webm` / `<name>-guest-...webm`) is
  kept alongside the combined episode (`episode-podcast-....mp4`), useful
  if you ever want to edit the two tracks separately. All are visible from
  the "Recordings" screen, reachable any time from the entry screen — not
  just right after leaving a session.

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

## Reliable connections across networks (TURN server)

By default, calls only use a STUN server, which helps two people connect
directly but **fails whenever either side is behind a symmetric or
carrier-grade NAT** — common on mobile networks (this is why a call can
work fine between two tabs on your own Wi-Fi but fail between, say, the US
and someone on a mobile carrier in India). A TURN server relays the call
through a third party when a direct connection isn't possible.

As of this update, the app automatically falls back to a small **public**
TURN service (Metered's "Open Relay") if you haven't configured your own —
so calls should now get through in more cases without you doing anything.
That public service is shared and unmetered by anyone, though, so it's fine
for getting unblocked quickly but not something to depend on for real use.

For reliable production use, get your own TURN credentials (Metered.ca has
a solid free tier) and add these to your `.env`:

```
TURN_URL=turn:standard.relay.metered.ca:80,turn:standard.relay.metered.ca:443,turn:standard.relay.metered.ca:443?transport=tcp
TURN_USERNAME=your-username
TURN_CREDENTIAL=your-credential
```

(Multiple TURN URLs, comma-separated, let the browser try different ports —
including 443, which gets through almost any firewall since it looks like
normal HTTPS traffic.) Restart the server, or add the same three variables
on Render, and it'll use your own TURN credentials automatically instead of
the public fallback.

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
  full-mesh WebRTC setup to an SFU (e.g. mediasoup or LiveKit), and the
  merge step would need to composite more than two tiles.
- **Episode resolution:** the combined episode renders at 720p by default
  to keep build time reasonable on a free host's limited CPU. Set
  `EPISODE_HEIGHT=1080` as an env var for a sharper (slower to build) episode.
- **ffmpeg on your host:** the merge step depends on the `ffmpeg-static`
  package, which downloads a prebuilt `ffmpeg` binary for your platform
  during `npm install`. This works on Render's standard Node environment
  without extra setup; a more locked-down host might block that download.
- **Long episodes on a free host:** building the episode can take a few
  minutes and uses real CPU. Render's free tier can go to sleep after
  inactivity and has limited resources, so a very long episode (well over
  an hour) may need a paid tier to build reliably.
