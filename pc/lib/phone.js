'use strict';
// Finding the iPhone app (USB cable first, then the last address, Bonjour, and finally trying every address on the
// Wi-Fi), keeping one control connection to it, and copying videos off it on extra connections.

const net = require('net');
const os = require('os');
const fs = require('fs');
const EventEmitter = require('events');
const wire = require('./wire');
const usbmux = require('./usbmux');
const mdns = require('./mdns');

/** A TCP socket to the iPhone app, by cable or Wi-Fi. */
async function openSocket(route, timeoutMs = 2500) {
  if (route.kind === 'usb') {
    const s = await usbmux.connect(route.deviceId, route.port, timeoutMs);
    s.setNoDelay(true);
    return s;
  }
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: route.host, port: route.port });
    const timer = setTimeout(() => { s.destroy(); reject(new Error('timed out')); }, timeoutMs);
    s.once('connect', () => { clearTimeout(timer); s.setNoDelay(true); resolve(s); });
    s.once('error', e => { clearTimeout(timer); reject(e); });
  });
}

/** One control connection: says hello, then passes on messages and preview pictures. */
class Link extends EventEmitter {
  constructor(sock, route) {
    super();
    this.sock = sock;
    this.route = route;
    this.hello = null;
    this.closed = false;
    this.lastData = Date.now();
    this.clock = [];          // recent {rtt, offset} pings; offset = phone clock - PC clock (ms)
    this.reader = new wire.FrameReader((type, payload) => this.onFrame(type, payload));
    sock.on('data', d => {
      this.lastData = Date.now();
      try { this.reader.push(d); } catch (e) { this.close(e.message); }
    });
    sock.on('error', e => this.close(e.message));
    sock.on('close', () => this.close('connection closed'));
    this.send({ op: 'hello', pc: os.hostname(), version: 1 });
    this.timer = setInterval(() => {
      if (Date.now() - this.lastData > 8000) return this.close('the iPhone stopped answering');
      this.send({ op: 'ping', t0: Date.now() });
    }, 2000);
  }

  onFrame(type, payload) {
    if (type === wire.JPEG_T) return this.emit('preview', payload);
    if (type !== wire.JSON_T) return;
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (msg.op === 'hello') {
      if (msg.app !== 'CameraStudio') return this.close('not Camera Studio');
      this.hello = msg;
      this.send({ op: 'ping', t0: Date.now() });
      return this.emit('ready', msg);
    }
    if (msg.op === 'pong') {
      const now = Date.now();
      const rtt = now - msg.t0;
      this.clock.push({ rtt, offset: msg.phone - (msg.t0 + rtt / 2) });
      if (this.clock.length > 30) this.clock.shift();
      return;
    }
    this.emit('message', msg);
  }

  /** Phone clock minus PC clock, in ms, from the quickest recent ping (good to a few ms on Wi-Fi). */
  clockOffset() {
    if (!this.clock.length) return 0;
    return this.clock.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
  }

  send(obj) {
    if (this.closed) return false;
    try { this.sock.write(wire.jsonFrame(obj)); return true; } catch { return false; }
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    try { this.sock.destroy(); } catch {}
    this.emit('closed', reason);
  }
}

/** Says hello on a new socket and waits for the app's answer. */
function handshake(sock, route, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const link = new Link(sock, route);
    const timer = setTimeout(() => { link.close('no answer'); reject(new Error('no answer')); }, timeoutMs);
    link.once('ready', () => { clearTimeout(timer); resolve(link); });
    link.once('closed', reason => { clearTimeout(timer); reject(new Error(reason)); });
  });
}

/** Every address on the PC's own Wi-Fi / network (a /24 around each of the PC's addresses). */
function subnetHosts() {
  const hosts = [];
  for (const iface of mdns.localInterfaces()) {
    const p = iface.address.split('.').map(Number);
    const isPrivate = p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
    if (!isPrivate) continue;
    for (let i = 1; i < 255; i++) {
      const h = `${p[0]}.${p[1]}.${p[2]}.${i}`;
      if (h !== iface.address) hosts.push(h);
    }
  }
  return [...new Set(hosts)];
}

