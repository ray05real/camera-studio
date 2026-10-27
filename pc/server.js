'use strict';
// Camera Studio for the PC. Started by "Camera Studio.cmd": serves the control page on this PC only
// (http://127.0.0.1:5810), opens it as an app window in Edge, keeps the iPhone connected, copies each video
// to Videos\Camera Studio and, when the PC microphone was used, puts its sound on the video, lined up.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PhoneManager } = require('./lib/phone');
const sync = require('./lib/sync');
const { WavWriter } = require('./lib/wav');

const UI_PORT = Number(process.env.CAMERA_STUDIO_PORT) || 5810;
const UI_DIR = path.join(__dirname, 'ui');
const APP_DIR = process.env.CAMERA_STUDIO_HOME || path.join(process.env.APPDATA || os.homedir(), 'Camera Studio');
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
const LOG_FILE = path.join(APP_DIR, 'camera-studio.log');
const args = process.argv.slice(2);

fs.mkdirSync(APP_DIR, { recursive: true });

// ---------- log & settings ----------

try { if (fs.statSync(LOG_FILE).size > 2e6) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch {}
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

let config = { outDir: path.join(os.homedir(), 'Videos', 'Camera Studio'), lastAddress: '', manualAddress: '' };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {}
if (process.env.CAMERA_STUDIO_OUT) config.outDir = process.env.CAMERA_STUDIO_OUT;
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch {}
}
const originalsDir = () => path.join(config.outDir, 'Originals');
fs.mkdirSync(originalsDir(), { recursive: true });

// ---------- what the page shows ----------

const ffmpeg = sync.findFfmpeg();
log('ffmpeg:', ffmpeg || 'not found');
const app = {
  camera: null,   // the iPhone's last "state" message
  takes: [],      // every video this session: [{ name, status, ... }]
};
const pcAudios = new Map();  // PC microphone recordings by id
let pendingPcAudio = null;   // the PC-mic recording waiting for the next video to start
let copying = false;

const phone = new PhoneManager(config);
phone.busy = () => copying || !!(app.camera && app.camera.recording && app.camera.recording.active);

const clients = new Set();     // the page's live-update streams (Server-Sent Events)
const viewers = new Set();     // the page's preview streams (MJPEG)
let lastFrame = null;

function push(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

let stateTimer = null;
function scheduleState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; push('state', snapshot()); }, 60);
}

function snapshot() {
  return {
    phone: {
      status: phone.status,
      detail: phone.detail,
      route: phone.link ? phone.link.route.kind : null,
      host: phone.link && phone.link.route.host,
      usbService: phone.usbService,
    },
    camera: app.camera,
    takes: app.takes.slice(-12).map(t => ({
      name: t.name, status: t.status, note: t.note || '', error: t.error || '', progress: t.progress || 0,
      size: t.size || 0, final: t.final || '', pcMic: !!t.pcAudioId, photos: t.photos || '', duration: t.duration || 0,
    })).reverse(),
    ffmpeg: !!ffmpeg,
    outDir: config.outDir,
    address: config.lastAddress,
  };
}

function toast(text, kind = 'info') {
  push('toast', { text, kind });
}

function takeFor(name, create = true) {
  let t = app.takes.find(x => x.name === name);
  if (!t && create) {
    t = { name, status: 'on the iPhone', copied: false };
    app.takes.push(t);
  }
  return t;
}

// ---------- the iPhone ----------

phone.on('status', () => { log('phone:', phone.status, phone.detail); scheduleState(); });
phone.on('remember', address => saveConfig());
phone.on('disconnected', () => { app.camera = null; scheduleState(); push('event', { type: 'disconnected' }); });

phone.on('preview', jpeg => {
  lastFrame = jpeg;
  for (const res of viewers) {
    if (res.writableLength > 1.5e6) continue; // a slow viewer skips pictures instead of falling behind
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    res.write(jpeg);
    res.write('\r\n');
  }
});

