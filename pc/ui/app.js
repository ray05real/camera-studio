'use strict';
// The control page: shows the iPhone's picture and settings (from the PC app's live updates) and sends changes back.

const $ = id => document.getElementById(id);
let S = { phone: { status: 'searching', detail: 'Starting…' }, camera: null, takes: [] }; // from the PC app
let L = null;            // live values from the iPhone (exposure, levels, battery…), 10 a second
let liveAt = 0;
let serverGone = false;

const prefs = Object.assign({
  audioSource: 'iphone', pcDevice: '', cleanup: false, countdown: true, grid: false, mirror: false, closed: {},
}, (() => { try { return JSON.parse(localStorage.getItem('prefs')) || {}; } catch { return {}; } })());
function savePrefs() { try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch {} }

async function post(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Camera-Studio': '1' }, body: JSON.stringify(body || {}) });
    return await r.json();
  } catch (e) {
    return { error: e.message };
  }
}

const settings = () => S.camera && S.camera.settings;
const caps = () => (S.camera && S.camera.caps) || {};
const connected = () => S.phone.status === 'connected' && !!S.camera;

// ---------- live updates from the PC app ----------

function listen() {
  const es = new EventSource('/events');
  es.addEventListener('state', e => { serverGone = false; S = JSON.parse(e.data); render(); });
  es.addEventListener('live', e => { L = JSON.parse(e.data); liveAt = performance.now(); renderLive(); });
  es.addEventListener('toast', e => { const t = JSON.parse(e.data); toast(t.text, t.kind); });
  es.addEventListener('event', e => onEvent(JSON.parse(e.data)));
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) { serverGone = true; render(); setTimeout(listen, 2000); }
    else { serverGone = true; render(); }
  };
}

function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 5500);
}

// ---------- changing settings ----------

function set(changes) {
  const s = settings();
  if (!s) return;
  for (const [k, v] of Object.entries(changes)) {
    if (v && typeof v === 'object') Object.assign(s[k], v); else s[k] = v;
  }
  render();
  post('/api/cmd', { op: 'set', changes });
}

function getPath(path) {
  const s = settings();
  if (!s) return undefined;
  const [a, b] = path.split('.');
  return b ? s[a][b] : s[a];
}

function setPath(path, value) {
  const [a, b] = path.split('.');
  set(b ? { [a]: { [b]: value } } : { [a]: value });
}

function throttle(fn, ms) {
  let last = 0, timer = null, pending = null;
  return (...args) => {
    pending = args;
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); return; }
    if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); fn(...pending); }, ms - (now - last));
  };
}

// While a slider is held, incoming updates don't move it back.
const held = new Set();
function holdable(el) {
  el.addEventListener('pointerdown', () => held.add(el.id));
  const release = () => setTimeout(() => held.delete(el.id), 600);
  el.addEventListener('pointerup', release);
  el.addEventListener('change', release);
  el.addEventListener('keydown', () => { held.add(el.id); release(); });
}

// the segmented buttons that map straight to a setting
document.querySelectorAll('.seg[data-key]').forEach(seg => {
  seg.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled || !settings()) return;
    let v = b.dataset.v;
    if (/^\d+$/.test(v)) v = Number(v);
    const key = seg.dataset.key;
    // switching to manual starts from what the camera is doing now
    if (key === 'exposure.mode' && v === 'manual' && L) {
      set({ exposure: { mode: 'manual', iso: L.iso, shutter: nearestShutter(L.shutter) } });
    } else if (key === 'wb.mode' && v === 'manual' && L) {
      set({ wb: { mode: 'manual', temp: Math.round(L.temp / 50) * 50, tint: Math.round(L.tint) } });
    } else if (key === 'focus.mode' && v === 'manual' && L) {
      set({ focus: { mode: 'manual', lens: L.lens } });
    } else {
      setPath(key, v);
    }
  });
});

function renderSeg(seg, value) {
  seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', String(b.dataset.v) === String(value)));
}

function chips(container, items, current, onPick) {
  const key = JSON.stringify(items);
  if (container.dataset.items !== key) {
    container.dataset.items = key;
    container.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.dataset.v = it.v;
      b.textContent = it.label;
      if (it.title) b.title = it.title;
      b.addEventListener('click', () => onPick(it.v));
      container.appendChild(b);
    }
  }
  [...container.children].forEach((b, i) => {
    b.classList.toggle('on', String(items[i].v) === String(current));
    b.disabled = !!items[i].disabled;
  });
}

// ---------- zoom ----------

const zoomRange = () => (caps().zoom || { min: 1, max: 10, presets: [1] });
const zoomToPos = z => { const { min, max } = zoomRange(); return (1000 * Math.log(z / min)) / Math.log(max / min); };
const posToZoom = p => { const { min, max } = zoomRange(); return min * Math.pow(max / min, p / 1000); };
const fmtZoom = z => (z < 0.95 ? z.toFixed(1) : z < 9.95 ? (Math.round(z * 10) / 10).toString() : Math.round(z).toString()) + '×';
const sendZoom = throttle((value, smooth) => post('/api/cmd', { op: 'zoom', value, smooth }), 50);
holdable($('zoomSlider'));
$('zoomSlider').addEventListener('input', e => {
  const z = posToZoom(+e.target.value);
  $('zoomReadout').textContent = fmtZoom(z);
  sendZoom(z, false);
});

