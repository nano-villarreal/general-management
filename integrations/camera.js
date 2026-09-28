// Camera watcher — every IDLE_THRESHOLD_MIN minutes, per camera, grabs one
// frame and asks Claude to count every person visible and classify each
// one's engagement (actively working vs. present-but-not-working — on a
// phone, sitting idle, chatting), plus a short note on what it saw. That
// collapses to a `status` (EMPTY = no one, WORKING = everyone engaged,
// IDLE = present but nobody engaged, MIXED = some of both) so the
// alerting/summary logic has a simple field to key off, while the actual
// per-person counts are stored alongside for the real question people
// care about: how many were engaged vs. not, not just a single yes/no.
// Every check writes a row to `camera_reports` — a full ops log, not just
// alerts, so "nothing wrong" checks are visible too, not only flagged ones.
// A check classified IDLE also writes to `idle_flags` for the alert feed.
//
// Cost note: this calls the Claude API once per camera every
// IDLE_THRESHOLD_MIN minutes, unconditionally — the point is a periodic
// report, not just alerting on stillness.
//
// This runs as part of the main server (see startCameraWatcher(db) in
// server.js) — PROVIDED the camera's frame is reachable somehow, since a
// hosted server has no route to a private LAN IP (e.g. 192.168.x.x). Two
// ways to get there, depending on the network:
//
// OPTION A — direct RTSP port forward (works only with a real, non-CGNAT
// public IP on the router):
//   1. On the camera: enable RTSP and create a username/password for it
//      (make it strong — see security note below).
//   2. On the router: forward an external TCP port (pick something
//      non-default, e.g. 55554) to the camera's internal IP on port 554.
//   3. Set up Dynamic DNS on the router (DuckDNS / No-IP / etc.) so the
//      endpoint survives the ISP changing your IP.
//   4. Set CAMERAS_CONFIG in your host's config vars as JSON, using the
//      public DDNS hostname and forwarded port instead of the LAN IP:
//      [{"name":"Front Desk","zone":"Lobby","rtspUrl":"rtsp://user:pass@yourhost.duckdns.org:55554/stream1"}]
//   Many ISPs (cable/fiber consumer plans especially) put you behind CGNAT —
//   a shared public IP that makes inbound port-forwarding impossible no
//   matter how it's configured. Symptom: the TCP connection just hangs with
//   no response, never a clean refusal. If that's your situation, use B.
//
// OPTION B — relay through a small always-on device on the camera's own LAN
// (an old phone works fine — see docs/camera-relay.md for the full setup).
// The relay grabs frames locally (no inbound reachability needed at all,
// since it's the relay initiating an OUTBOUND tunnel) and exposes them over
// HTTPS; this file just fetches whatever URL it last self-registered via
// POST /api/camera-relay/register (see server.js) — that indirection exists
// because tunnel URLs are ephemeral and change on every relay restart, so a
// static rtspUrl config value wouldn't survive one.
//   1. Set CAMERAS_CONFIG with relay:true instead of rtspUrl:
//      [{"name":"Front Desk","zone":"Lobby","relay":true}]
//   2. Set CAMERA_RELAY_SECRET to a random string — the relay device and
//      this server both need it (the relay to authenticate its
//      registration and snapshot requests, this server to verify them).
//   3. Set up the relay device per docs/camera-relay.md.
//
// OPTION C — push relay (recommended; no inbound access to the LAN at all).
// A small script on an always-on computer on the camera's LAN
// (relay/push-relay.js) fetches JPEG snapshots from the DVR/NVR and uploads
// them to this server; nothing on the LAN is ever reachable from outside.
//   1. Set CAMERAS_CONFIG with push:<relay name> and the DVR channel:
//      [{"name":"Camera 04","zone":"Workshop","push":"warehouse","channel":4}]
//   2. Set CAMERA_RELAY_SECRET (shared with the relay).
//   3. Install the relay per docs/camera-relay.md ("Push relay").
//
// Either way:
//   - Set ANTHROPIC_API_KEY — required now, since every check needs a
//     classification (no motion-only fallback).
//   - Set ENABLE_CAMERAS=true to turn the watcher on.
//   - ffmpeg itself needs no setup on this server — bundles a static binary
//     (ffmpeg-static) so it works the same in the cloud and locally with no
//     buildpack or PATH configuration. (Option B's relay device needs its
//     own ffmpeg — see docs/camera-relay.md.)
//
// SECURITY: Option A exposes RTSP directly to the internet — that port is
// scannable, and most consumer cameras' RTSP auth is plain (no TLS).
// Mitigate with a strong password, a non-default external port, and current
// camera firmware. Option B's relay only accepts the shared-secret
// /snapshot request over HTTPS — never expose it without that check.

