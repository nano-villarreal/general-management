// Push relay — runs on an always-on computer on the camera's LAN.
//
// Fetches JPEG snapshots from a Hikvision/HiLook DVR/NVR (ISAPI, HTTP digest
// auth) and uploads them to the Camera Reports server. It only makes
// OUTBOUND requests: nothing on the LAN becomes reachable from outside.
// Which cameras to capture, how often, and whether it's business hours all
// come from the server (GET /api/camera-relay/push-config), so changing
// CAMERAS_CONFIG never requires touching this machine.
//
// Config lives next to this file in config.json (written by the installer,
// chmod 600 — it holds the DVR password, which never leaves this machine):
//   { "server": "https://...", "secret": "...", "relay": "warehouse",
//     "dvr": { "host": "192.168.1.67", "user": "...", "pass": "..." } }
//
// No npm dependencies, and deliberately old-Node-compatible syntax (no ?.
// or ??) so it runs on whatever Node an old machine can install. Uses the
// system `curl` for the DVR's digest auth.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const VERSION = '1';
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const POLL_MS = 60 * 1000;
// Hikvision locks out an address after a handful of failed logins, so a
// wrong password must not be retried every round.
const DVR_AUTH_BACKOFF_MS = 30 * 60 * 1000;

let lastRoundAt = 0;
let dvrAuthBlockedUntil = 0;
let roundInProgress = false;

function log() {
  const args = Array.prototype.slice.call(arguments);
  console.log.apply(console, [new Date().toISOString()].concat(args));
}

function request(method, urlPath, body, contentType) {
  return new Promise(function (resolve, reject) {
    const url = new URL(CONFIG.server + urlPath);
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { 'X-Relay-Secret': CONFIG.secret };
    if (body) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = body.length;
    }
    const req = lib.request(url, { method: method, headers: headers, timeout: 30000 }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(method + ' ' + urlPath.split('?')[0] + ' -> HTTP ' + res.statusCode + ' ' + text.slice(0, 200)));
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* non-JSON is fine */ }
        resolve(json);
      });
    });
    req.on('timeout', function () { req.destroy(new Error('request timed out')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function qs(extra) {
  let q = '?relay=' + encodeURIComponent(CONFIG.relay);
  Object.keys(extra || {}).forEach(function (k) { q += '&' + k + '=' + encodeURIComponent(extra[k]); });
  return q;
}

function snapshot(channel) {
  return new Promise(function (resolve, reject) {
    const tmp = path.join(os.tmpdir(), 'camera-relay-ch' + channel + '.jpg');
    const url = 'http://' + CONFIG.dvr.host + '/ISAPI/Streaming/channels/' + channel + '01/picture';
    execFile('curl', [
      '-s', '--digest', '-u', CONFIG.dvr.user + ':' + CONFIG.dvr.pass,
      '-m', '15', '-o', tmp, '-w', '%{http_code}', url,
    ], { timeout: 20000 }, function (err, stdout) {
      const code = String(stdout || '').trim();
      let buf = null;
      try { buf = fs.readFileSync(tmp); fs.unlinkSync(tmp); } catch (e) { /* no body */ }
      if (code === '401' || code === '403') {
        const e = new Error('DVR rejected the login (HTTP ' + code + ') — check the user/password in config.json');
        e.auth = true;
        return reject(e);
      }
      if (err && !code) return reject(new Error('could not reach the DVR at ' + CONFIG.dvr.host + ' (' + err.message + ')'));
      if (code !== '200') return reject(new Error('DVR returned HTTP ' + code + ' for channel ' + channel));
      if (!buf || buf.length < 3 || buf[0] !== 0xFF || buf[1] !== 0xD8) return reject(new Error('DVR returned a non-JPEG response for channel ' + channel));
      resolve(buf);
    });
  });
}

function reportError(cam, message) {
  return request('POST', '/api/camera-relay/push-error' + qs(),
    Buffer.from(JSON.stringify({ camera: cam.name, error: message })), 'application/json')
    .catch(function (e) { log('could not report error for', cam.name + ':', e.message); });
}

async function captureRound(cameras) {
  for (const cam of cameras) {
    if (Date.now() < dvrAuthBlockedUntil) {
      await reportError(cam, 'DVR login was rejected earlier — waiting before retrying so the DVR does not lock this computer out. Check the password in config.json.');
      continue;
    }
    try {
      const jpg = await snapshot(cam.channel);
      await request('POST', '/api/camera-relay/push-frame' + qs({ camera: cam.name }), jpg, 'image/jpeg');
      log('sent', cam.name, '(ch ' + cam.channel + ',', jpg.length, 'bytes)');
    } catch (e) {
      log('failed', cam.name + ':', e.message);
      if (e.auth) dvrAuthBlockedUntil = Date.now() + DVR_AUTH_BACKOFF_MS;
      await reportError(cam, e.message);
    }
  }
}

async function tick() {
  if (roundInProgress) return;
  let cfg;
  try {
    cfg = await request('GET', '/api/camera-relay/push-config' + qs({ v: VERSION }));
  } catch (e) {
    log('cannot reach server:', e.message);
    return;
  }
  if (!cfg || !cfg.active || !cfg.cameras || !cfg.cameras.length) return;
  const intervalMs = (cfg.intervalMin || 15) * 60 * 1000;
  if (Date.now() - lastRoundAt < intervalMs - 5000) return;
  lastRoundAt = Date.now();
  roundInProgress = true;
  try {
    await captureRound(cfg.cameras);
  } finally {
    roundInProgress = false;
  }
}

log('push relay "' + CONFIG.relay + '" v' + VERSION + ' starting — server ' + CONFIG.server + ', DVR ' + CONFIG.dvr.host);
tick();
setInterval(tick, POLL_MS);