phone.on('message', m => {
  switch (m.op) {
    case 'state':
      app.camera = m;
      scheduleState();
      break;
    case 'live':
      push('live', m);
      break;
    case 'recStarted': {
      const t = takeFor(m.name);
      t.status = 'recording';
      t.startWall = m.startWall;               // iPhone clock, ms
      t.clockOffset = phone.clockOffset();     // iPhone clock minus PC clock, ms
      if (pendingPcAudio && pcAudios.has(pendingPcAudio)) {
        t.pcAudioId = pendingPcAudio;
        pcAudios.get(pendingPcAudio).take = m.name;
      }
      pendingPcAudio = null;
      log('recording started', m.name, 'pc mic:', t.pcAudioId || 'no', 'clock offset', t.clockOffset.toFixed(1), 'ms');
      push('event', { type: 'recStarted', name: m.name });
      scheduleState();
      break;
    }
    case 'recStopped': {
      const t = takeFor(m.name);
      t.info = m;
      t.size = m.size;
      t.duration = m.duration;
      t.status = 'waiting to copy';
      if (m.dropped > 0) t.note = `${m.dropped} frame(s) were dropped while recording.`;
      log('recording stopped', m.name, `${(m.size / 1e6).toFixed(1)} MB`, `${m.duration.toFixed(1)} s`, 'dropped', m.dropped);
      push('event', { type: 'recStopped', name: m.name });
      scheduleState();
      copyNext();
      break;
    }
    case 'recFailed':
      log('recording failed:', m.message);
      toast(`Recording failed: ${m.message}`, 'error');
      push('event', { type: 'recFailed', message: m.message });
      if (pendingPcAudio) { discardPcAudio(pendingPcAudio); pendingPcAudio = null; }
      scheduleState();
      break;
    case 'files':
      for (const f of m.list || []) {
        const t = takeFor(f.name);
        if (!t.size) t.size = f.size;
        if (t.status === 'on the iPhone') t.status = 'waiting to copy';
      }
      copyNext();
      scheduleState();
      break;
    case 'photos': {
      const t = takeFor(m.name, false);
      if (t) t.photos = m.ok ? 'saved' : m.message;
      if (!m.ok) toast(m.message, 'warn');
      scheduleState();
      break;
    }
    case 'message':
      toast(m.text);
      break;
  }
});

// ---------- copying videos and adding the PC sound ----------

function uniquePath(file) {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file), base = file.slice(0, -ext.length);
  for (let i = 2; ; i++) { const f = `${base} (${i})${ext}`; if (!fs.existsSync(f)) return f; }
}

async function copyNext() {
  if (copying || !phone.link) return;
  const t = app.takes.find(x => x.status === 'waiting to copy' && !(x.retryAt > Date.now()));
  if (!t) return;
  copying = true;
  t.status = 'copying';
  t.error = '';
  scheduleState();
  const part = path.join(config.outDir, t.name + '.part');
  let lastPush = 0;
  try {
    fs.mkdirSync(config.outDir, { recursive: true });
    log('copying', t.name);
    const size = await phone.download(t.name, part, (done, total) => {
      t.progress = total ? done / total : 0;
      if (Date.now() - lastPush > 250) { lastPush = Date.now(); scheduleState(); }
    });
    t.size = size;
    t.copied = true;
    phone.send({ op: 'received', name: t.name });
    log('copied', t.name, `${(size / 1e6).toFixed(1)} MB`);
    if (t.pcAudioId) {
      t.phoneFile = uniquePath(path.join(originalsDir(), t.name.replace(/\.mov$/i, '') + ' (iPhone sound).mov'));
      fs.renameSync(part, t.phoneFile);
      t.status = 'waiting for the PC sound';
      finishWithPcSound(t);
    } else {
      t.final = uniquePath(path.join(config.outDir, t.name));
      fs.renameSync(part, t.final);
      t.status = 'ready';
      toast(`Saved: ${path.basename(t.final)}`, 'ok');
    }
  } catch (e) {
    log('copy failed', t.name, e.message);
    t.status = 'waiting to copy';
    t.error = `Copy paused: ${e.message}. It carries on by itself.`;
    t.retryAt = Date.now() + 4000;
    setTimeout(copyNext, 4500);
  } finally {
    copying = false;
    scheduleState();
    setImmediate(copyNext);
  }
}