const { execFile } = require('child_process');
const { GridFSBucket } = require('mongodb');
const { detectPersonsAndPhones } = require('../lib/yoloDetect');
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');

// ── Frame storage (GridFS) ────────────────────────────────────────────────
// Every check's frame is stored so it can be annotated with a real
// operational description later (see POST /api/camera-reports/:id/mark-
// reference in server.js) and so visualCompletionPct (below) has something
// to compare against. Frames older than FRAME_RETENTION_DAYS are pruned
// (see cleanupOldFrames) — kept unconditionally otherwise, this would grow
// unbounded. Annotated (referenceNote set) and box-labeled (labelBoxes set,
// see the Labeling tab) frames are exempt from cleanup,
// since deleting one of the labeled examples would silently degrade the
// comparison set.
const FRAME_RETENTION_DAYS = parseInt(process.env.FRAME_RETENTION_DAYS) || 30;

function storeFrame(db, frame, cam) {
  const bucket = new GridFSBucket(db, { bucketName: 'camera_frames' });
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(`${cam.name}-${Date.now()}.jpg`, {
      contentType: 'image/jpeg',
      metadata: { camera: cam.name, zone: cam.zone },
    });
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => resolve(uploadStream.id));
    uploadStream.end(frame);
  });
}

function fetchFrame(db, frameId) {
  const bucket = new GridFSBucket(db, { bucketName: 'camera_frames' });
  const chunks = [];
  return new Promise((resolve, reject) => {
    bucket.openDownloadStream(frameId)
      .on('data', c => chunks.push(c))
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks)));
  });
}