// ---------- focus, exposure, white balance ----------

holdable($('focusSlider'));
const sendFocus = throttle(lens => set({ focus: { mode: 'manual', lens } }), 60);
$('focusSlider').addEventListener('input', e => sendFocus(+e.target.value / 1000));

holdable($('biasSlider'));
const sendBias = throttle(bias => set({ exposure: { bias } }), 60);
$('biasSlider').addEventListener('input', e => {
  const b = +e.target.value / 10;
  $('biasReadout').textContent = fmtEV(b);
  sendBias(b);
});
$('biasReset').addEventListener('click', () => set({ exposure: { bias: 0 } }));
const fmtEV = b => `${b > 0 ? '+' : ''}${b.toFixed(1)} EV`;

holdable($('isoSlider'));
const isoRange = () => caps().iso || { min: 25, max: 3200 };
const isoToPos = v => { const { min, max } = isoRange(); return (1000 * Math.log(v / min)) / Math.log(max / min); };
const posToIso = p => { const { min, max } = isoRange(); return Math.round(min * Math.pow(max / min, p / 1000)); };
const sendIso = throttle(iso => set({ exposure: { mode: 'manual', iso } }), 60);
$('isoSlider').addEventListener('input', e => {
  const iso = posToIso(+e.target.value);
  $('isoReadout').textContent = `ISO ${iso}`;
  sendIso(iso);
});

const SHUTTERS = [8000, 6400, 5000, 4000, 3200, 2500, 2000, 1600, 1250, 1000, 800, 640, 500, 400, 320, 250, 240, 200, 160,
  125, 120, 100, 96, 60, 50, 48, 30, 25, 24];
function shutterList() {
  const c = caps().shutter || { min: 1 / 8000, max: 1 / 30 };
  const list = SHUTTERS.map(d => 1 / d).filter(s => s >= c.min * 0.999 && s <= c.max * 1.001);
  return list.length ? list : [c.max];
}
function nearestShutter(s) {
  const list = shutterList();
  return list.reduce((a, b) => (Math.abs(Math.log(b / s)) < Math.abs(Math.log(a / s)) ? b : a), list[0]);
}
const fmtShutter = s => (s >= 0.3 ? `${s.toFixed(1)} s` : `1/${Math.round(1 / s)}`);
holdable($('shutterSlider'));
const sendShutter = throttle(shutter => set({ exposure: { mode: 'manual', shutter } }), 60);
$('shutterSlider').addEventListener('input', e => {
  const s = shutterList()[+e.target.value];
  $('shutterReadout').textContent = fmtShutter(s);
  sendShutter(s);
});
$('shutter180').addEventListener('click', () => {
  const fps = settings() ? settings().fps : 25;
  set({ exposure: { mode: 'manual', shutter: nearestShutter(1 / (2 * fps)), iso: (L && L.iso) || 200 } });
});

holdable($('tempSlider'));
const sendTemp = throttle(temp => set({ wb: { mode: 'manual', temp } }), 60);
$('tempSlider').addEventListener('input', e => { $('tempReadout').textContent = `${e.target.value} K`; sendTemp(+e.target.value); });
holdable($('tintSlider'));
const sendTint = throttle(tint => set({ wb: { mode: 'manual', tint } }), 60);
$('tintSlider').addEventListener('input', e => { $('tintReadout').textContent = fmtTint(+e.target.value); sendTint(+e.target.value); });
const fmtTint = t => (t === 0 ? '0' : t > 0 ? `+${t} pink` : `${t} green`);
$('wbPresets').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) set({ wb: { mode: 'manual', temp: +b.dataset.k, tint: 0 } });
});

// ---------- video, light, look ----------

$('hdrToggle').addEventListener('change', e => set({ hdr: e.target.checked }));
$('torchToggle').addEventListener('change', e => set({ torch: e.target.checked ? Math.max(0.05, +$('torchSlider').value / 100) : 0 }));
holdable($('torchSlider'));
const sendTorch = throttle(torch => set({ torch }), 80);
$('torchSlider').addEventListener('input', e => sendTorch(+e.target.value / 100));

// ---------- preview, picture taps ----------

const img = $('preview');
function startPreview() { img.src = `/preview.mjpg?t=${Date.now()}`; }
img.addEventListener('error', () => setTimeout(startPreview, 1500));
startPreview();

