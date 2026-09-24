require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const { startCameraWatcher, reclassifyReport } = require('./integrations/camera');

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