let lastFrameCleanup = 0;
async function cleanupOldFrames(db) {
  if (Date.now() - lastFrameCleanup < 24 * 60 * 60 * 1000) return; // once a day is plenty
  lastFrameCleanup = Date.now();
  try {
    const cutoff = new Date(Date.now() - FRAME_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const old = await db.collection('camera_reports')
      .find({ timestamp: { $lt: cutoff }, frameId: { $ne: null }, referenceNote: null, labelBoxes: null })
      .project({ frameId: 1 })
      .toArray();
    if (!old.length) return;
    const bucket = new GridFSBucket(db, { bucketName: 'camera_frames' });
    for (const r of old) await bucket.delete(r.frameId).catch(() => {}); // already gone is fine
    await db.collection('camera_reports').updateMany(
      { _id: { $in: old.map(r => r._id) } },
      { $set: { frameId: null } }
    );
    console.log(`[camera] cleaned up ${old.length} frame(s) older than ${FRAME_RETENTION_DAYS} days`);
  } catch (err) {
    console.error('[camera] frame cleanup failed:', err.message);
  }
}

// Cap how many annotated example images get sent to Claude per check — each
// one adds real request cost. Most-recent-first: fresher operator notes
// reflect the site's current workflow/context better than stale ones, so if
// more than this are annotated, keep the newest.
const MAX_REFERENCE_IMAGES = 8;

async function getReferenceSet(db, cameraName, excludeId = null) {
  const query = { camera: cameraName, referenceNote: { $ne: null }, frameId: { $ne: null } };
  if (excludeId) query._id = { $ne: excludeId };
  const docs = await db.collection('camera_reports')
    .find(query)
    .sort({ timestamp: -1 })
    .limit(MAX_REFERENCE_IMAGES)
    .toArray();
  if (!docs.length) return [];
  const withFrames = await Promise.all(docs.map(async d => ({
    note: d.referenceNote,
    frame: await fetchFrame(db, d.frameId).catch(() => null),
  })));
  return withFrames.filter(r => r.frame);
}

// Every operator annotation ever written for this camera, compiled into one
// always-on text block. This is a different, complementary channel from the
// reference PHOTOS above: those only help when the current frame happens to
// visually resemble one of the up-to-8 most recent annotated images, so
// context an operator wrote once (a client's naming pattern, what a zone is
// normally used for, equipment names, a recurring false positive) only
// reached the model on the checks that happened to look similar. Plain text
// is cheap, so this pulls a much larger window (up to MAX_TEXT_CONTEXT_NOTES)
// and includes it on every single check for this camera, unconditionally —
// not gated on any visual match.
const MAX_TEXT_CONTEXT_NOTES = 50;

async function getOperatorNotes(db, cameraName, excludeId = null) {
  const query = { camera: cameraName, referenceNote: { $ne: null } };
  if (excludeId) query._id = { $ne: excludeId };
  return db.collection('camera_reports')
    .find(query)
    .project({ referenceNote: 1, timestamp: 1 })
    .sort({ timestamp: -1 })
    .limit(MAX_TEXT_CONTEXT_NOTES)
    .toArray();
}

function buildOperatorContextBlock(notes) {
  if (!notes.length) return null;
  const lines = notes
    .slice().reverse() // oldest first — reads as a history, not a random list
    .map(n => `- ${new Date(n.timestamp).toISOString().slice(0, 10)}: ${n.referenceNote}`)
    .join('\n');
  return `Operator-written notes about this zone from past checks — real operational `
    + `knowledge (workflow stage, what's normal here, equipment/layout) that isn't visible `
    + `from the image alone. Use these to recognize recurring patterns and write a more `
    + `specific, grounded note, even if the current frame doesn't closely resemble any one `
    + `of them. Do NOT use them to guess which client/order/person is currently in frame — a `
    + `past note mentioning a specific name says only that it was true on THAT occasion, not `
    + `that a similar-looking scene today is the same:\n${lines}`;
}

// A SEPARATE calibration channel from the two above — this one corrects
// engagedCount/disengagedCount/onPhoneCount judgment errors specifically
// (a false positive/negative on who's "on their phone" or "disengaged"),
// which the workflow-context block above deliberately does not touch (it
// only steers the free-text note and visualCompletionPct). Text-only by
// design — cheap, and correcting a judgment rule is usually describable in
// words ("device-in-hand near a workstation isn't phone use here") without
// needing to attach the specific frame it was noticed on.
const MAX_ENGAGEMENT_NOTES = 50;

async function getEngagementCorrections(db, cameraName, excludeId = null) {
  const query = { camera: cameraName, engagementNote: { $ne: null } };
  if (excludeId) query._id = { $ne: excludeId };
  return db.collection('camera_reports')
    .find(query)
    .project({ engagementNote: 1, timestamp: 1 })
    .sort({ timestamp: -1 })
    .limit(MAX_ENGAGEMENT_NOTES)
    .toArray();
}

function buildEngagementContextBlock(notes) {
  if (!notes.length) return null;
  const lines = notes
    .slice().reverse()
    .map(n => `- ${new Date(n.timestamp).toISOString().slice(0, 10)}: ${n.engagementNote}`)
    .join('\n');
  return `Operator corrections to past engagement/phone-use judgments for this zone — `
    + `each one flags a specific engagedCount/disengagedCount/onPhoneCount call that was `
    + `wrong, and why. Use these to calibrate what actually counts as disengaged or on-phone `
    + `HERE (equipment, layout, or postures that look like idleness/phone use but normally `
    + `aren't, or genuine misses this zone tends to produce), on every check — not just when `
    + `today's frame looks like the one the correction was made on:\n${lines}`;
}

// A local, free, zero-API-cost object-detector second opinion (see
// lib/yoloDetect.js) — deterministic, not a language-model guess, but a
// generic COCO detector with its own real false positives (a
// scanner/remote/radio can look like a phone) and false negatives (a phone
// held low or angled away is easy to miss). Framed to Claude as a hint to
// weigh, not a verdict — its own visual judgment of the rules above still
// decides the final counts.
function buildYoloContextBlock(detection) {
  if (!detection) return null;
  return `Local object-detector pre-check (a separate, deterministic system — not this vision `
    + `model, and not infallible): detected ${detection.personCount} person-shaped region(s) and `
    + `${detection.phoneCount} phone-shaped object(s) in this frame, of which `
    + `${detection.phonesNearPerson} phone(s) are positioned near a detected person. Treat this `
    + `as a hint to look closely at — generic object detectors mistake other handheld items `
    + `(scanners, remotes, radios) for phones, and can miss a phone held low or angled away. `
    + `Your own reading of the image against the rules above still decides the final counts.`;
}

const IDLE_THRESHOLD_MIN = parseInt(process.env.IDLE_THRESHOLD_MIN) || 15;
const MOTION_DIFF_THRESHOLD = 0.02; // fraction of sampled bytes that must differ to count as "motion"

// Only run checks during business hours — no point paying for a
// classification of an empty, closed building overnight. All three are
// configurable per-deployment since this runs at a different site/timezone
// than wherever it was first built for.
const BUSINESS_HOURS_TZ = process.env.BUSINESS_HOURS_TZ || 'America/Mexico_City';
function parseHHMM(s, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || '').trim());
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}
const BUSINESS_HOURS_START_MIN = parseHHMM(process.env.BUSINESS_HOURS_START, 7 * 60 + 45);
const BUSINESS_HOURS_END_MIN = parseHHMM(process.env.BUSINESS_HOURS_END, 18 * 60);

