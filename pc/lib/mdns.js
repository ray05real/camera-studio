'use strict';
// Finds the iPhone app on the Wi-Fi by its Bonjour name (_camstudio._tcp). We send a "legacy unicast" question
// from an ordinary port, so the iPhone answers us directly and we never need Windows' own Bonjour port (5353).

const dgram = require('dgram');
const os = require('os');

const SERVICE = '_camstudio._tcp.local';

function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const bufs = parts.map(p => {
    const b = Buffer.from(p, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function query(name, type) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(Math.floor(Math.random() * 65535), 0);
  head.writeUInt16BE(1, 4); // one question
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2); // class IN
  return Buffer.concat([head, encodeName(name), tail]);
}

function readName(buf, offset) {
  const labels = [];
  let jumped = false;
  let next = offset;
  for (let guard = 0; guard < 64; guard++) {
    const len = buf[offset];
    if (len === undefined) break;
    if (len === 0) { offset++; break; }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[offset + 1];
      if (!jumped) next = offset + 2;
      jumped = true;
      offset = ptr;
      continue;
    }
    labels.push(buf.toString('utf8', offset + 1, offset + 1 + len));
    offset += 1 + len;
  }
  return { name: labels.join('.'), end: jumped ? next : offset };
}

function parse(buf) {
  const records = [];
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6), ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(buf, off).end + 4;
  for (let i = 0; i < an + ns + ar; i++) {
    const n = readName(buf, off);
    off = n.end;
    const type = buf.readUInt16BE(off);
    const len = buf.readUInt16BE(off + 8);
    const data = off + 10;
    const rec = { name: n.name.toLowerCase(), type };
    if (type === 12) rec.target = readName(buf, data).name;                 // PTR
    if (type === 33) { rec.port = buf.readUInt16BE(data + 4); rec.target = readName(buf, data + 6).name.toLowerCase(); } // SRV
    if (type === 1 && len === 4) rec.ip = `${buf[data]}.${buf[data + 1]}.${buf[data + 2]}.${buf[data + 3]}`; // A
    records.push(rec);
    off = data + len;
  }
  return records;
}

/** The PC's own IPv4 addresses on real networks (skipping virtual adapters). */
function localInterfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|Bluetooth|vpn|tailscale|zerotier/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

/** Asks the network for the iPhone app; resolves with [{host, port, name}] after `timeoutMs`. */
function browse(timeoutMs = 1500) {
  return new Promise(resolve => {
    const found = new Map();
    const sockets = [];
    const q = query(SERVICE, 12);
    for (const iface of localInterfaces()) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => {});
      s.on('message', (msg, rinfo) => {
        let recs;
        try { recs = parse(msg); } catch { return; }
        const ptr = recs.find(r => r.type === 12 && r.name === SERVICE);
        if (!ptr) return;
        const srv = recs.find(r => r.type === 33);
        const a = recs.find(r => r.type === 1 && srv && r.name === srv.target);
        found.set(rinfo.address, {
          host: (a && a.ip) || rinfo.address,
          port: (srv && srv.port) || 47100,
          name: ptr.target.split('.')[0],
        });
      });
      s.bind({ address: iface.address, port: 0 }, () => {
        try {
          s.setMulticastInterface(iface.address);
          s.send(q, 5353, '224.0.0.251');
          setTimeout(() => { try { s.send(q, 5353, '224.0.0.251'); } catch {} }, 400);
        } catch {}
      });
      sockets.push(s);
    }
    setTimeout(() => {
      for (const s of sockets) { try { s.close(); } catch {} }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

module.exports = { browse, localInterfaces, parse, query };