function imageRect() {
  const box = $('previewBox').getBoundingClientRect();
  let w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) {
    const vertical = settings() && settings().orientation === 'vertical';
    w = vertical ? 9 : 16; h = vertical ? 16 : 9;
  }
  const scale = Math.min(box.width / w, box.height / h);
  const dw = w * scale, dh = h * scale;
  return { left: (box.width - dw) / 2, top: (box.height - dh) / 2, width: dw, height: dh, box };
}
let lastRect = '';
function layoutOverlay() {
  const r = imageRect();
  const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
  if (key === lastRect) return;
  lastRect = key;
  Object.assign($('imgOverlay').style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
}
new ResizeObserver(layoutOverlay).observe($('previewBox'));
setInterval(layoutOverlay, 400);

let focusTimer = null;
img.addEventListener('click', e => {
  if (!connected()) return;
  const r = imageRect();
  let x = (e.clientX - r.box.left - r.left) / r.width;
  const y = (e.clientY - r.box.top - r.top) / r.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  const mark = $('focusMark');
  mark.style.left = `${x * 100}%`;
  mark.style.top = `${y * 100}%`;
  mark.classList.remove('show');
  void mark.offsetWidth;
  mark.classList.add('show');
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => mark.classList.remove('show'), 1600);
  if (prefs.mirror) x = 1 - x;
  post('/api/cmd', { op: 'focusAt', x, y });
});

$('gridToggle').addEventListener('change', e => { prefs.grid = e.target.checked; savePrefs(); render(); });
$('mirrorToggle').addEventListener('change', e => { prefs.mirror = e.target.checked; savePrefs(); render(); });
$('countdownToggle').addEventListener('change', e => { prefs.countdown = e.target.checked; savePrefs(); });

// ---------- recording ----------

let recUi = 'idle'; // idle | countdown | starting | recording | stopping
let countdownTimer = null;
let stopSafety = null;

function phoneRecording() { return !!(S.camera && S.camera.recording && S.camera.recording.active); }

function onRecordClick() {
  if (!connected()) { toast('Connect the iPhone first.', 'warn'); return; }
  if (recUi === 'countdown') return cancelCountdown();
  if (recUi === 'recording' || recUi === 'starting' || phoneRecording()) return stopRecording();
  if (recUi === 'stopping') return;
  if (prefs.countdown) runCountdown(3); else startRecording();
}
$('recBtn').addEventListener('click', onRecordClick);

function runCountdown(n) {
  recUi = 'countdown';
  post('/api/cmd', { op: 'countdown', seconds: n });
  const show = k => {
    const el = $('countdownBig');
    el.textContent = k;
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  };
  let k = n;
  show(k);
  renderRec();
  countdownTimer = setInterval(() => {
    k--;
    if (k > 0) { show(k); return; }
    clearInterval(countdownTimer);
    countdownTimer = null;
    $('countdownBig').classList.remove('on');
    startRecording();
  }, 1000);
}

function cancelCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  $('countdownBig').classList.remove('on');
  post('/api/cmd', { op: 'cancelCountdown' });
  recUi = 'idle';
  renderRec();
}

async function startRecording() {
  recUi = 'starting';
  renderRec();
  let pcAudioId = null;
  if (prefs.audioSource === 'pc') {
    try {
      pcAudioId = await pcMic.start();
    } catch (e) {
      toast(`The PC microphone couldn't start (${e.message}). Recording with the iPhone microphone.`, 'warn');
    }
  }
  const r = await post('/api/record', { pcAudioId });
  if (r.error) {
    toast(r.error, 'error');
    recUi = 'idle';
    if (pcAudioId) pcMic.stop();
    renderRec();
  }
  setTimeout(() => { if (recUi === 'starting' && !phoneRecording()) { recUi = 'idle'; renderRec(); } }, 6000);
}

function stopRecording() {
  recUi = 'stopping';
  renderRec();
  post('/api/stop');
  clearTimeout(stopSafety);
  stopSafety = setTimeout(() => { if (pcMic.rec) pcMic.stop(); if (recUi === 'stopping') { recUi = 'idle'; renderRec(); } }, 8000);
}

function onEvent(ev) {
  if (ev.type === 'recStarted') { recUi = 'recording'; }
  if (ev.type === 'recStopped') {
    clearTimeout(stopSafety);
    setTimeout(() => pcMic.stop(), 400); // keep the PC sound running a moment past the last frame
    recUi = 'idle';
    if (S.camera && S.camera.recording) S.camera.recording.active = false;
    if (L && L.rec) L.rec.active = false;
  }
  if (ev.type === 'recFailed') { pcMic.stop(); recUi = 'idle'; }
  if (ev.type === 'disconnected' && recUi !== 'idle') { pcMic.stop(); recUi = 'idle'; }
  renderRec();
}

function elapsed() {
  if (!L || !L.rec || !L.rec.active) return 0;
  return L.rec.elapsed + (performance.now() - liveAt) / 1000;
}
const fmtTime = t => {
  const s = Math.max(0, Math.floor(t));
  const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
  return (hh ? `${hh}:${String(mm).padStart(2, '0')}` : String(mm).padStart(2, '0')) + ':' + String(ss).padStart(2, '0');
};