async function finishWithPcSound(t) {
  const rec = pcAudios.get(t.pcAudioId);
  if (!rec || !rec.done || !t.copied || t.syncing) return;
  t.syncing = true;
  const base = t.name.replace(/\.mov$/i, '');
  try {
    const wav = uniquePath(path.join(originalsDir(), `${base} (PC mic).wav`));
    fs.renameSync(rec.file, wav);
    rec.file = wav;
    t.final = uniquePath(path.join(config.outDir, t.name));
    if (!ffmpeg) {
      fs.copyFileSync(t.phoneFile, t.final);
      t.status = 'ready';
      t.note = 'ffmpeg is missing, so this file has the iPhone sound. The PC sound is in the Originals folder.';
      return;
    }
    t.status = 'lining up the PC sound';
    scheduleState();
    const videoDuration = (t.info && t.info.duration) || (await sync.duration(ffmpeg, t.phoneFile));
    const videoStartPc = t.startWall - (t.clockOffset || 0);
    const coarse = (videoStartPc - rec.startWall) / 1000;
    const r = await sync.findOffset({ ffmpeg, video: t.phoneFile, wav, coarse, videoDuration });
    log('pc sound', t.name, 'clock guess', coarse.toFixed(3), 's, found', r.offset.toFixed(4), 's by', r.method,
      'score', r.score.toFixed(1), 'rate', r.rate.toFixed(7));
    t.status = 'adding the PC sound';
    scheduleState();
    const tmp = t.final.replace(/\.mov$/i, '') + '.tmp.mov';
    await sync.merge({ ffmpeg, video: t.phoneFile, wav, offset: r.offset, rate: r.rate, duration: videoDuration, out: tmp,
      codec: (t.info && t.info.codec) || 'hevc' });
    fs.renameSync(tmp, t.final);
    t.status = 'ready';
    t.note = r.method === 'sound'
      ? 'PC sound lined up exactly (matched against the iPhone\'s own sound).'
      : 'PC sound lined up by the clocks only (close, but check it): the two recordings didn\'t match clearly. A clap at the start helps.';
    toast(`Saved with the PC sound: ${path.basename(t.final)}`, 'ok');
  } catch (e) {
    log('pc sound failed', t.name, e.message);
    try { if (!fs.existsSync(t.final)) fs.copyFileSync(t.phoneFile, t.final); } catch {}
    t.status = 'ready';
    t.error = `The PC sound couldn't be added (${e.message}), so this file has the iPhone sound.`;
  } finally {
    t.syncing = false;
    scheduleState();
  }
}

function discardPcAudio(id) {
  const rec = pcAudios.get(id);
  if (!rec) return;
  try { rec.writer.close(); } catch {}
  try { fs.unlinkSync(rec.file); } catch {}
  pcAudios.delete(id);
}

// ---------- the control page ----------

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function readBody(req, limit = 4e6) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', d => { size += d.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/** Only this PC's own page may use the app (not other websites open in the browser). */
function allowed(req) {
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (req.method === 'POST' && req.headers['x-camera-studio'] !== '1') return false;
  return true;
}

const phoneOps = new Set(['set', 'zoom', 'focusAt', 'countdown', 'cancelCountdown', 'state']);

