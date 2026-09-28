require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const {
  startCameraWatcher, reclassifyReport, processFrame, recordUnreachable, loadCameras,
  isWithinBusinessHours, IDLE_THRESHOLD_MIN,
} = require('./integrations/camera');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
}));

let db;

// ── Auth ─────────────────────────────────────────────────────────────────
// Single shared password, session cookie. No per-user accounts — anyone
// with the password sees everything. Deliberately simple: this is a
// single-purpose reporting tool, not a multi-tenant admin system.
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

app.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD is not configured on the server' });
  }
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  req.session.authenticated = true;
  res.json({ ok: true });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

// ── Camera reports ───────────────────────────────────────────────────────

app.get('/api/camera-reports', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const match = req.query.camera ? { camera: req.query.camera } : {};
    const rows = await db.collection('camera_reports').find(match).sort({ timestamp: -1 }).limit(limit).toArray();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/camera-reports/summary', requireAuth, async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const [byStatusRows, idleFlagsToday, lastCheck] = await Promise.all([
      db.collection('camera_reports').aggregate([
        { $match: { timestamp: { $gte: todayStart } } },
        { $group: { _id: { camera: '$camera', status: '$status' }, count: { $sum: 1 }, engaged: { $sum: { $ifNull: ['$engagedCount', 0] } }, disengaged: { $sum: { $ifNull: ['$disengagedCount', 0] } }, onPhone: { $sum: { $ifNull: ['$onPhoneCount', 0] } } } },
      ]).toArray(),
      db.collection('idle_flags').countDocuments({ timestamp: { $gte: todayStart } }),
      db.collection('camera_reports').find({ timestamp: { $gte: todayStart } }).sort({ timestamp: -1 }).limit(1).toArray(),
    ]);

    const cameraMap = {};
    const byStatus = {};
    let totalChecks = 0, totalEngaged = 0, totalDisengaged = 0, totalOnPhone = 0;
    byStatusRows.forEach(row => {
      const cam = row._id.camera;
      cameraMap[cam] = cameraMap[cam] || { camera: cam, WORKING: 0, IDLE: 0, MIXED: 0, EMPTY: 0, UNREACHABLE: 0, total: 0 };
      cameraMap[cam][row._id.status] = row.count;
      cameraMap[cam].total += row.count;
      byStatus[row._id.status] = (byStatus[row._id.status] || 0) + row.count;
      totalChecks += row.count;
      totalEngaged += row.engaged;
      totalDisengaged += row.disengaged;
      totalOnPhone += row.onPhone;
    });

    res.json({
      totalChecks, byStatus, totalEngaged, totalDisengaged, totalOnPhone,
      idleFlagsToday, lastCheckAt: lastCheck[0]?.timestamp || null,
      cameras: Object.values(cameraMap),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/camera-reports/:id/frame', requireAuth, async (req, res) => {
  try {
    const report = await db.collection('camera_reports').findOne({ _id: new ObjectId(req.params.id) });
    if (!report || !report.frameId) return res.status(404).end();
    const bucket = new GridFSBucket(db, { bucketName: 'camera_frames' });
    res.set('Content-Type', 'image/jpeg');
    bucket.openDownloadStream(report.frameId)
      .on('error', () => res.status(404).end())
      .pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/camera-reports/:id/mark-reference', requireAuth, async (req, res) => {
  try {
    const note = (req.body?.note || '').trim();
    if (!note) return res.status(400).json({ error: 'note is required' });
    const report = await db.collection('camera_reports').findOne({ _id: new ObjectId(req.params.id) });
    if (!report) return res.status(404).json({ error: 'Report not found' });
    await db.collection('camera_reports').updateOne({ _id: report._id }, { $set: { referenceNote: note.slice(0, 300) } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/camera-reports/:id/mark-reference', requireAuth, async (req, res) => {
  try {
    await db.collection('camera_reports').updateOne({ _id: new ObjectId(req.params.id) }, { $unset: { referenceNote: '' } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/camera-reports/:id/mark-engagement', requireAuth, async (req, res) => {
  try {
    const note = (req.body?.note || '').trim();
    if (!note) return res.status(400).json({ error: 'note is required' });
    const report = await db.collection('camera_reports').findOne({ _id: new ObjectId(req.params.id) });
    if (!report) return res.status(404).json({ error: 'Report not found' });
    await db.collection('camera_reports').updateOne({ _id: report._id }, { $set: { engagementNote: note.slice(0, 300) } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/camera-reports/:id/mark-engagement', requireAuth, async (req, res) => {
  try {
    await db.collection('camera_reports').updateOne({ _id: new ObjectId(req.params.id) }, { $unset: { engagementNote: '' } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/camera-reports/:id/reclassify', requireAuth, async (req, res) => {
  try {
    const result = await reclassifyReport(db, new ObjectId(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Labeling — bounding boxes on stored frames, exported as a YOLO dataset ─
// Boxes live on the report itself (`labelBoxes`), in normalized 0–1 coords.
// A box can carry several classes at once (e.g. person + engaged + sitting)
// so the operator draws each person once; export writes one YOLO line per
// (box, class) pair. Labeled frames are exempt from retention cleanup.

const LABEL_CLASSES = ['person', 'phone', 'engaged', 'disengaged', 'sitting', 'standing'];
// Pairs that can't both apply to the same box.
const EXCLUSIVE_CLASSES = [['engaged', 'disengaged'], ['sitting', 'standing']];
// Every VAL_EVERY_NTH labeled frame goes to the val split.
const VAL_EVERY_NTH = 6;

function validateBoxes(boxes) {
  if (!Array.isArray(boxes)) return null;
  const clean = [];
  for (const b of boxes) {
    if (!b || typeof b !== 'object') return null;
    const { x1, y1, x2, y2, classes } = b;
    if (![x1, y1, x2, y2].every(n => typeof n === 'number' && n >= 0 && n <= 1)) return null;
    if (x2 <= x1 || y2 <= y1) return null;
    if (!Array.isArray(classes) || classes.length === 0) return null;
    const uniq = [...new Set(classes)];
    if (!uniq.every(c => LABEL_CLASSES.includes(c))) return null;
    if (EXCLUSIVE_CLASSES.some(([a, c]) => uniq.includes(a) && uniq.includes(c))) return null;
    clean.push({ x1, y1, x2, y2, classes: uniq });
  }
  return clean;
}

app.get('/api/labeling/frames', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const match = { frameId: { $ne: null } };
    if (req.query.camera) match.camera = req.query.camera;
    if (req.query.filter === 'labeled') match.labelBoxes = { $ne: null };
    if (req.query.filter === 'unlabeled') match.labelBoxes = null;
    const [rows, labeledTotal, frameTotal] = await Promise.all([
      db.collection('camera_reports').find(match)
        .project({ camera: 1, zone: 1, timestamp: 1, status: 1, peopleCount: 1, labelBoxes: 1 })
        .sort({ timestamp: -1 }).limit(limit).toArray(),
      db.collection('camera_reports').countDocuments({ frameId: { $ne: null }, labelBoxes: { $ne: null } }),
      db.collection('camera_reports').countDocuments({ frameId: { $ne: null } }),
    ]);
    res.json({ rows, labeledTotal, frameTotal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/camera-reports/:id/label', requireAuth, async (req, res) => {
  try {
    const boxes = validateBoxes(req.body?.boxes);
    if (!boxes) return res.status(400).json({ error: 'invalid boxes' });
    const update = boxes.length
      ? { $set: { labelBoxes: boxes, labeledAt: new Date() } }
      : { $unset: { labelBoxes: '', labeledAt: '' } };
    const result = await db.collection('camera_reports').updateOne({ _id: new ObjectId(req.params.id), frameId: { $ne: null } }, update);
    if (!result.matchedCount) return res.status(404).json({ error: 'Report not found or has no frame' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Streams a ready-to-train YOLO dataset (images + labels + dataset.yaml) as a
// zip download — nothing is written to the server's disk.
app.get('/api/labeling/export', requireAuth, async (req, res) => {
  try {
    const labeled = await db.collection('camera_reports')
      .find({ frameId: { $ne: null }, labelBoxes: { $ne: null } })
      .project({ camera: 1, timestamp: 1, frameId: 1, labelBoxes: 1 })
      .sort({ timestamp: 1 }).toArray();

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="camera_dataset.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { console.error('[labeling] export failed:', err.message); res.destroy(err); });
    archive.pipe(res);

    archive.append(LABEL_CLASSES.join('\n') + '\n', { name: 'classes.txt' });
    archive.append([
      'path: .',
      'train: images/train',
      'val: images/val',
      'names:',
      ...LABEL_CLASSES.map((c, i) => `  ${i}: ${c}`),
      '',
    ].join('\n'), { name: 'dataset.yaml' });

    const bucket = new GridFSBucket(db, { bucketName: 'camera_frames' });
    labeled.forEach((r, i) => {
      const split = i % VAL_EVERY_NTH === VAL_EVERY_NTH - 1 ? 'val' : 'train';
      const cam = String(r.camera || 'camera').replace(/[^a-z0-9]+/gi, '_');
      const base = `${cam}_${new Date(r.timestamp).toISOString().replace(/[:.]/g, '-')}_${r._id}`;
      const lines = [];
      r.labelBoxes.forEach(b => {
        const xc = ((b.x1 + b.x2) / 2).toFixed(6);
        const yc = ((b.y1 + b.y2) / 2).toFixed(6);
        const w = (b.x2 - b.x1).toFixed(6);
        const h = (b.y2 - b.y1).toFixed(6);
        b.classes.forEach(c => lines.push(`${LABEL_CLASSES.indexOf(c)} ${xc} ${yc} ${w} ${h}`));
      });
      archive.append(lines.join('\n') + '\n', { name: `labels/${split}/${base}.txt` });
      archive.append(bucket.openDownloadStream(r.frameId), { name: `images/${split}/${base}.jpg` });
    });

    await archive.finalize();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  }
});

// ── Alerts — idle flags + camera anomalies (MIXED / UNREACHABLE streaks) ──

app.get('/api/alerts', requireAuth, async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const [idleRows, cameraReportsToday] = await Promise.all([
      db.collection('idle_flags').find({ timestamp: { $gte: todayStart } }).sort({ timestamp: -1 }).limit(50).toArray(),
      db.collection('camera_reports').find({ timestamp: { $gte: todayStart } }).sort({ timestamp: 1 }).toArray(),
    ]);

    const items = [];
    idleRows.forEach(f => {
      const message = `${f.zone} (${f.camera}) idle ${f.durationMin} min` + (f.note ? ` — ${f.note}` : '');
      items.push({ type: 'idle', severity: 'warning', time: f.timestamp, message });
    });

    cameraReportsToday.filter(r => r.status === 'MIXED').forEach(r => {
      const message = `${r.zone} (${r.camera}) — ${r.disengagedCount} of ${r.peopleCount} not working` + (r.note ? ` — ${r.note}` : '');
      items.push({ type: 'camera-mixed', severity: 'warning', time: r.timestamp, message });
    });

    // A camera stuck failing shouldn't just go quiet — surface one alert per
    // camera (not one per failed check) covering the trailing streak of
    // UNREACHABLE reports.
    const reportsByCamera = {};
    cameraReportsToday.forEach(r => { (reportsByCamera[r.camera] = reportsByCamera[r.camera] || []).push(r); });
    Object.entries(reportsByCamera).forEach(([camera, reports]) => {
      let streakCount = 0;
      for (let i = reports.length - 1; i >= 0; i--) {
        if (reports[i].status !== 'UNREACHABLE') break;
        streakCount++;
      }
      if (streakCount === 0) return;
      const last = reports[reports.length - 1];
      const since = reports[reports.length - streakCount].timestamp;
      const message = `${camera} unreachable since ${new Date(since).toLocaleTimeString()} (${streakCount} failed check${streakCount === 1 ? '' : 's'})`;
      items.push({
        type: 'camera', severity: streakCount >= 2 ? 'critical' : 'warning', time: last.timestamp, message,
      });
    });

    items.sort((a, b) => new Date(b.time) - new Date(a.time));
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/idle-flags', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 200);
    const rows = await db.collection('idle_flags').find({}).sort({ timestamp: -1 }).limit(limit).toArray();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Camera relay — script serving + self-registration ─────────────────────
// See docs/camera-relay.md. Neither route is session-gated — the relay
// device isn't a logged-in browser, it authenticates with
// CAMERA_RELAY_SECRET instead.

app.get('/api/camera-relay/script', (req, res) => {
  if (!process.env.CAMERA_RELAY_SECRET || req.query.secret !== process.env.CAMERA_RELAY_SECRET) {
    return res.status(403).send('Forbidden');
  }
  let cameras = [];
  try { cameras = JSON.parse(process.env.CAMERAS_CONFIG || '[]'); } catch {}
  const cameraName = req.query.camera || cameras[0]?.name || 'Camera 1';
  const rtspUrl = process.env.CAMERA_RELAY_RTSP_URL || '';
  // Heroku (and most PaaS) terminate TLS at the edge and forward internally
  // over plain HTTP — req.protocol reports "http" even in production, so
  // this is hardcoded rather than trusted from the request.
  const registerUrl = `https://${req.get('host')}/api/camera-relay/register`;
  const template = fs.readFileSync(path.join(__dirname, 'templates', 'camera-relay.template'), 'utf8');
  const script = template
    .replace('{{CAMERA_NAME}}', JSON.stringify(cameraName))
    .replace('{{RTSP_URL}}', JSON.stringify(rtspUrl))
    .replace('{{SECRET}}', JSON.stringify(process.env.CAMERA_RELAY_SECRET))
    .replace('{{REGISTER_URL}}', JSON.stringify(registerUrl));
  res.set('Content-Type', 'text/javascript');
  res.send(script);
});

app.post('/api/camera-relay/register', async (req, res) => {
  try {
    const { camera, url, secret } = req.body || {};
    if (!process.env.CAMERA_RELAY_SECRET || secret !== process.env.CAMERA_RELAY_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!camera || !url) return res.status(400).json({ error: 'camera and url are required' });
    await db.collection('camera_relays').updateOne(
      { _id: camera },
      { $set: { url, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Push relay — on-site script uploads DVR snapshots (see relay/push-relay.js)
// The relay only ever makes OUTBOUND requests to these routes; nothing on
// the camera's LAN is reachable from outside. It authenticates with the
// X-Relay-Secret header (CAMERA_RELAY_SECRET). Which cameras to capture, how
// often, and whether it's business hours are all decided here, so changing
// CAMERAS_CONFIG never requires touching the on-site machine.

const RELAY_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

function relaySecretOk(given) {
  const expected = process.env.CAMERA_RELAY_SECRET;
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireRelaySecret(req, res, next) {
  if (!relaySecretOk(req.get('X-Relay-Secret'))) return res.status(403).json({ error: 'Forbidden' });
  if (!RELAY_NAME_RE.test(req.query.relay || '')) return res.status(400).json({ error: 'relay name required' });
  next();
}

function pushCamerasFor(relay) {
  return loadCameras().filter(c => c.push === relay);
}

app.get('/api/camera-relay/push-config', requireRelaySecret, async (req, res) => {
  try {
    const relay = req.query.relay;
    await db.collection('camera_relays').updateOne(
      { _id: relay },
      { $set: { mode: 'push', lastSeenAt: new Date(), version: String(req.query.v || '') } },
      { upsert: true }
    );
    res.json({
      active: isWithinBusinessHours(),
      intervalMin: IDLE_THRESHOLD_MIN,
      cameras: pushCamerasFor(relay).map(c => ({ name: c.name, channel: c.channel })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/camera-relay/push-frame', requireRelaySecret, express.raw({ type: 'image/jpeg', limit: '8mb' }), async (req, res) => {
  const cam = pushCamerasFor(req.query.relay).find(c => c.name === req.query.camera);
  if (!cam) return res.status(404).json({ error: 'Unknown camera for this relay' });
  const frame = req.body;
  if (!Buffer.isBuffer(frame) || frame.length < 3 || frame[0] !== 0xFF || frame[1] !== 0xD8) {
    return res.status(400).json({ error: 'Body must be a JPEG (Content-Type: image/jpeg)' });
  }
  // Outside business hours: accept but don't classify — no API cost.
  if (!isWithinBusinessHours()) return res.status(202).json({ ok: true, skipped: 'outside business hours' });
  // Classification takes several seconds; acknowledge now, process after.
  res.status(202).json({ ok: true });
  processFrame(db, cam, frame).catch(err => console.error(`[camera] ${cam.name} pushed frame failed:`, err.message));
});

app.post('/api/camera-relay/push-error', requireRelaySecret, async (req, res) => {
  try {
    const cam = pushCamerasFor(req.query.relay).find(c => c.name === req.body?.camera);
    if (!cam) return res.status(404).json({ error: 'Unknown camera for this relay' });
    if (isWithinBusinessHours()) {
      await recordUnreachable(db, cam, `Relay: ${String(req.body.error || 'snapshot failed').slice(0, 300)}`);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The relay script itself holds no secrets (they live in the relay's local
// config.json), so it's served openly; the installer and the relay's
// self-update both fetch it from here.
app.get('/api/camera-relay/push-relay.js', (req, res) => {
  res.set('Content-Type', 'text/javascript');
  res.sendFile(path.join(__dirname, 'relay', 'push-relay.js'));
});

// macOS installer, pre-filled with this server's URL, the relay secret and
// the relay name: `curl -fsSL "<url>" | bash` on the on-site Mac. Prompts
// for the DVR address/login locally — those never leave the Mac.
app.get('/api/camera-relay/install-mac', (req, res) => {
  if (!relaySecretOk(req.query.secret)) return res.status(403).send('Forbidden');
  const relay = req.query.relay || 'warehouse';
  if (!RELAY_NAME_RE.test(relay)) return res.status(400).send('Bad relay name');
  // See the TLS note on /api/camera-relay/script above.
  const serverUrl = `https://${req.get('host')}`;
  const script = fs.readFileSync(path.join(__dirname, 'templates', 'install-push-relay-mac.sh'), 'utf8')
    .replace('{{SERVER_URL}}', serverUrl)
    .replace('{{SECRET}}', process.env.CAMERA_RELAY_SECRET)
    .replace('{{RELAY_NAME}}', relay);
  res.set('Content-Type', 'text/x-shellscript');
  res.send(script);
});

// ── Static client + boot ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

(async () => {
  const client = await MongoClient.connect(process.env.MONGO_LINK);
  db = client.db(process.env.MONGO_DB_NAME || undefined);
  console.log('[db] connected');
  startCameraWatcher(db);
  app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
})().catch(err => {
  console.error('[boot] failed:', err.message);
  process.exit(1);
});