function renderRec() {
  const active = phoneRecording() || (L && L.rec && L.rec.active);
  if (active && (recUi === 'idle' || recUi === 'starting')) recUi = 'recording';
  if (!active && recUi === 'recording' && !(L && L.rec && L.rec.active)) recUi = 'idle';
  const btn = $('recBtn');
  btn.classList.toggle('recording', recUi === 'recording' || recUi === 'stopping');
  btn.classList.toggle('countdown', recUi === 'countdown');
  btn.classList.toggle('busy', recUi === 'starting' || recUi === 'stopping');
  const label = $('recLabel');
  label.classList.toggle('live', recUi === 'recording');
  label.textContent = {
    idle: connected() ? 'Record' : 'Not connected', countdown: 'Cancel', starting: 'Starting…',
    recording: fmtTime(elapsed()), stopping: 'Saving…',
  }[recUi];
  $('recBadge').classList.toggle('on', recUi === 'recording');
  $('recTime').textContent = fmtTime(elapsed());
}
setInterval(() => { if (recUi === 'recording') renderRec(); }, 250);

document.addEventListener('keydown', e => {
  if (e.target.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) onRecordClick(); }
  if (e.key === 'g' || e.key === 'G') { prefs.grid = !prefs.grid; savePrefs(); render(); }
});
// buttons lose focus after a click, so the space bar always means record
document.addEventListener('click', e => { const b = e.target.closest('button'); if (b) b.blur(); });
window.addEventListener('beforeunload', e => {
  if (pcMic.rec || recUi === 'recording') { e.preventDefault(); e.returnValue = ''; }
});

// ---------- PC microphone ----------

const pcMic = {
  ctx: null, stream: null, node: null, rec: null, opening: null, label: '', granted: false,
  level: { rms: 0, peak: 0, hold: 0, at: 0 },

  async open() {
    if (!this.opening) this.opening = this._open().finally(() => { this.opening = null; });
    return this.opening;
  },

  async _open() {
    if (this.rec) return;
    this.close();
    const c = prefs.cleanup;
    const audio = { echoCancellation: c, noiseSuppression: c, autoGainControl: c, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 } };
    if (prefs.pcDevice) audio.deviceId = { exact: prefs.pcDevice };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (e) {
      if (prefs.pcDevice && e.name === 'OverconstrainedError') { prefs.pcDevice = ''; savePrefs(); return this._open(); }
      throw e;
    }
    this.granted = true;
    this.ctx = new AudioContext({ sampleRate: 48000 });
    await this.ctx.audioWorklet.addModule('/pcm-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(this.node);
    this.node.connect(mute);
    mute.connect(this.ctx.destination);
    this.node.port.onmessage = e => this.onMessage(e.data);
    const track = this.stream.getAudioTracks()[0];
    this.label = track ? track.label : '';
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    await refreshPcDevices();
    render();
  },

  close() {
    if (this.rec) return;
    try { if (this.stream) this.stream.getTracks().forEach(t => t.stop()); } catch {}
    try { if (this.ctx) this.ctx.close(); } catch {}
    this.ctx = this.stream = this.node = null;
  },

  onMessage(m) {
    if (m.type === 'level') {
      this.level.rms = m.rms;
      this.level.peak = m.peak;
      this.level.hold = Math.max(m.peak, this.level.hold * 0.9);
      this.level.at = performance.now();
    } else if (m.type === 'started' && this.rec) {
      const ts = this.ctx.getOutputTimestamp();
      this.rec.startWall = ts && ts.performanceTime
        ? performance.timeOrigin + ts.performanceTime + (m.frame / this.ctx.sampleRate - ts.contextTime) * 1000
        : Date.now();
    } else if (m.type === 'data' && this.rec) {
      const rec = this.rec;
      const body = m.samples;
      rec.chain = rec.chain
        .then(() => fetch(`/api/pcaudio/chunk?id=${rec.id}`, { method: 'POST', headers: { 'X-Camera-Studio': '1', 'Content-Type': 'application/octet-stream' }, body }))
        .catch(() => { rec.lost = true; });
    } else if (m.type === 'stopped' && this.rec && this.rec.onStopped) {
      this.rec.onStopped();
    }
  },

  async start() {
    if (!this.node) await this.open();
    if (!this.node) throw new Error('no microphone');
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const r = await post('/api/pcaudio/start', { sampleRate: this.ctx.sampleRate, device: this.label });
    if (!r.id) throw new Error(r.error || 'could not start');
    this.rec = { id: r.id, chain: Promise.resolve(), startWall: Date.now() };
    this.node.port.postMessage({ cmd: 'start' });
    return r.id;
  },

  stop() {
    const rec = this.rec;
    if (!rec) return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      rec.onStopped = async () => {
        if (done) return;
        done = true;
        if (this.rec === rec) this.rec = null;
        await rec.chain;
        await post('/api/pcaudio/stop', { id: rec.id, startWall: rec.startWall });
        if (rec.lost) toast('Some of the PC sound was lost on the way to the PC app.', 'warn');
        resolve();
      };
      if (this.node) this.node.port.postMessage({ cmd: 'stop' });
      setTimeout(() => rec.onStopped(), 2000);
    });
  },
};

