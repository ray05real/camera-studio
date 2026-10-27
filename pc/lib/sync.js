'use strict';
// Lines up the PC microphone's recording with the iPhone video. The iPhone always records its own sound too, so we
// find where the two recordings match (GCC-PHAT cross-correlation, the same idea editors use to "sync by waveform"),
// then put the PC sound on the iPhone video with ffmpeg (the picture is copied untouched).

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** ffmpeg.exe: next to this app, in the owner's INSTALLERS folder, or on the PATH. */
function findFfmpeg() {
  const candidates = [];
  if (process.env.CAMERA_STUDIO_FFMPEG) candidates.push(process.env.CAMERA_STUDIO_FFMPEG);
  candidates.push(path.join(__dirname, '..', '..', 'tools', 'ffmpeg', 'ffmpeg.exe'));
  for (const docs of [path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'OneDrive', 'Documents')]) {
    const inst = path.join(docs, 'INSTALLERS');
    try {
      for (const d of fs.readdirSync(inst)) {
        if (/ffmpeg/i.test(d)) candidates.push(path.join(inst, d, 'bin', 'ffmpeg.exe'), path.join(inst, d, 'ffmpeg.exe'));
      }
    } catch {}
  }
  for (const c of candidates) {
    try { if (fs.statSync(c).size > 1000000) return c; } catch {}
  }
  try {
    const out = execFileSync('where', ['ffmpeg'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  } catch {}
  return null;
}

function run(ffmpeg, args, { collect = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    const out = [];
    let err = '';
    p.stdout.on('data', d => { if (collect) out.push(d); });
    p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg failed (${code}): ${err.trim().split(/\r?\n/).slice(-3).join(' ')}`));
    });
  });
}

/** Mono samples at `rate` Hz from `start` for `duration` seconds. Sample 0 is exactly `start` in the file. */
async function decode(ffmpeg, file, start, duration, rate = 8000) {
  const buf = await run(ffmpeg, [
    '-v', 'error', '-ss', start.toFixed(4), '-t', duration.toFixed(4), '-i', file,
    '-vn', '-ac', '1', '-af', 'aresample=async=1:first_pts=0', '-ar', String(rate), '-f', 'f32le', '-',
  ], { collect: true });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

async function duration(ffmpeg, file) {
  const ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe.exe');
  try {
    const out = await new Promise((resolve, reject) => {
      const p = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { windowsHide: true });
      let s = '';
      p.stdout.on('data', d => { s += d; });
      p.on('error', reject);
      p.on('close', code => (code === 0 ? resolve(s) : reject(new Error('ffprobe failed'))));
    });
    const d = parseFloat(out);
    return isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}

// ---- FFT (iterative radix-2, in place) ----

function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * Where does `short` sit inside `long`? Returns { lag, score }: long[lag + i] ≈ short[i].
 * Weighted cross-correlation (GCC-PHAT, β 0.8, 150–3800 Hz), robust to the two microphones sounding different.
 * score is how far the best match stands above the rest (over ~8 is a sure match).
 */
function locate(long, short, rate) {
  const span = long.length - short.length;
  if (span < 1 || short.length < rate) return { lag: 0, score: 0 };
  let n = 1;
  while (n < long.length + short.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(long);
  br.set(short);
  fft(ar, ai);
  fft(br, bi);
  const lo = Math.floor((150 / rate) * n), hi = Math.ceil((3800 / rate) * n);
  for (let k = 0; k < n; k++) {
    const f = k <= n / 2 ? k : n - k;
    if (f < lo || f > hi) { ar[k] = 0; ai[k] = 0; continue; }
    const re = ar[k] * br[k] + ai[k] * bi[k];
    const im = ai[k] * br[k] - ar[k] * bi[k];
    const mag = Math.pow(re * re + im * im, 0.4) + 1e-20;
    ar[k] = re / mag;
    ai[k] = im / mag;
  }
  fft(ar, ai, true);
  let best = 0;
  for (let k = 1; k <= span; k++) if (ar[k] > ar[best]) best = k;
  let sum = 0, sum2 = 0, count = 0;
  const guard = Math.round(rate * 0.005);
  for (let k = 0; k <= span; k++) {
    if (Math.abs(k - best) <= guard) continue;
    sum += ar[k]; sum2 += ar[k] * ar[k]; count++;
  }
  const mean = count ? sum / count : 0;
  const sd = count ? Math.sqrt(Math.max(1e-30, sum2 / count - mean * mean)) : 1;
  // sub-sample peak (parabola through the three best points)
  let lag = best;
  if (best > 0 && best < span) {
    const y0 = ar[best - 1], y1 = ar[best], y2 = ar[best + 1];
    const d = y0 - 2 * y1 + y2;
    if (d < 0) lag = best + (0.5 * (y0 - y2)) / d;
  }
  return { lag, score: (ar[best] - mean) / sd };
}

/**
 * Seconds into the PC recording at which the video starts (and a drift factor for long takes).
 * `coarse` is the guess from the two clocks; the search looks 3 s either side of it.
 */
async function findOffset({ ffmpeg, video, wav, coarse, videoDuration }) {
  const rate = 8000;
  const search = 3;
  const window = Math.min(30, Math.max(3, videoDuration - 0.2));
  async function at(videoStart) {
    const v = await decode(ffmpeg, video, videoStart, window, rate);
    const from = Math.max(0, coarse + videoStart - search);
    const w = await decode(ffmpeg, wav, from, window + 2 * search, rate);
    const { lag, score } = locate(w, v, rate);
    return { offset: from + lag / rate - videoStart, score };
  }
  const first = await at(0);
  const result = { offset: first.offset, score: first.score, method: 'sound', rate: 1 };
  if (first.score < 6) {
    return { offset: coarse, score: first.score, method: 'clock', rate: 1 };
  }
  if (videoDuration > 90) {
    const last = await at(videoDuration - window - 0.5).catch(() => null);
    if (last && last.score >= 6) {
      const span = videoDuration - window - 0.5;
      const drift = last.offset - first.offset;
      const r = 1 + drift / span;
      if (Math.abs(drift) > 0.003 && Math.abs(r - 1) < 0.001) result.rate = r;
    }
  }
  return result;
}

/** The iPhone picture (copied as it is) with the PC sound starting `offset` seconds into the WAV. */
async function merge({ ffmpeg, video, wav, offset, rate = 1, duration: dur, out, codec }) {
  const chain = [];
  if (offset >= 0) chain.push(`atrim=start=${offset.toFixed(6)}`, 'asetpts=PTS-STARTPTS');
  else chain.push(`adelay=${Math.round(-offset * 1000)}:all=1`);
  if (rate !== 1) chain.push(`asetrate=48000*${rate.toFixed(9)}`);
  chain.push('aresample=48000', 'apad');
  const args = ['-y', '-v', 'error', '-i', video, '-i', wav,
    '-filter_complex', `[1:a]${chain.join(',')}[a]`,
    '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy'];
  if (codec === 'hevc') args.push('-tag:v', 'hvc1');
  args.push('-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-t', dur.toFixed(4), '-map_metadata', '0', out);
  await run(ffmpeg, args);
}

module.exports = { findFfmpeg, decode, duration, locate, findOffset, merge, fft };