function isWithinBusinessHours(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_HOURS_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find(p => p.type === 'hour').value) % 24; // ICU can report midnight as "24"
  const minute = Number(parts.find(p => p.type === 'minute').value);
  const minutesSinceMidnight = hour * 60 + minute;
  return minutesSinceMidnight >= BUSINESS_HOURS_START_MIN && minutesSinceMidnight < BUSINESS_HOURS_END_MIN;
}

// Per-camera state: previous frame, kept only to report whether the scene
// changed since the last check (informational — no longer gates anything).
const state = new Map();

const GRAB_TIMEOUT_MS = 15000; // bound each attempt — a camera that accepts the
// connection but never sends data would otherwise hang the check forever
// instead of failing fast enough for a retry to matter.

function grabFrame(rtspUrl) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      '-y', '-rtsp_transport', 'tcp', '-i', rtspUrl,
      '-frames:v', '1', '-q:v', '4', '-f', 'image2', 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024, timeout: GRAB_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        // ffmpeg's stderr is a multi-line version/config banner plus the
        // actual error at the end — Node appends the whole thing to
        // err.message, which is far too noisy to store/display. Keep just
        // the last couple of lines that actually mention the failure.
        const text = (Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr || '');
        const meaningful = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && /error|fail/i.test(l));
        return reject(new Error(meaningful.length ? meaningful.slice(-2).join(' — ') : err.message.split('\n')[0]));
      }
      resolve(stdout);
    });
  });
}

// Relay-based grab: for a camera behind CGNAT/an ISP firewall that makes
// direct inbound RTSP unreachable, a small always-on device on the camera's
// own LAN (see docs/camera-relay.md) grabs the frame locally and exposes it
// through an outbound tunnel, self-registering its current tunnel URL via
// POST /api/camera-relay/register (tunnel URLs are ephemeral — they change
// on every relay restart, hence the self-registration instead of a fixed
// config value). We just fetch whatever URL it last reported.
const RELAY_STALE_MS = 10 * 60 * 1000; // relay re-registers every ~4 min — 10 min dead air means it's down