async function refreshPcDevices() {
  let list = [];
  try { list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput'); } catch {}
  const sel = $('pcMicSelect');
  const key = JSON.stringify(list.map(d => [d.deviceId, d.label]));
  if (sel.dataset.items !== key) {
    sel.dataset.items = key;
    sel.innerHTML = '';
    for (const d of list) {
      if (d.deviceId === 'communications') continue;
      const o = document.createElement('option');
      o.value = d.deviceId === 'default' ? '' : d.deviceId;
      o.textContent = d.deviceId === 'default' ? `Windows default (${d.label.replace(/^Default - /, '')})` : (d.label || 'Microphone');
      sel.appendChild(o);
    }
    if (!list.length) sel.innerHTML = '<option value="">PC microphone</option>';
  }
  sel.value = prefs.pcDevice;
  if (sel.value !== prefs.pcDevice) sel.value = '';
}

$('pcMicSelect').addEventListener('change', e => { prefs.pcDevice = e.target.value; savePrefs(); pcMic.open().catch(micError); });
$('cleanupToggle').addEventListener('change', e => { prefs.cleanup = e.target.checked; savePrefs(); if (pcMic.node) pcMic.open().catch(micError); });
$('pcMicAllow').addEventListener('click', () => pcMic.open().catch(micError));
document.addEventListener('pointerdown', () => { if (pcMic.ctx && pcMic.ctx.state === 'suspended') pcMic.ctx.resume().catch(() => {}); });
if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', refreshPcDevices);
function micError(e) {
  toast(e.name === 'NotAllowedError'
    ? 'The PC microphone is blocked. Click the microphone icon in the address area, or Windows Settings › Privacy › Microphone.'
    : `PC microphone: ${e.message}`, 'warn');
  render();
}

$('audioSourceSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  prefs.audioSource = b.dataset.v;
  savePrefs();
  if (prefs.audioSource === 'pc' && !pcMic.node) pcMic.open().catch(micError);
  render();
});

$('micInput').addEventListener('change', e => set({ micInput: e.target.value, micSource: '' }));
$('micSource').addEventListener('change', e => set({ micSource: e.target.value }));

// ---------- connection, folder ----------

for (const [form, input] of [['connectForm', 'addressInput'], ['connectForm2', 'addressInput2']]) {
  $(form).addEventListener('submit', async e => {
    e.preventDefault();
    const r = await post('/api/connect', { address: $(input).value });
    toast(r.error || 'Trying that address…', r.error ? 'warn' : 'info');
  });
}
for (const id of ['openFolder', 'openFolder2']) $(id).addEventListener('click', () => post('/api/open', { what: 'folder' }));

document.querySelectorAll('details.card').forEach(d => {
  if (prefs.closed[d.dataset.card] === true) d.open = false;
  if (prefs.closed[d.dataset.card] === false) d.open = true;
  d.addEventListener('toggle', () => { prefs.closed[d.dataset.card] = !d.open; savePrefs(); });
});

// ---------- drawing the page ----------

const LENS_NAMES = { auto: 'All lenses', ultrawide: 'Ultra Wide (0.5×)', wide: 'Wide (1×)', tele: 'Telephoto' };
const STATUS = {
  'on the iPhone': 'On the iPhone', recording: 'Recording…', 'waiting to copy': 'Waiting to copy to this PC',
  copying: 'Copying to this PC', 'waiting for the PC sound': 'Copied. Waiting for the PC sound…',
  'lining up the PC sound': 'Lining up the PC sound…', 'adding the PC sound': 'Adding the PC sound…', ready: 'Ready on this PC',
};

