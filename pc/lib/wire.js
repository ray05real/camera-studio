'use strict';
// How the PC and the iPhone talk (same as ios/App/Util.swift, Wire): every message is a frame of
// 4 bytes of length (big-endian, counting the type byte), 1 type byte, then the payload.

const JSON_T = 1;   // a JSON object
const JPEG_T = 2;   // one preview picture
const CHUNK_T = 3;  // a piece of a video file
const PORT = 47100;

function frame(type, payload) {
  const out = Buffer.allocUnsafe(5 + payload.length);
  out.writeUInt32BE(payload.length + 1, 0);
  out[4] = type;
  payload.copy(out, 5);
  return out;
}

function jsonFrame(obj) {
  return frame(JSON_T, Buffer.from(JSON.stringify(obj), 'utf8'));
}

/** Collects bytes from a socket and calls onFrame(type, payload) for each whole frame. */
class FrameReader {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.chunks = [];
    this.length = 0;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;
    while (this.length >= 5) {
      let head = this.chunks[0];
      if (head.length < 5) { this.flatten(); head = this.chunks[0]; }
      const size = head.readUInt32BE(0);
      if (size < 1 || size > 64 * 1024 * 1024) throw new Error('bad frame from the iPhone');
      if (this.length < 4 + size) return;
      if (head.length < 4 + size) { this.flatten(); head = this.chunks[0]; }
      const type = head[4];
      const payload = head.subarray(5, 4 + size);
      const rest = head.subarray(4 + size);
      if (rest.length) this.chunks[0] = rest; else this.chunks.shift();
      this.length -= 4 + size;
      this.onFrame(type, payload);
    }
  }

  flatten() {
    this.chunks = [Buffer.concat(this.chunks, this.length)];
  }
}

module.exports = { JSON_T, JPEG_T, CHUNK_T, PORT, frame, jsonFrame, FrameReader };
