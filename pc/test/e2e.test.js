'use strict';
// The whole PC side against the fake iPhone: connect by address, record with the "PC microphone" (fed from a test
// WAV, the way the page sends it), stop, copy the video, line the sound up and check the final file.
// Needs the files from sync.test.js (run that first). Run: node pc/test/e2e.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const sync = require('../lib/sync');
const { startFakePhone } = require('./fake-phone');

const out = path.join(__dirname, 'out');
const PORT = 5899;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-home-'));
const videos = path.join(out, 'videos');
fs.rmSync(videos, { recursive: true, force: true });

function request(method, url, body, raw) {
  return new Promise((resolve, reject) => {
    const data = raw || Buffer.from(JSON.stringify(body || {}));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method,
      headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'X-Camera-Studio': '1', 'Content-Length': data.length } }, res => {
      let s = '';
      res.on('data', d => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(s); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** Follows the page's live updates; `until(check)` resolves when a check passes. */
function events() {
  let latest = null;
  const waiters = [];
  const evs = [];
  http.get({ host: '127.0.0.1', port: PORT, path: '/events' }, res => {
    res.on('error', () => {});
    let buf = '';
    res.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = (block.match(/^event: (.*)$/m) || [])[1];
        const data = (block.match(/^data: (.*)$/m) || [])[1];
        if (!ev || !data) continue;
        const obj = JSON.parse(data);
        if (ev === 'state') latest = obj;
        if (ev === 'event' || ev === 'toast') evs.push(obj);
        for (const w of [...waiters]) if (latest && w.check(latest)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(latest); }
      }
    });
  }).on('error', () => {});
  return {
    evs,
    until(check, ms = 30000, what = 'state') {
      if (latest && check(latest)) return Promise.resolve(latest);
      return new Promise((resolve, reject) => {
        const w = { check, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error('timed out waiting for ' + what + '; last: ' + JSON.stringify(latest && { phone: latest.phone, takes: latest.takes }))), ms);
      });
    },
  };
}

(async () => {
  const video = path.join(out, 'phone-rot.mov');
  const wav = path.join(out, 'pc.wav');
  assert(fs.existsSync(video) && fs.existsSync(wav), 'run sync.test.js first');
  const fake = await startFakePhone({ video, videoDuration: 120 });
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--no-window', '--stay'], {
    env: { ...process.env, CAMERA_STUDIO_PORT: String(PORT), CAMERA_STUDIO_HOME: home, CAMERA_STUDIO_OUT: videos },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });
  try {
    await new Promise(r => setTimeout(r, 800));
    const ev = events();
    const r = await request('POST', '/api/connect', { address: '127.0.0.1' });
    assert(r.ok, 'connect refused');
    const s1 = await ev.until(s => s.phone.status === 'connected' && s.camera, 20000, 'connected');
    console.log('connected:', s1.phone.detail);

    // a setting goes through to the phone and comes back
    await request('POST', '/api/cmd', { op: 'set', changes: { fps: 25, exposure: { bias: 0.5 } } });
    await ev.until(s => s.camera.settings.fps === 25 && s.camera.settings.exposure.bias === 0.5, 5000, 'fps 25');
    console.log('settings round trip ok');

    // let a few pings measure the clock difference
    await new Promise(r => setTimeout(r, 2500));

    // "PC microphone": start, record, send the WAV in 0.1 s blocks, stop
    const start = await request('POST', '/api/pcaudio/start', { sampleRate: 48000 });
    assert(start.id);
    const pcStart = Date.now();
    await request('POST', '/api/record', { pcAudioId: start.id });
    await ev.until(s => s.takes.some(t => t.status === 'recording'), 5000, 'recording');
    // The fake phone's video starts 300 ms after "record"; the WAV's talk starts 1.2345 s in.
    // So say the PC sound started 1.2345 - 0.3 s before the "record" press (plus 150 ms of clock error).
    const pcStartWall = pcStart + 300 - 1234.5 + 150;
    const raw = fs.readFileSync(wav);
    const dataAt = raw.indexOf(Buffer.from('data')) + 8;
    const samples = raw.subarray(dataAt);
    const block = 4800 * 4;
    for (let i = 0; i < samples.length; i += block) {
      await request('POST', `/api/pcaudio/chunk?id=${start.id}`, null, samples.subarray(i, i + block));
    }
    await request('POST', '/api/stop', {});
    await request('POST', '/api/pcaudio/stop', { id: start.id, startWall: pcStartWall });
    const done = await ev.until(s => s.takes.length && s.takes[0].status === 'ready', 90000, 'ready');
    const take = done.takes[0];
    console.log('take:', take.name, '|', take.note || take.error);
    assert(!take.error, take.error);
    assert(/exactly/.test(take.note), 'not lined up by sound');
    assert(fake.log.includes('received'), 'phone was not told the copy arrived');

    const final = path.join(videos, take.name);
    assert(fs.existsSync(final), 'final video missing');
    const originals = fs.readdirSync(path.join(videos, 'Originals'));
    console.log('Originals:', originals.join(' | '));
    assert(originals.some(f => f.includes('(iPhone sound)')) && originals.some(f => f.includes('(PC mic)')));

    const ffmpeg = sync.findFfmpeg();
    for (const at of [5, 100]) {
      const a = await sync.decode(ffmpeg, final, at, 4, 8000);
      const b = await sync.decode(ffmpeg, video, at - 0.5, 5, 8000);
      const { lag } = sync.locate(b, a, 8000);
      const err = (lag / 8000 - 0.5) * 1000;
      console.log(`final video at ${at}s: PC sound ${err.toFixed(2)} ms from the picture's own sound`);
      assert(Math.abs(err) < 3, 'not in sync');
    }
    console.log('e2e test passed');
  } catch (e) {
    console.error(e.message);
    console.error('--- server log ---\n' + serverLog.slice(-3000));
    process.exitCode = 1;
  } finally {
    server.kill();
    fake.close();
    setTimeout(() => process.exit(), 300);
  }
})();