function render() {
  document.body.classList.toggle('connected', connected());
  // top bar
  const pill = $('connPill');
  pill.classList.toggle('ok', connected());
  $('connText').textContent = serverGone ? 'Camera Studio has stopped on this PC' : S.phone.detail;

  // cover over the preview
  const cover = $('cover');
  cover.classList.toggle('hidden', connected() && !serverGone);
  cover.classList.toggle('stopped', serverGone);
  $('coverTitle').textContent = serverGone ? 'Camera Studio has stopped on this PC'
    : S.phone.status === 'connected' ? 'Connected. Starting the camera…' : 'Looking for your iPhone…';
  $('coverText').textContent = serverGone ? 'Start it again with the Camera Studio icon.' : S.phone.detail;

  const s = settings();
  const c = caps();
  document.querySelectorAll('.seg[data-key]').forEach(seg => renderSeg(seg, getPath(seg.dataset.key)));
  $('previewBox').classList.toggle('mirror', prefs.mirror);
  $('grid').classList.toggle('on', prefs.grid);
  $('gridToggle').checked = prefs.grid;
  $('mirrorToggle').checked = prefs.mirror;
  $('countdownToggle').checked = prefs.countdown;
  renderSeg($('audioSourceSeg'), prefs.audioSource);
  $('cleanupToggle').checked = prefs.cleanup;

  if (s) {
    // camera
    [...document.querySelector('[data-key=position]').children].forEach(b => { b.disabled = !(c.positions || []).includes(b.dataset.v); });
    chips($('lensChips'), (c.lenses || []).map(v => ({ v, label: LENS_NAMES[v] || v })), s.lens, v => set({ lens: v }));
    const z = zoomRange();
    chips($('zoomPresets'), (z.presets || []).map(v => ({ v, label: fmtZoom(v) })), null, v => post('/api/cmd', { op: 'zoom', value: v, smooth: true }));

    // video
    const fpsOk = (c.fps || {})[s.resolution] || [];
    const fpsHdr = (c.fpsHDR || {})[s.resolution] || [];
    chips($('fpsChips'), [24, 25, 30, 50, 60, 100, 120].map(v => ({
      v, label: String(v), disabled: !fpsOk.includes(v),
      title: fpsOk.includes(v) ? (s.hdr && !fpsHdr.includes(v) ? 'No HDR at this frame rate (HDR switches off)' : '') : 'Not available at this size on this camera',
    })), s.fps, v => set({ fps: v }));
    $('hdrToggle').checked = s.hdr;
    $('hdrToggle').disabled = !fpsHdr.includes(s.fps);
    [...document.querySelector('[data-key=codec]').children].forEach(b => { b.disabled = b.dataset.v === 'h264' && s.hdr; });
    [...$('stabSeg').children].forEach(b => { b.disabled = !(c.stabilization || ['off']).includes(b.dataset.v); });
    const mbps = S.camera.bitrate ? `about ${Math.round(S.camera.bitrate / 1e6)} Mbit/s` : '';
    const notes = [S.camera.format, mbps].filter(Boolean).join(' · ');
    const pal = [30, 60, 120].includes(s.fps) ? ' In the UK, 25 or 50 fps stops lights flickering on camera.' : '';
    const stab = s.stabilization !== 'off' ? ' On a tripod, stabilisation is best off (it crops and delays the preview).' : '';
    $('videoNote').textContent = notes + '.' + pal + stab;
    $('formatTag').textContent = `${s.resolution === '4k' ? '4K' : '1080p'} · ${s.fps} fps${s.hdr ? ' · HDR' : ''}${s.look !== 'none' ? ' · ' + lookName(s.look) : ''}`;

    // focus / exposure / wb
    $('expAuto').style.display = s.exposure.mode === 'manual' ? 'none' : '';
    $('expManual').style.display = s.exposure.mode === 'manual' ? '' : 'none';
    $('wbManual').style.display = s.wb.mode === 'manual' ? '' : 'none';
    if (!held.has('biasSlider')) { $('biasSlider').value = Math.round(s.exposure.bias * 10); $('biasReadout').textContent = fmtEV(s.exposure.bias); }
    $('biasSlider').min = Math.round(((c.bias && c.bias.min) || -3) * 10);
    $('biasSlider').max = Math.round(((c.bias && c.bias.max) || 3) * 10);
    if (!held.has('isoSlider')) { $('isoSlider').value = isoToPos(s.exposure.iso); $('isoReadout').textContent = `ISO ${Math.round(s.exposure.iso)}`; }
    const list = shutterList();
    $('shutterSlider').max = list.length - 1;
    if (!held.has('shutterSlider')) {
      const i = list.indexOf(nearestShutter(s.exposure.shutter));
      $('shutterSlider').value = i;
      $('shutterReadout').textContent = fmtShutter(list[i]);
    }
    $('s180').textContent = Math.round(2 * s.fps);
    if (!held.has('tempSlider')) { $('tempSlider').value = s.wb.temp; $('tempReadout').textContent = `${Math.round(s.wb.temp)} K`; }
    if (!held.has('tintSlider')) { $('tintSlider').value = s.wb.tint; $('tintReadout').textContent = fmtTint(Math.round(s.wb.tint)); }
    [...document.querySelector('[data-key="focus.mode"]').children].forEach(b => { b.disabled = b.dataset.v === 'manual' && !c.focusManual; });
    [...document.querySelector('[data-key="exposure.mode"]').children].forEach(b => { b.disabled = b.dataset.v === 'manual' && !c.exposureManual; });
    [...document.querySelector('[data-key="wb.mode"]').children].forEach(b => { b.disabled = b.dataset.v === 'manual' && !c.wbManual; });

    // light & look
    $('torchRow').style.display = c.torch ? '' : 'none';
    $('torchToggle').checked = s.torch > 0;
    if (!held.has('torchSlider') && s.torch > 0) $('torchSlider').value = Math.round(s.torch * 100);
    chips($('lookChips'), (c.looks || []).map(l => ({ v: l.id, label: l.name })), s.look, v => set({ look: v }));
    $('lookNote').textContent = s.look === 'none' ? 'Looks are simple colour styles, recorded into the video.'
      : S.camera.looksOnRecording ? 'This look is recorded into the video.' : 'With HDR or above 60 fps the look shows on the preview only, not in the recording.';

    // iPhone microphone
    const mics = c.mics || [];
    fillSelect($('micInput'), [{ v: '', label: 'Automatic' }, ...mics.map(m => ({ v: m.id, label: m.name }))], s.micInput);
    const port = mics.find(m => m.id === s.micInput) || mics.find(m => m.builtIn);
    const sources = (port && port.sources) || [];
    fillSelect($('micSource'), [{ v: '', label: 'Automatic' }, ...sources.map(x => ({ v: x.id, label: `${x.name} of the iPhone` }))], s.micSource);
    $('micSourceRow').style.display = sources.length ? '' : 'none';
  }

  // sound notes
  const pc = prefs.audioSource === 'pc';
  $('meterPc').parentElement.classList.toggle('dim', !pc);
  $('meterPhone').parentElement.classList.toggle('dim', pc);
  $('pcMicAllow').style.display = pcMic.node ? 'none' : '';
  $('soundNote').className = 'note' + (pc && !S.ffmpeg ? ' warn' : '');
  $('soundNote').textContent = pc
    ? (S.ffmpeg ? 'The PC microphone\'s sound goes on the final video, lined up automatically. The iPhone records its own sound too, as a guide (kept in the Originals folder).'
      : 'ffmpeg wasn\'t found on this PC, so the PC sound can\'t be added to the video. The video keeps the iPhone sound.')
    : 'Sound comes from the iPhone (or a microphone plugged into the iPhone).';

  // connection card
  const route = S.phone.route;
  $('connNote').textContent = (route === 'usb' ? 'Connected by the USB cable.' : route === 'wifi' ? `Connected over Wi-Fi (${S.phone.host}).` : S.phone.detail) + ' ' +
    (S.phone.usbService ? 'USB works too: plug in the cable (and tap Trust on the iPhone if it asks).' : 'For the USB cable, install the free Apple Devices app from the Microsoft Store.');
  $('folderNote').textContent = `Videos are saved to ${S.outDir || 'Videos\\Camera Studio'}.`;
  if (S.address && !$('addressInput').value) $('addressInput').value = S.address;

  renderBanner();
  renderTakes();
  renderRec();
  renderLive();
}

