// Combines the host's and guest's separate local recordings into ONE
// podcast-style episode: side-by-side video, name plates, both voices mixed.
//
// Because each file was recorded on that person's own computer, the episode
// quality does not depend on how good the call was.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const FONT_PATH = path.join(__dirname, 'assets', 'fonts', 'SpaceGrotesk_600SemiBold.ttf');
const FONT_FAMILY = 'Space Grotesk';
let fontOk = false;
try {
  fontOk = Boolean(GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY));
} catch (err) {
  console.warn('Could not load the name-plate font; plates will use a default font.', err.message);
}

const FPS = 30;
const MAX_MERGE_MS = 90 * 60 * 1000; // give up on a single episode after 90 minutes

// The bundled font only covers Latin text. For other scripts (e.g. Devanagari)
// it would draw empty boxes, so we fall back to a generic label instead.
function plateText(name, fallback) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean || !/^[\p{Script=Latin}\p{N}\p{P}\p{Zs}]+$/u.test(clean)) return fallback;
  return clean;
}

function renderPlate(text, outPath, scale) {
  const fontSize = Math.round(22 * scale);
  const padX = Math.round(18 * scale);
  const height = Math.round(44 * scale);
  const font = `600 ${fontSize}px "${fontOk ? FONT_FAMILY : 'sans-serif'}"`;

  const measure = createCanvas(10, 10).getContext('2d');
  measure.font = font;
  const width = Math.min(Math.ceil(measure.measureText(text).width) + padX * 2, Math.round(600 * scale));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const r = Math.round(6 * scale);
  ctx.fillStyle = 'rgba(20, 23, 28, 0.78)';
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(width, 0, width, height, r);
  ctx.arcTo(width, height, 0, height, r);
  ctx.arcTo(0, height, 0, 0, r);
  ctx.arcTo(0, 0, width, 0, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padX, height / 2 + 1);
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
}

// ffmpeg has no separate probe binary here, so read the stream list from the
// banner it prints for an input file.
function probeStreams(file) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-i', file]);
    let out = '';
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', () => resolve({ video: false, audio: false }));
    p.on('close', () => resolve({
      video: /Stream #\d+:\d+.*: Video:/.test(out),
      audio: /Stream #\d+:\d+.*: Audio:/.test(out),
    }));
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    p.stderr.on('data', (d) => { tail = (tail + d).slice(-4000); });
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('ffmpeg timed out'));
    }, MAX_MERGE_MS);
    p.on('error', (err) => { clearTimeout(timer); reject(err); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${tail.split('\n').slice(-6).join(' | ')}`));
    });
  });
}

/**
 * @param {object} opts
 * @param {{file:string, name:string, delayMs:number}} opts.host   shown on the left
 * @param {{file:string, name:string, delayMs:number}} opts.guest  shown on the right
 * @param {string} opts.outputPath  .mp4 to create
 * @param {number} [opts.height=720]  episode height (720 or 1080); width is 2 x 8/9 of it
 */
async function mergeEpisode({ host, guest, outputPath, height = 720 }) {
  const tileH = height;
  const tileW = Math.round((height * 8) / 9);
  const scale = height / 720;

  const [hostInfo, guestInfo] = await Promise.all([probeStreams(host.file), probeStreams(guest.file)]);
  if (!hostInfo.video || !guestInfo.video) {
    throw new Error('A recording has no video stream, so it cannot be combined');
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-plates-'));
  try {
    const hostPlate = path.join(workDir, 'host.png');
    const guestPlate = path.join(workDir, 'guest.png');
    renderPlate(plateText(host.name, 'Host'), hostPlate, scale);
    renderPlate(plateText(guest.name, 'Guest'), guestPlate, scale);

    const tile = (idx, plateIdx, delayMs, label) => {
      let chain =
        `[${idx}:v]fps=${FPS},scale=${tileW}:${tileH}:force_original_aspect_ratio=increase,` +
        `crop=${tileW}:${tileH},setsar=1,format=yuv420p`;
      // The person who started recording later gets their first frame held
      // until their recording begins, keeping both sides in step.
      if (delayMs > 0) chain += `,tpad=start_duration=${(delayMs / 1000).toFixed(3)}:start_mode=clone`;
      chain += `[${label}0];`;
      chain += `[${label}0][${plateIdx}:v]overlay=x=${Math.round(16 * scale)}:y=main_h-overlay_h-${Math.round(16 * scale)}[${label}]`;
      return chain;
    };

    const filters = [tile(0, 2, host.delayMs, 'l'), tile(1, 3, guest.delayMs, 'r'), '[l][r]hstack=inputs=2[v]'];

    const audioLabels = [];
    [[hostInfo, 0, host.delayMs], [guestInfo, 1, guest.delayMs]].forEach(([info, idx, delayMs]) => {
      if (!info.audio) return;
      const label = `a${idx}`;
      let chain = `[${idx}:a]aresample=48000,aformat=channel_layouts=stereo`;
      if (delayMs > 0) chain += `,adelay=${Math.round(delayMs)}|${Math.round(delayMs)}`;
      filters.push(`${chain}[${label}]`);
      audioLabels.push(label);
    });

    if (audioLabels.length === 2) {
      filters.push('[a0][a1]amix=inputs=2:duration=longest:normalize=0:dropout_transition=0,alimiter=limit=0.95[a]');
    } else if (audioLabels.length === 1) {
      filters.push(`[${audioLabels[0]}]anull[a]`);
    }

    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', host.file, '-i', guest.file, '-i', hostPlate, '-i', guestPlate,
      '-filter_complex', filters.join(';'),
      '-map', '[v]',
      ...(audioLabels.length ? ['-map', '[a]'] : []),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-r', String(FPS),
      ...(audioLabels.length ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']),
      '-movflags', '+faststart',
      outputPath,
    ];

    await runFfmpeg(args);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { mergeEpisode, plateText };