async function api(req, res, url) {
  const route = url.pathname;
  if (route === '/api/ping') return json(res, 200, { app: 'camera-studio' });
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  if (route === '/api/pcaudio/chunk') {
    const rec = pcAudios.get(url.searchParams.get('id'));
    const body = await readBody(req);
    if (!rec || rec.done) return json(res, 404, { error: 'no such recording' });
    rec.writer.write(body);
    return json(res, 200, { ok: true });
  }

  const body = JSON.parse((await readBody(req, 1e5)).toString('utf8') || '{}');
  switch (route) {
    case '/api/cmd':
      if (!phoneOps.has(body.op)) return json(res, 400, { error: 'unknown command' });
      return json(res, 200, { ok: phone.send(body) });
    case '/api/record':
      if (!phone.link) return json(res, 409, { error: 'The iPhone is not connected.' });
      pendingPcAudio = body.pcAudioId || null;
      phone.send({ op: 'record' });
      return json(res, 200, { ok: true });
    case '/api/stop':
      phone.send({ op: 'stop' });
      return json(res, 200, { ok: true });
    case '/api/connect': {
      const address = String(body.address || '').trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return json(res, 400, { error: 'Type the address the iPhone shows, like 192.168.1.23' });
      phone.connectTo(address);
      saveConfig();
      return json(res, 200, { ok: true });
    }
    case '/api/pcaudio/start': {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const file = path.join(originalsDir(), `.pc-mic-${id}.wav`);
      fs.mkdirSync(originalsDir(), { recursive: true });
      const writer = new WavWriter(file, Math.round(body.sampleRate) || 48000, 1);
      pcAudios.set(id, { id, file, writer, done: false, startWall: 0, take: null, created: Date.now() });
      log('pc mic recording', id, body.sampleRate, 'Hz', body.device || '');
      return json(res, 200, { id });
    }
    case '/api/pcaudio/stop': {
      const rec = pcAudios.get(body.id);
      if (!rec) return json(res, 404, { error: 'no such recording' });
      rec.writer.close();
      rec.done = true;
      rec.startWall = Number(body.startWall) || rec.created;
      log('pc mic stopped', rec.id, `${rec.writer.seconds.toFixed(1)} s`, 'take', rec.take || 'none');
      if (!rec.take) {
        // no video started with it (recording failed or was cancelled)
        setTimeout(() => { const r = pcAudios.get(body.id); if (r && !r.take) discardPcAudio(body.id); }, 10000);
      } else {
        const t = takeFor(rec.take, false);
        if (t) finishWithPcSound(t);
      }
      return json(res, 200, { ok: true });
    }
    case '/api/open': {
      if (body.what === 'folder') {
        spawn('explorer.exe', [config.outDir], { detached: true, stdio: 'ignore' }).unref();
      } else {
        const t = app.takes.find(x => x.name === body.name);
        if (t && t.final && fs.existsSync(t.final)) {
          if (body.what === 'play') spawn('cmd', ['/c', 'start', '""', `"${t.final}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
          else spawn('explorer.exe', [`/select,"${t.final}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
        }
      }
      return json(res, 200, { ok: true });
    }
    case '/api/quit':
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 200);
      return;
  }
  return json(res, 404, { error: 'unknown' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!allowed(req)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);

    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      noteClients();
      const keep = setInterval(() => res.write(': keep-alive\n\n'), 15000);
      req.on('close', () => { clearInterval(keep); clients.delete(res); noteClients(); });
      return;
    }

    if (url.pathname === '/preview.mjpg') {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', Connection: 'close' });
      if (lastFrame) {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${lastFrame.length}\r\n\r\n`);
        res.write(lastFrame);
        res.write('\r\n');
      }
      viewers.add(res);
      req.on('close', () => viewers.delete(res));
      return;
    }

    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.join(UI_DIR, path.normalize(file));
    if (!full.startsWith(UI_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    log('request error', url.pathname, e.message);
    if (!res.headersSent) json(res, 500, { error: e.message }); else res.end();
  }
});

// ---------- starting, the app window, quitting ----------

function openWindow(url) {
  if (args.includes('--no-window') || process.env.CAMERA_STUDIO_NO_WINDOW) return;
  const edges = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  const edge = edges.find(e => fs.existsSync(e));
  if (edge) {
    spawn(edge, [`--app=${url}`, '--window-size=1440,930'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  }
}

// Quits by itself a little while after the window is closed (unless a video is still being copied or finished).
let idleTimer = null;
let everConnected = false;
function noteClients() {
  if (clients.size) { everConnected = true; clearTimeout(idleTimer); idleTimer = null; return; }
  if (!everConnected || args.includes('--stay')) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(function check() {
    if (clients.size) return;
    const working = copying || app.takes.some(t => t.syncing || t.status === 'waiting to copy' || t.status === 'copying');
    if (working && phone.link) { idleTimer = setTimeout(check, 5000); return; }
    log('window closed: quitting');
    process.exit(0);
  }, 20000);
}

function listen(port) {
  server.once('error', async e => {
    if (e.code !== 'EADDRINUSE') { log('cannot start:', e.message); process.exit(1); }
    // Already running? Then just open its window again.
    const ours = await new Promise(resolve => {
      http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1000 }, r => {
        let s = '';
        r.on('data', d => { s += d; });
        r.on('end', () => resolve(s.includes('camera-studio')));
      }).on('error', () => resolve(false));
    });
    if (ours) { log('already running: opening its window'); openWindow(`http://127.0.0.1:${port}/`); setTimeout(() => process.exit(0), 500); return; }
    listen(port + 1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    log(`Camera Studio is running at ${url} (videos go to ${config.outDir})`);
    openWindow(url);
    phone.start();
  });
}

listen(UI_PORT);
