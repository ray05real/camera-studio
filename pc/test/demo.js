'use strict';
// Runs the PC app against the fake iPhone, for trying the page without the real phone:
//   node pc/test/demo.js     then open http://127.0.0.1:5811
// Videos go to pc/test/out/demo-videos; nothing touches the real Videos folder or settings.

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const { startFakePhone } = require('./fake-phone');

const out = path.join(__dirname, 'out');
const port = Number(process.env.CAMERA_STUDIO_PORT) || 5811;

(async () => {
  const video = path.join(out, 'phone-rot.mov');
  const fake = await startFakePhone(fs.existsSync(video) ? { video, videoDuration: 120 } : {});
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--no-window', '--stay'], {
    env: { ...process.env, CAMERA_STUDIO_PORT: String(port), CAMERA_STUDIO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cs-demo-')),
      CAMERA_STUDIO_OUT: path.join(out, 'demo-videos') },
    stdio: 'inherit',
  });
  setTimeout(() => {
    const body = JSON.stringify({ address: '127.0.0.1' });
    const req = http.request({ host: '127.0.0.1', port, path: '/api/connect', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Camera-Studio': '1', 'Content-Length': body.length } });
    req.on('error', () => {});
    req.end(body);
  }, 1000);
  const stop = () => { server.kill(); fake.close(); process.exit(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.on('exit', stop);
})();