/** Tries many addresses at once; resolves with the first that answers as Camera Studio, or null. */
function race(routes, concurrency = 80, timeoutMs = 900) {
  return new Promise(resolve => {
    let next = 0, running = 0, winner = null;
    const pump = () => {
      if (winner) return;
      if (next >= routes.length && running === 0) return resolve(null);
      while (running < concurrency && next < routes.length) {
        const route = routes[next++];
        running++;
        openSocket(route, timeoutMs)
          .then(sock => {
            if (winner) { sock.destroy(); return null; }
            return handshake(sock, route, 2000);
          })
          .then(link => {
            if (!link) return;
            if (winner) { link.close('duplicate'); return; }
            winner = link;
            resolve(link);
          })
          .catch(() => {})
          .finally(() => { running--; pump(); });
      }
    };
    pump();
  });
}

/** Keeps the PC connected to the iPhone app, whatever the route. */
class PhoneManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;           // { lastAddress, manualAddress } (saved by the server)
    this.link = null;
    this.status = 'searching';      // searching | connected
    this.detail = 'Looking for your iPhone…';
    this.busy = () => false;        // set by the server: true while recording / copying (don't switch routes)
    this.stopped = false;
    this.usbService = false;
    this.wakeSearch = null;
  }

  start() {
    this.loop();
    setInterval(() => this.preferUsb(), 5000);
  }

  setStatus(status, detail) {
    this.status = status;
    this.detail = detail;
    this.emit('status');
  }

  /** Try the address the owner typed in (or one remembered) straight away. */
  connectTo(address) {
    this.config.manualAddress = address;
    if (this.link) this.link.close('switching to ' + address);
    if (this.wakeSearch) this.wakeSearch();
  }

  async loop() {
    while (!this.stopped) {
      if (!this.link) {
        const link = await this.search().catch(() => null);
        if (link) this.adopt(link);
      }
      await new Promise(r => { this.wakeSearch = r; setTimeout(r, this.link ? 3000 : 1500); });
      this.wakeSearch = null;
    }
  }

  async search() {
    this.usbService = await usbmux.serviceRunning();
    if (this.usbService) {
      const link = await this.tryUsb();
      if (link) return link;
    }
    const port = wire.PORT;
    const first = [this.config.manualAddress, this.config.lastAddress].filter(Boolean)
      .map(host => ({ kind: 'wifi', host, port }));
    if (first.length) {
      this.setStatus('searching', 'Trying the last address…');
      const link = await race(first, 4, 1500);
      if (link) return link;
    }
    this.setStatus('searching', 'Looking for your iPhone on the Wi-Fi…');
    const found = await mdns.browse(1500);
    if (found.length) {
      const link = await race(found.map(f => ({ kind: 'wifi', host: f.host, port: f.port })), 8, 2000);
      if (link) return link;
    }
    this.setStatus('searching', 'Checking every address on your Wi-Fi…');
    const link = await race(subnetHosts().map(host => ({ kind: 'wifi', host, port })), 80, 900);
    if (link) return link;
    this.setStatus('searching', 'iPhone not found yet. Is Camera Studio open on it, on the same Wi-Fi?');
    return null;
  }

  async tryUsb() {
    const devices = await usbmux.listDevices();
    for (const d of devices) {
      try {
        const route = { kind: 'usb', deviceId: d.id, port: wire.PORT, serial: d.SerialNumber };
        const sock = await openSocket(route, 2500);
        return await handshake(sock, route, 2500);
      } catch {}
    }
    return null;
  }

  /** On Wi-Fi with the cable plugged in: move to the cable (unless recording or copying). */
  async preferUsb() {
    if (!this.link || this.link.route.kind === 'usb' || this.busy() || !this.usbService) return;
    const link = await this.tryUsb().catch(() => null);
    if (!link) return;
    if (this.busy() || !this.link) { link.close('not now'); return; }
    const old = this.link;
    this.adopt(link);
    old.removeAllListeners('closed');
    old.close('moved to the USB cable');
  }

  adopt(link) {
    this.link = link;
    if (link.route.kind === 'wifi') {
      this.config.lastAddress = link.route.host;
      this.emit('remember', link.route.host);
    }
    link.on('message', m => this.emit('message', m));
    link.on('preview', jpeg => this.emit('preview', jpeg));
    link.once('closed', reason => {
      if (this.link === link) {
        this.link = null;
        this.setStatus('searching', `Lost the iPhone (${reason}). Looking again…`);
        this.emit('disconnected');
        if (this.wakeSearch) this.wakeSearch();
      }
    });
    const how = link.route.kind === 'usb' ? 'USB cable' : `Wi-Fi · ${link.route.host}`;
    this.setStatus('connected', `${link.hello.model || 'iPhone'} · ${how}`);
    this.emit('connected', link);
    // The app sent its state and file list straight after hello, before anyone was listening: ask again.
    link.send({ op: 'state' });
    link.send({ op: 'files' });
  }

  send(obj) {
    return this.link ? this.link.send(obj) : false;
  }

  clockOffset() {
    return this.link ? this.link.clockOffset() : 0;
  }

  /**
   * Copies one video off the iPhone into `partPath` (carrying on from what's already there).
   * onProgress(bytesDone, total). Resolves when the whole file is on the PC.
   */
  async download(name, partPath, onProgress) {
    if (!this.link) throw new Error('the iPhone is not connected');
    const route = this.link.route;
    const sock = await openSocket(route, 4000);
    let have = 0;
    try { have = fs.statSync(partPath).size; } catch {}
    return new Promise((resolve, reject) => {
      let out = null, total = 0, done = have, finished = false, lastData = Date.now();
      const fail = err => {
        if (finished) return;
        finished = true;
        clearInterval(watch);
        sock.destroy();
        if (out) out.end();
        reject(err);
      };
      const watch = setInterval(() => { if (Date.now() - lastData > 15000) fail(new Error('the copy stalled')); }, 2000);
      const reader = new wire.FrameReader((type, payload) => {
        if (type === wire.CHUNK_T && out) {
          done += payload.length;
          if (!out.write(payload)) { sock.pause(); out.once('drain', () => sock.resume()); }
          onProgress(done, total);
          return;
        }
        if (type !== wire.JSON_T) return;
        const msg = JSON.parse(payload.toString('utf8'));
        if (msg.op === 'file') {
          total = msg.size;
          done = msg.offset;
          out = fs.createWriteStream(partPath, msg.offset > 0 ? { flags: 'r+', start: msg.offset } : { flags: 'w' });
          out.on('error', fail);
          onProgress(done, total);
        } else if (msg.op === 'eof') {
          if (!out) return fail(new Error('the iPhone sent no file'));
          finished = true;
          clearInterval(watch);
          sock.destroy();
          out.end(() => {
            const size = fs.statSync(partPath).size;
            if (size !== total) return reject(new Error(`copy incomplete (${size} of ${total} bytes)`));
            resolve(total);
          });
        } else if (msg.op === 'fileError') {
          fail(new Error(msg.message || 'the iPhone could not send the video'));
        }
      });
      sock.on('data', d => { lastData = Date.now(); try { reader.push(d); } catch (e) { fail(e); } });
      sock.on('error', fail);
      sock.on('close', () => { if (!finished) fail(new Error('the connection closed during the copy')); });
      sock.write(wire.jsonFrame({ op: 'download', name, offset: have }));
    });
  }
}

module.exports = { PhoneManager, openSocket, subnetHosts };