async function grabFrameViaRelay(db, camName) {
  const relay = await db.collection('camera_relays').findOne({ _id: camName });
  if (!relay || !relay.url) throw new Error('No relay registered for this camera yet');
  if (Date.now() - new Date(relay.updatedAt).getTime() > RELAY_STALE_MS) {
    throw new Error('Relay registration is stale — the on-site relay device may be offline');
  }
  const res = await fetch(`${relay.url}/snapshot?key=${encodeURIComponent(process.env.CAMERA_RELAY_SECRET || '')}`, {
    signal: AbortSignal.timeout(GRAB_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Relay snapshot request failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('Relay returned an empty image');
  return buf;
}

// Consumer RTSP cameras reset connections for mundane reasons — someone has
// the live view open in a phone app, a momentary Wi-Fi blip, the
// concurrent-stream limit. A single failed grab isn't worth reporting as
// broken; only give up after a few tries.
const GRAB_RETRY_ATTEMPTS = 3;
const GRAB_RETRY_DELAY_MS = 5000;

async function grabFrameWithRetry(rtspUrl) {
  let lastErr;
  for (let attempt = 1; attempt <= GRAB_RETRY_ATTEMPTS; attempt++) {
    try {
      return await grabFrame(rtspUrl);
    } catch (err) {
      lastErr = err;
      if (attempt < GRAB_RETRY_ATTEMPTS) await new Promise(r => setTimeout(r, GRAB_RETRY_DELAY_MS));
    }
  }
  throw lastErr;
}

// Rough proxy for motion: fraction of sampled bytes that changed between
// frames. Informational only now, not a gate — kept because it's free
// (frame's already in memory) and useful context on the report.
function frameDiff(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 1;
  const len = Math.min(a.length, b.length);
  const stride = Math.max(1, Math.floor(len / 5000)); // sample ~5000 bytes
  let diff = 0, n = 0;
  for (let i = 0; i < len; i += stride) {
    if (a[i] !== b[i]) diff++;
    n++;
  }
  return diff / n;
}

const CLASSIFY_PROMPT_TEMPLATE = zone => `Analyze this still from a security camera covering "${zone}". Count every person visible and classify each one's engagement. Respond with ONLY valid JSON, no markdown code fences, no other text, in this exact shape:
{"engagedCount":<int>,"disengagedCount":<int>,"onPhoneCount":<int>REF_FIELD,"note":"<12 words max describing what you see>"}

Rules:
- This is a SINGLE still frame — you cannot see motion. A person paused mid-task (thinking, reaching, examining an item, waiting on something) looks identical in one photo to someone genuinely idle. Do not treat mere stillness as disengagement.
- engagedCount: people actively doing task-related work OR positioned at a workstation/task area with materials in front of them, even if momentarily still.
- disengagedCount: ONLY people with clear, unambiguous evidence of not working — visibly holding/looking at a phone, sitting or standing away from any task area with no materials or equipment nearby, eyes closed/sleeping, or clearly socializing (facing another person, talking, hands empty, not near a task). If you cannot tell whether someone is mid-task or idle, classify them as engaged, not disengaged.
- onPhoneCount: of the disengaged people, how many are specifically looking at or holding a phone — must be <= disengagedCount. 0 if none.
- engagedCount and disengagedCount are both 0 if no one is visible in frame.
- Do NOT state or guess any specific identity (which client, whose order, who a person is) unless something in the image itself clearly identifies it (a visible tag, label, sign, or distinctly marked item) — visually similar scenes routinely belong to different people/clients, and confidently naming the wrong one is worse than describing the activity generically without one. Visual resemblance to a past photo is NOT identification.
REF_RULE- note: brief, specific, in English — mention what the people (if any) are doing; call out phone use by name if onPhoneCount > 0. Also check the whole frame (not just people) for anything out of place or unsafe — a spill, smoke or fire, structural or equipment damage, a blocked exit, a fallen or motionless person, machinery left running unattended, etc. If you see one, start the note with "ANOMALY: " followed by what it is — prioritize this over describing routine activity. Be conservative: only flag genuine anomalies, never routine mess or clutter.`;

const REF_FIELD = ',"visualCompletionPct":<int 0-100>';
const REF_RULE = '- visualCompletionPct: you were shown reference photos captioned by staff describing what was ACTUALLY happening at that moment — what stage of the process it was, real operational detail you can\'t see on your own. Treat those captions as ground truth about this site\'s real workflow, not an abstract percentage scale. Judge where the CURRENT image falls relative to the progression described across those captions — lower if it resembles an earlier-stage reference, higher if it resembles a later, more-complete one — and estimate its completion percentage accordingly. Use the captions ONLY for judging workflow stage/progress, never to assert a specific identity — a photo looking similar to a reference does not mean it is the same client/person/order, since similar-looking scenes are common. If you are not sure which stage this resembles, say so rather than forcing a specific number.\n';

function buildClassifyPrompt(zone, hasReference) {
  const template = CLASSIFY_PROMPT_TEMPLATE(zone)
    .replace('REF_FIELD', hasReference ? REF_FIELD : '')
    .replace('REF_RULE', hasReference ? REF_RULE : '');
  return template;
}

// Claude sometimes wraps JSON in a ```json fence even when told not to —
// strip it before parsing rather than trust it'll always comply.
function parseClassification(raw, hasReference) {
  const cleaned = (raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  const toCount = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const engagedCount = toCount(parsed.engagedCount);
  const disengagedCount = toCount(parsed.disengagedCount);
  const onPhoneCount = Math.min(toCount(parsed.onPhoneCount), disengagedCount); // can't exceed disengaged
  const peopleCount = engagedCount + disengagedCount;
  const note = typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : null;
  const status = peopleCount === 0 ? 'EMPTY'
    : disengagedCount === 0 ? 'WORKING'
    : engagedCount === 0 ? 'IDLE'
    : 'MIXED'; // some engaged, some not — partial coverage of the zone
  let visualCompletionPct = null;
  if (hasReference) {
    const n = Math.round(Number(parsed.visualCompletionPct));
    if (Number.isFinite(n)) visualCompletionPct = Math.max(0, Math.min(100, n));
  }
  return { status, peopleCount, engagedCount, disengagedCount, onPhoneCount, visualCompletionPct, note };
}

async function classifyFrame(frame, zone, referenceSet = [], operatorContext = null, engagementContext = null, yoloContext = null) {
  if (!process.env.ANTHROPIC_API_KEY) return null; // can't classify without it — check is skipped
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const hasReference = referenceSet.length > 0;
  const content = [];
  if (operatorContext) {
    content.push({ type: 'text', text: operatorContext });
  }
  if (engagementContext) {
    content.push({ type: 'text', text: engagementContext });
  }
  if (hasReference) {
    referenceSet.forEach(ref => {
      content.push({ type: 'text', text: `Reference photo — operator note: "${ref.note}"` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ref.frame.toString('base64') } });
    });
    content.push({ type: 'text', text: 'Current image (classify this one):' });
  }
  if (yoloContext) {
    content.push({ type: 'text', text: yoloContext });
  }
  content.push({ type: 'text', text: buildClassifyPrompt(zone, hasReference) });
  content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frame.toString('base64') } });

  const res = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 150,
    messages: [{ role: 'user', content }],
  });
  try {
    return parseClassification(res.content[0]?.text, hasReference);
  } catch (e) {
    console.error('[camera] could not parse classification response:', e.message);
    return null;
  }
}

