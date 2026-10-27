'use strict';
// The USB cable: Apple's own Windows service (Apple Mobile Device Service, installed with the free Apple Devices
// app or iTunes) listens on 127.0.0.1:27015 and speaks "usbmux". We ask it for plugged-in iPhones and then for a
// tunnel to a port on the phone; after that the socket is a plain TCP connection to the iPhone app.

const net = require('net');

const SERVICE_PORT = 27015;

// ---- a tiny XML property-list writer / reader (all usbmux needs) ----

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plistValue(v) {
  if (typeof v === 'string') return `<string>${esc(v)}</string>`;
  if (typeof v === 'number') return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`;
  if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
  if (Array.isArray(v)) return `<array>${v.map(plistValue).join('')}</array>`;
  if (v && typeof v === 'object') {
    return `<dict>${Object.entries(v).map(([k, x]) => `<key>${esc(k)}</key>${plistValue(x)}`).join('')}</dict>`;
  }
  return '<string></string>';
}

function toPlist(obj) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">' + plistValue(obj) + '</plist>\n';
}

function unesc(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parsePlist(xml) {
  const tokens = [];
  const re = /<(\/?)([a-zA-Z]+)[^>]*?(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[4] !== undefined) { if (m[4].trim()) tokens.push({ text: m[4] }); continue; }
    tokens.push({ close: m[1] === '/', name: m[2], self: m[3] === '/' });
  }
  let i = tokens.findIndex(t => t.name === 'plist' && !t.close) + 1;
  function readText(name) {
    let text = '';
    if (tokens[i] && tokens[i].text !== undefined) { text = tokens[i].text; i++; }
    if (tokens[i] && tokens[i].close && tokens[i].name === name) i++;
    return unesc(text);
  }
  function value() {
    const t = tokens[i++];
    if (!t || t.close) return undefined;
    switch (t.name) {
      case 'dict': {
        const out = {};
        if (t.self) return out;
        while (tokens[i] && !(tokens[i].close && tokens[i].name === 'dict')) {
          const k = tokens[i++];
          if (k.name !== 'key') continue;
          const key = readText('key');
          out[key] = value();
        }
        i++;
        return out;
      }
      case 'array': {
        const out = [];
        if (t.self) return out;
        while (tokens[i] && !(tokens[i].close && tokens[i].name === 'array')) out.push(value());
        i++;
        return out;
      }
      case 'string': return t.self ? '' : readText('string');
      case 'integer': return parseInt(readText('integer'), 10);
      case 'real': return parseFloat(readText('real'));
      case 'true': return true;
      case 'false': return false;
      case 'data': return t.self ? Buffer.alloc(0) : Buffer.from(readText('data').replace(/\s+/g, ''), 'base64');
      case 'date': return readText('date');
      default: return t.self ? null : readText(t.name);
    }
  }
  return value();
}

// ---- usbmux messages ----

let tag = 1;

function packet(obj) {
  const body = Buffer.from(toPlist(obj), 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt32LE(16 + body.length, 0);
  head.writeUInt32LE(1, 4);  // version 1: plist messages
  head.writeUInt32LE(8, 8);  // message type 8: plist
  head.writeUInt32LE(tag++, 12);
  return Buffer.concat([head, body]);
}

/** Opens a connection to Apple's service, sends one message and waits for one reply. */
function exchange(obj, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: SERVICE_PORT });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err, reply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.removeAllListeners('data');
      if (err) { sock.destroy(); reject(err); } else resolve({ sock, reply });
    };
    const timer = setTimeout(() => finish(new Error('Apple USB service did not answer')), timeoutMs);
    sock.once('error', e => finish(e));
    sock.on('connect', () => sock.write(packet(obj)));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 16) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < len) return;
      let reply;
      try { reply = parsePlist(buf.subarray(16, len).toString('utf8')); } catch (e) { return finish(e); }
      const extra = buf.subarray(len);
      if (extra.length) sock.unshift(extra);
      finish(null, reply);
    });
  });
}

const base = { ClientVersionString: 'camera-studio', ProgName: 'camera-studio', kLibUSBMuxVersion: 3 };

/** iPhones plugged in by cable ([] if Apple's service isn't installed or nothing is plugged in). */
async function listDevices() {
  try {
    const { sock, reply } = await exchange({ ...base, MessageType: 'ListDevices' });
    sock.destroy();
    const list = (reply && reply.DeviceList) || [];
    return list
      .map(d => ({ id: d.DeviceID, ...(d.Properties || {}) }))
      .filter(d => d.ConnectionType === 'USB');
  } catch {
    return [];
  }
}

/** A socket tunnelled through the cable to `port` on the iPhone. */
async function connect(deviceId, port, timeoutMs = 2500) {
  const portNetworkOrder = ((port & 0xff) << 8) | ((port >> 8) & 0xff);
  const { sock, reply } = await exchange({ ...base, MessageType: 'Connect', DeviceID: deviceId, PortNumber: portNetworkOrder }, timeoutMs);
  if (!reply || reply.MessageType !== 'Result' || reply.Number !== 0) {
    sock.destroy();
    const n = reply && reply.Number;
    throw new Error(n === 3 ? 'the iPhone app is not open' : `USB connection refused (${n})`);
  }
  return sock;
}

/** Is Apple's USB service there at all? */
function serviceRunning() {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port: SERVICE_PORT });
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

module.exports = { listDevices, connect, serviceRunning, toPlist, parsePlist };
