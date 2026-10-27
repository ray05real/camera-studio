'use strict';
// Writes the PC microphone's sound to a .wav as it arrives (32-bit float, so nothing is lost or clipped).

const fs = require('fs');

class WavWriter {
  constructor(file, sampleRate, channels = 1) {
    this.file = file;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bytes = 0;
    this.fd = fs.openSync(file, 'w');
    fs.writeSync(this.fd, this.header());
  }

  header() {
    const h = Buffer.alloc(44);
    const blockAlign = 4 * this.channels;
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + this.bytes, 4);
    h.write('WAVE', 8);
    h.write('fmt ', 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(3, 20);                 // IEEE float
    h.writeUInt16LE(this.channels, 22);
    h.writeUInt32LE(this.sampleRate, 24);
    h.writeUInt32LE(this.sampleRate * blockAlign, 28);
    h.writeUInt16LE(blockAlign, 32);
    h.writeUInt16LE(32, 34);
    h.write('data', 36);
    h.writeUInt32LE(this.bytes, 40);
    return h;
  }

  write(buf) {
    if (this.fd === null) return;
    fs.writeSync(this.fd, buf);
    this.bytes += buf.length;
  }

  get seconds() {
    return this.bytes / (4 * this.channels * this.sampleRate);
  }

  close() {
    if (this.fd === null) return;
    fs.writeSync(this.fd, this.header(), 0, 44, 0);
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

module.exports = { WavWriter };
