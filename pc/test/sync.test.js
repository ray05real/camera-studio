'use strict';
// Checks the PC-mic syncing with made-up recordings whose true offset is known:
// a "phone video" (4K-style HEVC, turned 90°, with its own sound) and a "PC mic" WAV that starts earlier,
// sounds different (other EQ, more noise) and runs 40 ppm fast. Run: node pc/test/sync.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const sync = require('../lib/sync');
const { WavWriter } = require('../lib/wav');

const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
const ffmpeg = sync.findFfmpeg();
assert(ffmpeg, 'ffmpeg not found');
const ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe.exe');

// Speech-like sound: syllables of a few harmonics with random pitch and length, and pauses.
function speech(seconds, rate, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const x = new Float32Array(Math.round(seconds * rate));
  let t = 0;
  while (t < x.length) {
    const len = Math.round((0.08 + rnd() * 0.25) * rate);
    const f0 = 90 + rnd() * 160;
    const loud = rnd() < 0.2 ? 0 : 0.2 + rnd() * 0.4;
    for (let i = 0; i < len && t + i < x.length; i++) {
      const env = Math.sin((Math.PI * i) / len);
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin((2 * Math.PI * f0 * h * (t + i)) / rate) / h;
      x[t + i] = loud * env * v * 0.4 + (rnd() - 0.5) * 0.02 * loud;
    }
    t += len + Math.round(rnd() * 0.12 * rate);
  }
  return x;
}

function writeWav(file, samples, rate) {
  const w = new WavWriter(file, rate, 1);
  w.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  w.close();
}

(async () => {
  const rate = 48000;
  const videoSeconds = 120;
  const trueOffset = 1.2345;       // the PC started recording this long before the video
  const ppm = 40;                  // the PC's sound card runs a little fast
  const talk = speech(videoSeconds + 3, rate, 7);

  // phone sound: the talk itself
  writeWav(path.join(out, 'phone-sound.wav'), talk.subarray(0, videoSeconds * rate), rate);
  // PC sound: silence-ish room noise, then the talk, resampled 40 ppm fast, plus noise
  const pcLen = Math.round((trueOffset + videoSeconds + 1) * rate);
  const pc = new Float32Array(pcLen);
  let s = 3;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < pcLen; i++) {
    const tTalk = (i / rate - trueOffset) / (1 + ppm * 1e-6) * rate; // PC sample i holds talk at this time
    let v = 0;
    if (tTalk >= 0 && tTalk < talk.length - 1) {
      const k = Math.floor(tTalk), f = tTalk - k;
      v = talk[k] * (1 - f) + talk[k + 1] * f;
    }
    pc[i] = 0.7 * v + (rnd() - 0.5) * 0.03;
  }
  writeWav(path.join(out, 'pc-raw.wav'), pc, rate);
  // make the PC mic sound different (bassier, duller)
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', path.join(out, 'pc-raw.wav'), '-af', 'lowpass=f=3000,bass=g=6',
    '-c:a', 'pcm_f32le', path.join(out, 'pc.wav')]);
  // the "phone video": HEVC, turned 90° like an upright iPhone, with the phone sound (thinner, AAC)
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${videoSeconds}`,
    '-i', path.join(out, 'phone-sound.wav'), '-af', 'highpass=f=200', '-c:v', 'libx265', '-preset', 'ultrafast',
    '-x265-params', 'log-level=error', '-tag:v', 'hvc1', '-c:a', 'aac', '-b:a', '128k', '-shortest',
    '-metadata:s:v', 'rotate=90', path.join(out, 'phone.mov')]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-display_rotation', '90', '-i', path.join(out, 'phone.mov'),
    '-c', 'copy', '-tag:v', 'hvc1', path.join(out, 'phone-rot.mov')]);

  const coarse = trueOffset + 0.18; // the clocks were 180 ms out
  const t0 = Date.now();
  const r = await sync.findOffset({ ffmpeg, video: path.join(out, 'phone-rot.mov'), wav: path.join(out, 'pc.wav'), coarse, videoDuration: videoSeconds });
  console.log('found offset', r.offset.toFixed(5), 's (true', trueOffset, ') score', r.score.toFixed(1),
    'method', r.method, 'rate', r.rate.toFixed(7), 'in', Date.now() - t0, 'ms');
  assert.strictEqual(r.method, 'sound');
  assert(Math.abs(r.offset - trueOffset) < 0.002, 'offset off by more than 2 ms');
  assert(Math.abs((r.rate - 1) * 1e6 - ppm) < 10, 'drift not measured');

  const final = path.join(out, 'final.mov');
  await sync.merge({ ffmpeg, video: path.join(out, 'phone-rot.mov'), wav: path.join(out, 'pc.wav'), offset: r.offset,
    rate: r.rate, duration: videoSeconds, out: final, codec: 'hevc' });
  const probe = execFileSync(ffprobe, ['-v', 'error', '-show_entries',
    'stream=codec_name,codec_tag_string,duration:stream_side_data=rotation', '-of', 'compact', final], { encoding: 'utf8' });
  console.log(probe.trim());
  assert(/codec_tag_string=hvc1/.test(probe), 'HEVC tag lost');
  assert(/rotation=-?90/.test(probe), 'rotation lost');

  // the merged sound must now line up with the phone's own sound at the start and the end
  for (const at of [5, videoSeconds - 10]) {
    const a = await sync.decode(ffmpeg, final, at, 4, 8000);
    const b = await sync.decode(ffmpeg, path.join(out, 'phone-rot.mov'), at - 0.5, 5, 8000);
    const { lag } = sync.locate(b, a, 8000);
    const err = (lag / 8000 - 0.5) * 1000;
    console.log(`at ${at}s the PC sound is ${err.toFixed(2)} ms from the phone sound`);
    assert(Math.abs(err) < 2, 'not in sync');
  }
  console.log('sync test passed');
})().catch(e => { console.error(e); process.exit(1); });