// A failed grab writes a report instead of only logging server-side, so a
// persistent failure is visible in the UI rather than just silently
// producing no data.
async function recordUnreachable(db, cam, message) {
  await db.collection('camera_reports').insertOne({
    camera: cam.name,
    zone: cam.zone,
    status: 'UNREACHABLE',
    peopleCount: null,
    engagedCount: null,
    disengagedCount: null,
    onPhoneCount: null,
    visualCompletionPct: null,
    note: null,
    error: message,
    changedSinceLastCheck: null,
    frameId: null,
    timestamp: new Date(),
  });
}

async function checkCamera(db, cam) {
  let frame;
  try {
    frame = cam.relay ? await grabFrameViaRelay(db, cam.name) : await grabFrameWithRetry(cam.rtspUrl);
  } catch (err) {
    // Still unreachable after retries.
    await recordUnreachable(db, cam, err.message);
    return;
  }
  await processFrame(db, cam, frame);
}

// Store + classify one frame, however it was obtained — grabbed by this
// server (checkCamera) or pushed up by an on-site relay (see server.js
// POST /api/camera-relay/push-frame).
async function processFrame(db, cam, frame) {
  const prev = state.get(cam.name) || { frame: null };
  const changedSinceLastCheck = frameDiff(prev.frame, frame) >= MOTION_DIFF_THRESHOLD;
  state.set(cam.name, { frame });

  const frameId = await storeFrame(db, frame, cam).catch(err => {
    console.error(`[camera] ${cam.name} frame storage failed:`, err.message);
    return null;
  });

  // If any prior frames for this camera have been labeled with a completion
  // percentage, fetch that calibration set and have Claude interpolate the
  // current frame against it — see POST /api/camera-reports/:id/mark-reference
  // in server.js.
  const referenceSet = await getReferenceSet(db, cam.name);
  const operatorNotes = await getOperatorNotes(db, cam.name);
  const operatorContext = buildOperatorContextBlock(operatorNotes);
  const engagementCorrections = await getEngagementCorrections(db, cam.name);
  const engagementContext = buildEngagementContextBlock(engagementCorrections);
  const yoloDetection = await detectPersonsAndPhones(frame);
  const yoloContext = buildYoloContextBlock(yoloDetection);

  const result = await classifyFrame(frame, cam.zone, referenceSet, operatorContext, engagementContext, yoloContext);
  if (!result) return; // no ANTHROPIC_API_KEY configured, or response didn't parse — nothing to report
  const { status, peopleCount, engagedCount, disengagedCount, onPhoneCount, visualCompletionPct, note } = result;

  await db.collection('camera_reports').insertOne({
    camera: cam.name,
    zone: cam.zone,
    status,
    peopleCount,
    engagedCount,
    disengagedCount,
    onPhoneCount,
    visualCompletionPct,
    note,
    yoloDetection, // raw local-detector output alongside Claude's counts, for later agree/disagree comparison — null if detection failed
    changedSinceLastCheck,
    frameId,
    timestamp: new Date(),
  });

  if (status === 'IDLE') {
    await db.collection('idle_flags').insertOne({
      camera: cam.name,
      zone: cam.zone,
      durationMin: IDLE_THRESHOLD_MIN,
      status: 'flagged',
      note,
      timestamp: new Date(),
    });
  }
}