function lookName(id) {
  const l = (caps().looks || []).find(x => x.id === id);
  return l ? l.name : id;
}

function fillSelect(sel, items, value) {
  const key = JSON.stringify(items);
  if (sel.dataset.items !== key) {
    sel.dataset.items = key;
    sel.innerHTML = '';
    for (const it of items) {
      const o = document.createElement('option');
      o.value = it.v;
      o.textContent = it.label;
      sel.appendChild(o);
    }
  }
  sel.value = value;
}

function renderBanner() {
  const b = $('banner');
  const s = settings();
  let html = '';
  if (connected() && S.camera.status && S.camera.status !== 'running') {
    html = escapeHtml(S.camera.status);
  } else if (connected() && S.camera.mismatch && s) {
    html = s.orientation === 'vertical'
      ? 'The iPhone is on its side, but <b>Vertical</b> is chosen. Stand the iPhone upright, or <button data-o="horizontal">Use Horizontal</button>'
      : 'The iPhone is upright, but <b>Horizontal</b> is chosen. Turn the iPhone on its side, or <button data-o="vertical">Use Vertical</button>';
  } else if (L && L.phone && (L.phone.thermal === 'hot' || L.phone.thermal === 'critical')) {
    html = 'The iPhone is getting hot. Shade it, lower the frame rate, or take a break; it may stop recording if it overheats.';
  }
  b.innerHTML = html;
  b.classList.toggle('on', !!html);
  const btn = b.querySelector('button');
  if (btn) btn.addEventListener('click', () => set({ orientation: btn.dataset.o }));
}

