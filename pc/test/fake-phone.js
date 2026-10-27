'use strict';
// A stand-in for the iPhone app, for testing the PC side on this PC: same protocol, a moving test picture,
// made-up live values, and a test video handed over when "recording" stops. Listens on 127.0.0.1 only.
// Run on its own: node pc/test/fake-phone.js   (then type 127.0.0.1 as the iPhone's address in the PC app)

const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const wire = require('../lib/wire');
const sync = require('../lib/sync');

const out = path.join(__dirname, 'out');

/** Test pictures (JPEG) for the preview, horizontal and vertical, made once with ffmpeg. */
function makeFrames() {
  const ffmpeg = sync.findFfmpeg();
  const frames = {};
  for (const [shape, size] of [['horizontal', '960x540'], ['vertical', '540x960']]) {
    const dir = path.join(out, `frames-${shape}`);
    if (!fs.existsSync(path.join(dir, 'f060.jpg'))) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=2`,
        '-q:v', '5', path.join(dir, 'f%03d.jpg')]);
    }
    frames[shape] = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).sort().map(f => fs.readFileSync(path.join(dir, f)));
  }
  return frames;
}

function startFakePhone({ port = wire.PORT, clockOffset = 5000, video = null, videoDuration = 10, startDelay = 1.2345 } = {}) {
  const frames = makeFrames();
  const settings = {
    position: 'back', lens: 'auto', resolution: '4k', fps: 30, hdr: false, codec: 'hevc', quality: 'standard', orientation: 'horizontal',
    stabilization: 'off', look: 'none', torch: 0, zoom: 1,
    focus: { mode: 'auto', lens: 0.5 }, exposure: { mode: 'auto', bias: 0, iso: 200, shutter: 0.02 },
    wb: { mode: 'auto', temp: 5000, tint: 0 }, micInput: '', micSource: '', previewSize: 960, previewQuality: 0.6,
  };
  const caps = {
    positions: ['back', 'front'], lenses: ['auto', 'ultrawide', 'wide', 'tele'],
    zoom: { min: 0.5, max: 25, presets: [0.5, 1, 2, 5], switches: [1, 5] },
    fps: { '4k': [24, 25, 30, 50, 60, 100, 120], '1080p': [24, 25, 30, 50, 60, 100, 120] },
    fpsHDR: { '4k': [24, 25, 30, 50, 60], '1080p': [24, 25, 30, 50, 60] },
    iso: { min: 32, max: 3072 }, shutter: { min: 1 / 46000, max: 1 / 30 }, bias: { min: -4, max: 4 },
    focusManual: true, focusPoint: true, exposureManual: true, exposurePoint: true, wbManual: true, torch: true,
    stabilization: ['off', 'standard', 'cinematic', 'extended'],
    looks: [['none', 'Natural'], ['warm', 'Warm'], ['cool', 'Cool'], ['vivid', 'Vivid'], ['soft', 'Soft'], ['mono', 'Mono'],
      ['noir', 'Noir'], ['fade', 'Fade'], ['chrome', 'Chrome']].map(([id, name]) => ({ id, name })),
    mics: [{ id: 'builtin', name: 'iPhone Microphone', builtIn: true, sources: [{ id: '1', name: 'Bottom' }, { id: '2', name: 'Front' }, { id: '3', name: 'Back' }] }],
    hasMic: true,
  };
  const files = new Map(); // name -> path
  let rec = null;          // { name, startWall }
  const peers = new Set();
  const log = [];
  const phoneNow = () => Date.now() + clockOffset;

  function state() {
    return {
      op: 'state', settings, caps, status: 'running', angle: settings.orientation === 'vertical' ? 90 : 0,
      mismatch: false, physical: settings.orientation === 'vertical' ? 'upright' : 'sideways', looksOnRecording: !settings.hdr && settings.fps <= 60,
      bitrate: settings.resolution === '4k' ? 48e6 : 16e6,
      format: `${settings.resolution === '4k' ? '3840×2160' : '1920×1080'} · ${settings.fps} fps · ${settings.hdr ? 'HDR (HLG, 10-bit)' : 'SDR'}`,
      recording: { active: !!rec, name: rec ? rec.name : '', startWall: rec ? rec.startWall : 0, elapsed: 0, bitrate: 48e6 },
      phone: { model: 'iPhone 16 Pro (fake)', battery: 0.82, charging: false, thermal: 'ok', free: 112e9, address: '127.0.0.1', port },
    };
  }
  const send = (sock, obj) => sock.write(wire.jsonFrame(obj));
  const broadcast = obj => { for (const p of peers) send(p, obj); };
  const fileList = () => ({ op: 'files', list: [...files].map(([name, f]) => ({ name, size: fs.statSync(f).size })) });

  const server = net.createServer(sock => {
    sock.setNoDelay(true);
    const reader = new wire.FrameReader((type, payload) => {
      if (type !== wire.JSON_T) return;
      const m = JSON.parse(payload.toString('utf8'));
      log.push(m.op);
      switch (m.op) {
        case 'hello':
          peers.add(sock);
          send(sock, { op: 'hello', app: 'CameraStudio', version: 1, model: 'iPhone 16 Pro (fake)', port, usb: false, build: 'fake' });
          send(sock, state());
          send(sock, fileList());
          break;
        case 'ping': send(sock, { op: 'pong', t0: m.t0, phone: phoneNow() }); break;
        case 'state': send(sock, state()); break;
        case 'files': send(sock, fileList()); break;
        case 'set':
          for (const [k, v] of Object.entries(m.changes || {})) {
            if (v && typeof v === 'object' && settings[k] && typeof settings[k] === 'object') Object.assign(settings[k], v);
            else if (k in settings) settings[k] = v;
          }
          if (settings.hdr) settings.codec = 'hevc';
          broadcast(state());
          break;
        case 'zoom': settings.zoom = Math.max(0.5, Math.min(25, m.value)); broadcast(state()); break;
        case 'focusAt': settings.focus.mode = 'auto'; broadcast(state()); break;
        case 'record': {
          if (rec) break;
          const d = new Date();
          const name = `Camera Studio ${d.toISOString().slice(0, 10)} at ${d.toTimeString().slice(0, 8).replace(/:/g, '.')}.mov`;
          rec = { name, startWall: phoneNow() + 300, at: Date.now() + 300 };
          setTimeout(() => { broadcast({ op: 'recStarted', name, startWall: rec.startWall }); broadcast(state()); }, 300);
          break;
        }
        case 'stop': {
          if (!rec) break;
          const r = rec;
          rec = null;
          setTimeout(() => {
            const file = path.join(out, `fake-${Date.now()}.mov`);
            if (video) fs.copyFileSync(video, file);
            else execFileSync(sync.findFfmpeg(), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3',
              '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error',
              '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest', file]);
            files.set(r.name, file);
            broadcast({ op: 'recStopped', name: r.name, codec: 'hevc', fps: settings.fps, hdr: settings.hdr, width: 3840, height: 2160,
              rotation: 0, look: 'none', bitrate: 48e6, duration: video ? videoDuration : 3, frames: 90, dropped: 0,
              startWall: r.startWall, size: fs.statSync(file).size });
            broadcast(fileList());
            broadcast(state());
            setTimeout(() => broadcast({ op: 'photos', name: r.name, ok: true, message: 'Saved to Photos' }), 200);
          }, 400);
          break;
        }
        case 'received':
          files.delete(m.name);
          broadcast(fileList());
          break;
        case 'download': {
          const f = files.get(m.name);
          if (!f) { send(sock, { op: 'fileError', message: 'not here' }); break; }
          const size = fs.statSync(f).size;
          const offset = Math.min(m.offset || 0, size);
          send(sock, { op: 'file', name: m.name, size, offset });
          const stream = fs.createReadStream(f, { start: offset, highWaterMark: 1 << 20 });
          stream.on('data', chunk => { if (!sock.write(wire.frame(wire.CHUNK_T, chunk))) { stream.pause(); sock.once('drain', () => stream.resume()); } });
          stream.on('end', () => send(sock, { op: 'eof' }));
          break;
        }
      }
    });
    sock.on('data', d => reader.push(d));
    sock.on('error', () => {});
    sock.on('close', () => peers.delete(sock));
  });

  let n = 0;
  const previewTimer = setInterval(() => {
    const list = frames[settings.orientation] || frames.horizontal;
    const jpeg = list[n++ % list.length];
    for (const p of peers) if (p.writableLength < 400000) p.write(wire.frame(wire.JPEG_T, jpeg));
  }, 33);
  let t = 0;
  const liveTimer = setInterval(() => {
    t += 0.1;
    const talk = Math.max(0, Math.sin(t * 2.3) * Math.sin(t * 0.7));
    broadcast({
      op: 'live', zoom: settings.zoom, iso: settings.exposure.mode === 'manual' ? settings.exposure.iso : 160 + 40 * Math.sin(t / 3),
      shutter: settings.exposure.mode === 'manual' ? settings.exposure.shutter : 1 / 50, lens: settings.focus.mode === 'manual' ? settings.focus.lens : 0.42,
      offset: 0, temp: settings.wb.mode === 'manual' ? settings.wb.temp : 4850, tint: settings.wb.mode === 'manual' ? settings.wb.tint : 3, focusing: false, pressure: 'ok',
      mic: { avg: -50 + talk * 32, peak: -44 + talk * 34 },
      rec: { active: !!rec, elapsed: rec ? (Date.now() - rec.at) / 1000 : 0 },
      phone: { model: 'iPhone 16 Pro (fake)', battery: 0.82, charging: false, thermal: 'ok', free: 112e9, address: '127.0.0.1', port },
    });
  }, 100);

  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => resolve({
      log, files, settings,
      close() { clearInterval(previewTimer); clearInterval(liveTimer); for (const p of peers) p.destroy(); server.close(); },
    }));
  });
}

module.exports = { startFakePhone };

if (require.main === module) {
  startFakePhone().then(() => console.log(`Fake iPhone listening on 127.0.0.1:${wire.PORT}. Type 127.0.0.1 in the PC app to connect.`));
}