// Re-run classification on an EXISTING stored report's frame under the
// current prompt/context — useful when you want to see (and keep) how a
// past report reads under a newer version of the prompt, rather than
// waiting for the next scheduled check. Excludes the report itself from
// both the reference-photo set and the text-context set, since a report
// that's already NOTED (has its own referenceNote) would otherwise be used
// to grade/inform its own reclassification. Only overwrites the
// AUTO-generated fields — status, counts, visualCompletionPct, note — never
// `referenceNote` itself, which is the operator's own ground-truth
// annotation.
async function reclassifyReport(db, reportId) {
  const report = await db.collection('camera_reports').findOne({ _id: reportId });
  if (!report) throw new Error('Report not found');
  if (!report.frameId) throw new Error('This report has no stored frame to reclassify');

  const frame = await fetchFrame(db, report.frameId);
  const referenceSet = await getReferenceSet(db, report.camera, report._id);
  const operatorNotes = await getOperatorNotes(db, report.camera, report._id);
  const operatorContext = buildOperatorContextBlock(operatorNotes);
  const engagementCorrections = await getEngagementCorrections(db, report.camera, report._id);
  const engagementContext = buildEngagementContextBlock(engagementCorrections);
  const yoloDetection = await detectPersonsAndPhones(frame);
  const yoloContext = buildYoloContextBlock(yoloDetection);

  const result = await classifyFrame(frame, report.zone, referenceSet, operatorContext, engagementContext, yoloContext);
  if (!result) throw new Error('Classification failed — no ANTHROPIC_API_KEY, or response did not parse');

  const { status, peopleCount, engagedCount, disengagedCount, onPhoneCount, visualCompletionPct, note } = result;
  await db.collection('camera_reports').updateOne(
    { _id: report._id },
    { $set: { status, peopleCount, engagedCount, disengagedCount, onPhoneCount, visualCompletionPct, note, yoloDetection, reclassifiedAt: new Date() } }
  );
  return { before: report, after: result };
}