function escapeHtml(t) {
  return String(t).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

let lastTakes = '';
function renderTakes() {
  const key = JSON.stringify(S.takes);
  if (key === lastTakes) return;
  lastTakes = key;
  const list = $('takesList');
  if (!S.takes.length) {
    list.innerHTML = '<div class="empty">Your videos appear here after you record. They\'re saved to the iPhone\'s Photos and copied to this PC.</div>';
    return;
  }
  list.innerHTML = '';
  for (const t of S.takes) {
    const row = document.createElement('div');
    row.className = 'take';
    let status = STATUS[t.status] || t.status;
    if (t.status === 'copying') status += ` · ${Math.round(t.progress * 100)}% of ${(t.size / 1e6).toFixed(0)} MB`;
    if (t.status === 'ready') status += ' ✓' + (t.photos === 'saved' ? ' · also in the iPhone\'s Photos' : '');
    const extra = [t.error, t.note].filter(Boolean).join(' ');
    row.innerHTML = `
      <div class="name">${escapeHtml(t.name.replace(/\.mov$/i, ''))}${t.pcMic ? ' · PC mic' : ''}${t.duration ? ' · ' + fmtTime(t.duration) : ''}</div>
      <div class="actions"></div>
      <div><div class="status ${t.status === 'ready' ? 'ok' : t.error ? 'err' : ''}">${escapeHtml(status)}</div>
      ${t.status === 'copying' ? `<div class="bar"><div style="width:${(t.progress * 100).toFixed(1)}%"></div></div>` : ''}
      ${extra ? `<div class="status ${t.error ? 'err' : ''}">${escapeHtml(extra)}</div>` : ''}</div>`;
    if (t.status === 'ready' && t.final) {
      const actions = row.querySelector('.actions');
      for (const [what, label] of [['play', 'Play'], ['show', 'Show in folder']]) {
        const btn = document.createElement('button');
        btn.className = 'small';
        btn.textContent = label;
        btn.addEventListener('click', () => post('/api/open', { what, name: t.name }));
        actions.appendChild(btn);
      }
    }
    list.appendChild(row);
  }
}

function renderLive() {
  const s = settings();
  const fresh = L && performance.now() - liveAt < 2000;
  // header: battery, heat, storage
  const info = [];
  if (fresh && L.phone) {
    const p = L.phone;
    if (p.battery >= 0) info.push(`<span class="${p.battery < 0.15 && !p.charging ? 'bad' : ''}">Battery <b>${Math.round(p.battery * 100)}%</b>${p.charging ? ' ⚡' : ''}</span>`);
    const heat = { ok: ['Cool', ''], warm: ['Warm', 'warn'], hot: ['Hot', 'bad'], critical: ['Too hot', 'bad'] }[p.thermal] || ['', ''];
    if (heat[0]) info.push(`<span class="${heat[1]}">iPhone <b>${heat[0]}</b></span>`);
    if (p.free) {
      const rate = ((S.camera && S.camera.bitrate) || 50e6) + 256e3;
      const secs = (p.free * 8) / rate;
      const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60;
      info.push(`<span class="${secs < 600 ? 'bad' : ''}"><b>${(p.free / 1e9).toFixed(0)} GB</b> free · about ${h ? h + ' h ' : ''}${m} min of video</span>`);
    }
  }
  const infoHtml = info.join('');
  if ($('phoneInfo').dataset.html !== infoHtml) { $('phoneInfo').dataset.html = infoHtml; $('phoneInfo').innerHTML = infoHtml; }
  if (!fresh || !s) return;

  // zoom
  if (!held.has('zoomSlider')) { $('zoomSlider').value = zoomToPos(L.zoom); $('zoomReadout').textContent = fmtZoom(L.zoom); }
  [...$('zoomPresets').children].forEach(b => b.classList.toggle('on', Math.abs(+b.dataset.v - L.zoom) < 0.05));
  // focus slider follows the lens while in auto
  if (!held.has('focusSlider')) $('focusSlider').value = Math.round((s.focus.mode === 'manual' ? s.focus.lens : L.lens) * 1000);
  // exposure and white balance readouts
  $('expReadout').textContent = `ISO ${Math.round(L.iso)} · ${fmtShutter(L.shutter)}`;
  $('wbReadout').textContent = `${Math.round(L.temp / 50) * 50} K`;
}

// sound meters (redrawn every frame)
function meter(el, dbEl, avgDb, peakDb, on) {
  const pct = d => Math.max(0, Math.min(100, ((d + 60) / 60) * 100));
  const fill = el.querySelector('.fill'), peak = el.querySelector('.peak');
  fill.style.width = `${on ? pct(avgDb) : 0}%`;
  peak.style.left = `${on ? pct(peakDb) : 0}%`;
  dbEl.textContent = on && peakDb > -60 ? `${peakDb.toFixed(0)} dB` : '';
}
function drawMeters() {
  const phoneOn = !!(L && L.mic && performance.now() - liveAt < 1500);
  meter($('meterPhone'), $('dbPhone'), phoneOn ? L.mic.avg : -100, phoneOn ? L.mic.peak : -100, phoneOn);
  const pcOn = !!(pcMic.node && performance.now() - pcMic.level.at < 600);
  const db = x => (x > 0 ? 20 * Math.log10(x) : -100);
  meter($('meterPc'), $('dbPc'), db(pcMic.level.rms * 1.4), db(pcMic.level.hold), pcOn);
  requestAnimationFrame(drawMeters);
}
function sizeMeters() {
  for (const id of ['meterPhone', 'meterPc']) $(id).style.setProperty('--meter-w', `${$(id).clientWidth}px`);
}
new ResizeObserver(sizeMeters).observe($('panel'));

// ---------- start ----------

(async () => {
  render();
  listen();
  requestAnimationFrame(drawMeters);
  try {
    const perm = await navigator.permissions.query({ name: 'microphone' });
    if (perm.state === 'granted' && prefs.audioSource === 'pc') pcMic.open().catch(() => {});
  } catch {}
  refreshPcDevices();
})();