function loadCameras() {
  try {
    return JSON.parse(process.env.CAMERAS_CONFIG || '[]');
  } catch {
    console.error('[camera] CAMERAS_CONFIG is not valid JSON — watcher disabled');
    return [];
  }
}

// Push mode: an on-site relay (relay/push-relay.js) polls
// GET /api/camera-relay/push-config about once a minute and uploads a frame
// per camera every IDLE_THRESHOLD_MIN. This server never connects inward.
// If a relay stops checking in, nothing would otherwise be written at all,
// so the watcher records its cameras as UNREACHABLE — same as a failed grab.
const PUSH_RELAY_STALE_MS = 10 * 60 * 1000;

async function checkPushRelays(db, pushCams) {
  const relayNames = [...new Set(pushCams.map(c => c.push))];
  const relays = await db.collection('camera_relays').find({ _id: { $in: relayNames } }).toArray();
  const lastSeen = new Map(relays.map(r => [r._id, r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : 0]));
  for (const cam of pushCams) {
    const seen = lastSeen.get(cam.push) || 0;
    if (Date.now() - seen <= PUSH_RELAY_STALE_MS) continue;
    const message = seen
      ? `Relay "${cam.push}" hasn't checked in for ${Math.round((Date.now() - seen) / 60000)} min — the on-site relay computer may be off, asleep, or offline`
      : `Relay "${cam.push}" has never connected — set up the on-site relay (docs/camera-relay.md)`;
    await recordUnreachable(db, cam, message);
  }
}

function startCameraWatcher(db) {
  if (process.env.ENABLE_CAMERAS !== 'true') {
    console.log('[camera] ENABLE_CAMERAS not set — watcher disabled');
    return;
  }
  const cameras = loadCameras();
  if (!cameras.length) {
    console.log('[camera] no cameras configured in CAMERAS_CONFIG — watcher disabled');
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[camera] ANTHROPIC_API_KEY not set — checks will run but produce no reports');
  }
  const periodMs = IDLE_THRESHOLD_MIN * 60 * 1000;
  const tick = () => {
    cleanupOldFrames(db).catch(err => console.error('[camera] cleanup failed:', err.message));
    if (!isWithinBusinessHours()) return; // outside business hours — no frame grab, no API call, no cost
    cameras.filter(cam => !cam.push).forEach(cam => {
      checkCamera(db, cam).catch(err => console.error(`[camera] ${cam.name} check failed:`, err.message));
    });
    const pushCams = cameras.filter(cam => cam.push);
    if (pushCams.length) checkPushRelays(db, pushCams).catch(err => console.error('[camera] push relay check failed:', err.message));
  };
  tick();
  setInterval(tick, periodMs);
  console.log(`[camera] watching ${cameras.length} camera(s), checking every ${IDLE_THRESHOLD_MIN} min, ${process.env.BUSINESS_HOURS_START || '07:45'}–${process.env.BUSINESS_HOURS_END || '18:00'} (${BUSINESS_HOURS_TZ}) only`);
}

module.exports = {
  startCameraWatcher, checkCamera, processFrame, recordUnreachable, loadCameras,
  isWithinBusinessHours, reclassifyReport, IDLE_THRESHOLD_MIN,
};
