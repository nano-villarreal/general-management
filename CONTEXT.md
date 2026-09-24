# Camera Reports — System Documentation

Institutional-memory file: what this does, how the pieces fit, what's
fragile, and what's already gone wrong once (in the original system this was
extracted from). Keep it updated when something here changes.

## 1. What this is

A small Node/Express API + React (Vite) single-page app that periodically
grabs a frame from one or more IP cameras, asks Claude to count who's
present and classify engagement (working / idle / mixed / empty), flags
phone use and safety anomalies, and logs every check — not just the ones
worth alerting on. A viewer UI shows the running log, a same-day summary,
and lets an operator annotate reports (two independent channels — see §4) to
improve future accuracy. A separate **Labeling** tab lets an operator draw
bounding boxes on stored frames and export them as a YOLO training dataset
(see §6a).

This is an extraction of the camera-reporting slice of a larger internal
ops dashboard built for a different business. It has **no dependency** on
that system's attendance, payroll, or inventory features — anything that
originally cross-referenced them (e.g. suppressing an idle alert because
someone was on a scheduled break) was removed, not stubbed out. See
`README.md` → "What's deliberately not here."

## 2. Architecture

```
server.js          Express API + session auth + static file serving
integrations/       camera.js — the watcher: capture, classify, store, alert
lib/                yoloDetect.js — local pretrained object-detector second opinion
models/             yolov8n.onnx — vendored stock COCO model (~13MB)
templates/          camera-relay.template — filled in and served to relay devices
docs/               camera-relay.md — relay device setup instructions
client/             React 18 + Vite SPA, built to public/
```

- **Auth**: single shared password (`ADMIN_PASSWORD`), session cookie via
  `express-session`. No per-user accounts — anyone with the password sees
  and annotates everything. Deliberately simple; swap in something heavier
  if you need to know *who* annotated a given report.
- **Deploy**: `npm run prod` builds the client and starts the server from
  one process — no separate static host needed. Tested against Heroku;
  should work on any Node PaaS or VM with outbound internet access (needed
  to reach both the camera and the Anthropic API).

## 3. Running it

```
npm run dev     # server + Vite dev server, needs MONGO_LINK etc. in .env
npm run build   # builds client into public/
npm run prod    # build + start, for a from-scratch deploy
```

## 4. Data model

Database: whatever `MONGO_LINK`/`MONGO_DB_NAME` point at. Collections,
all owned (read and written) by this app:

| Collection | Written by |
|---|---|
| `camera_reports` | `integrations/camera.js`, every check (full log, not just alerts) |
| `idle_flags` | `integrations/camera.js`, when a check comes back IDLE |
| `camera_relays` | `POST /api/camera-relay/register` — relay device self-registration |
| `camera_frames` (GridFS bucket, not a plain collection) | `integrations/camera.js`'s `storeFrame` — every check's frame, pruned after `FRAME_RETENTION_DAYS` (default 30) unless reference-marked |

A `camera_reports` document looks like:

```js
{
  camera, zone, status,             // WORKING | IDLE | MIXED | EMPTY | UNREACHABLE
  peopleCount, engagedCount, disengagedCount, onPhoneCount,
  visualCompletionPct,              // null until at least one reference photo exists for this camera
  note,                             // free text; prefixed "ANOMALY: " if something unsafe was flagged
  yoloDetection,                    // { personCount, phoneCount, phonesNearPerson } | null
  referenceNote,                    // operator annotation — see below
  engagementNote,                   // operator correction — see below
  labelBoxes, labeledAt,            // bounding boxes from the Labeling tab — see §6a
  changedSinceLastCheck, frameId, timestamp,
}
```

## 5. API reference

All routes require a valid session (`requireAuth`) unless noted.

**Auth** — `POST /login` (body `{password}`), `POST /logout`, `GET /api/me`
(no auth required).

**Camera reports**
- `GET /api/camera-reports?limit=&camera=`
- `GET /api/camera-reports/summary` — today's per-camera status breakdown
- `GET /api/camera-reports/:id/frame` — streams the stored frame (GridFS)
- `POST /api/camera-reports/:id/mark-reference` (body `{note}`) / `DELETE`
  — annotate/un-annotate a report's frame with what was actually happening
- `POST /api/camera-reports/:id/mark-engagement` (body `{note}`) / `DELETE`
  — correct a wrong engagement/phone-use call
- `POST /api/camera-reports/:id/reclassify` — re-run classification on an
  existing report's stored frame under the current prompt/context

**Labeling**
- `GET /api/labeling/frames?filter=all|labeled|unlabeled&limit=&camera=` —
  reports that still have a stored frame, plus labeled/total counts
- `PUT /api/camera-reports/:id/label` (body `{boxes}`) — replace a frame's
  boxes; an empty array clears the label
- `GET /api/labeling/export` — streams a YOLO dataset zip

**Alerts**
- `GET /api/alerts` — merged idle-flag + camera-anomaly feed
- `GET /api/idle-flags?limit=`

**Camera relay** (not session-gated — `CAMERA_RELAY_SECRET`-gated instead)
- `GET /api/camera-relay/script?secret=&camera=` — serves the filled-in
  relay script for `wget`/`curl`
- `POST /api/camera-relay/register` — relay self-registration

## 6. The camera watcher (`integrations/camera.js`)

Gated by `ENABLE_CAMERAS=true`. Every `IDLE_THRESHOLD_MIN` minutes (default
15), during business hours only (`BUSINESS_HOURS_TZ`/`_START`/`_END`, all
configurable — default `America/Mexico_City` 07:45–18:00), grabs one frame
per configured camera and asks Claude to count/classify people present.
Writes every check to `camera_reports` (a full log); IDLE checks
additionally go to `idle_flags`.

**Reachability is the single biggest source of real-world trouble.** A
hosted server has no route to a camera on a private LAN. Two modes, set per
camera in `CAMERAS_CONFIG` (JSON array):

- `{"name","zone","rtspUrl"}` — direct RTSP. Only works if the camera's
  network has a real (non-CGNAT) public IP you can port-forward to. Many
  residential/small-business ISPs put you behind CGNAT — a shared public IP
  that makes inbound port-forwarding impossible no matter how it's
  configured on the router. The symptom is diagnostic: the TCP connection
  just hangs with no response at all, not a clean refusal. If you see that
  after confirming the port-forward rule itself is correct, it's almost
  certainly CGNAT — call your ISP to confirm, or skip straight to the relay.
- `{"name","zone","relay":true}` — fetches the latest frame from whatever
  URL a relay device last self-registered via
  `POST /api/camera-relay/register` (stored in `camera_relays`, keyed by
  camera name). This is the path that's actually been exercised in
  production — see `docs/camera-relay.md` for full device setup, including
  a real, previously-confirmed failure mode (Android silently killing the
  whole relay process overnight with no crash log) and how to harden
  against it.

`CAMERA_RELAY_RTSP_URL` is a single **global** env var giving the relay
device the camera's LAN RTSP URL — it is not per-camera the way
`CAMERAS_CONFIG` entries are. Fine with one relay camera; needs restructuring
(e.g. keyed by camera name) if a second relay-based camera is ever added.

**Frame storage.** Every check's frame is stored (GridFS, `camera_frames`
bucket) and referenced by `frameId`, so a past classification can be audited
or reclassified later. Frames older than `FRAME_RETENTION_DAYS` (default 30)
are pruned automatically (once a day) unless the report has a
`referenceNote` annotation or `labelBoxes`.

**Two independent annotation channels, easy to conflate — don't:**

1. **`referenceNote` ("Describe")** — a real description of what was
   actually happening ("order X just finished, only Y left", "shift change
   in progress"). Feeds two things: (a) up to `MAX_REFERENCE_IMAGES` (8) of
   the most-recently-annotated *photos* are attached to future classification
   requests for that camera so Claude can estimate `visualCompletionPct` by
   pattern-matching workflow stage, and (b) up to `MAX_TEXT_CONTEXT_NOTES`
   (50) of the same notes, as plain text with no image, are included on
   *every* check for that camera unconditionally — this second channel
   exists because the photo-matching one only helps when the current frame
   happens to visually resemble one of the 8 attached photos, which most
   checks don't.
2. **`engagementNote` ("Fix")** — a correction to a specific wrong
   engagedCount/disengagedCount/onPhoneCount call ("device-in-hand near a
   workstation isn't phone use here"). This does **not** feed the
   `referenceNote` channels at all — it's a separate, always-on text block
   (up to `MAX_ENGAGEMENT_NOTES` = 50) that exists specifically because
   engagement/phone judgments come entirely from the base prompt's fixed
   rules, and no amount of `referenceNote` annotation was found to move
   them.

**Identity-guessing is banned from the prompt on purpose.** The base prompt
explicitly forbids naming any specific person/client/order unless something
in the image itself identifies it (a visible tag, label, sign). This was a
real, twice-confirmed failure mode in the original system: visually similar
scenes (e.g. same-looking white linens from different clients) produced
confident, wrong identity guesses when the prompt allowed pattern-matching
against reference photos for that purpose. If you loosen this rule, expect
the same failure class to come back.

**Employee/person identification was explicitly out of scope** in the
system this was extracted from, after legal review: in some jurisdictions,
biometric identification (including a stored, reusable face signature) used
for individual performance monitoring requires an explicit consent/legal
basis, and that requirement can apply even to "semi-automatic" tagging (a
human confirms once, the system reuses a stored signature after). If you
want to add per-person tracking, get legal sign-off for your jurisdiction
first — don't assume manual-looking review makes it a non-issue if a
signature is stored and reused.

## 6a. Labeling (bounding boxes → YOLO dataset)

The Labeling tab (`client/src/components/LabelingPanel.jsx`) shows stored
frames; the operator drags boxes on a frame and tags each box with one or
more classes: `person`, `phone`, `engaged`, `disengaged`, `sitting`,
`standing`. `engaged`/`disengaged` and `sitting`/`standing` are mutually
exclusive on a box (enforced client- and server-side). Boxes are stored on
the report as `labelBoxes: [{x1,y1,x2,y2,classes}]` in normalized 0–1
coordinates.

Multi-class boxes exist so each person is drawn once. YOLO itself is
single-class per box, so the export writes **one line per (box, class)
pair** — a box tagged person+engaged+sitting becomes three identically-
placed lines. That's fine for training, but note that at inference a stock
YOLO head with class-agnostic NMS would keep only one of those overlapping
detections; run NMS per class (Ultralytics' default) if you train on this.
The class list lives in two places — `LABEL_CLASSES` in `server.js` and
`CLASSES` in `LabelingPanel.jsx` — and the order of `LABEL_CLASSES` is the
YOLO class index, so only ever append to it.

Export (`GET /api/labeling/export`) streams a zip with `images/{train,val}`,
`labels/{train,val}`, `classes.txt` and `dataset.yaml`; every 6th labeled
frame (oldest first) goes to `val`. The trained model is **not** wired back
in automatically — `lib/yoloDetect.js` still runs the stock COCO model and
hard-codes COCO class ids 0/67, so swapping in a custom model needs those
ids and the confidence thresholds (§7) updated too.

## 7. The local YOLO pre-check (`lib/yoloDetect.js`)

A stock, pretrained YOLOv8n ONNX model (COCO classes — "person" and "cell
phone" are already classes 0 and 67, no custom training) runs before every
Claude classification call as a free, deterministic second opinion. It does
**not** decide anything on its own — its output (`personCount`, `phoneCount`,
`phonesNearPerson`) is handed to Claude as a hint to weigh alongside its own
visual judgment, since a generic object detector has its own real failure
modes (a scanner/remote can look like a phone; a phone held low or angled
away is easy to miss).

Person and phone confidence thresholds are tuned separately
(`PERSON_CONF_THRESHOLD` = 0.15, `PHONE_CONF_THRESHOLD` = 0.35) — this came
from live debugging where a sitting/partially-occluded person scored well
below the general-purpose default threshold while phone misses were true
misses (zero candidates at any score), not a threshold problem. If you swap
in a different model, re-verify these thresholds against real frames rather
than assuming they still apply.

`onnxruntime-node` bundles every platform's native binary (~283MB unpacked)
in one package. `scripts/trim-onnx-platforms.js`, wired into
`heroku-postbuild`, deletes everything except the deployed platform/arch
after `npm install` — `.slugignore`-style trimming doesn't work here because
Heroku's buildpack applies it *before* install populates `node_modules`. If
you deploy somewhere else, this step is optional (it only affects
image/slug size).

## 8. Known failure points

1. **A relay device is a single point of failure** if you use the
   relay-based reachability mode. See `docs/camera-relay.md` for hardening
   guidance (Android background-kill exemptions, external watchdog). No
   auto-restart exists unless you set it up.
2. **No DHCP reservation for a camera** means its LAN IP can change
   silently, which breaks `CAMERA_RELAY_RTSP_URL` (relay mode) or a
   port-forward's target (direct mode) until manually updated.
3. **No alerting on stale data.** Nothing pages anyone when a relay goes
   stale (`camera_relays.updatedAt` older than 10 min) or when
   `ANTHROPIC_API_KEY` goes invalid — both fail silently: either
   `UNREACHABLE` reports pile up, or reports just stop appearing with no
   visible error anywhere in the UI. `classifyFrame` silently returns `null`
   on a bad/missing key rather than throwing, so "reports stopped appearing"
   and "nothing is configured to check" look identical from the UI. Check
   the key first if reports go quiet without `UNREACHABLE` showing up.
4. **`visualCompletionPct` is inherently a soft signal**, not a validated
   metric — it's a vision model's estimate, pattern-matched against however
   many (and however specific) reference annotations exist for that camera.
   A camera with no annotations, or only vague ones, gives it little to work
   with.
5. **GridFS storage has no monitored size cap.** Retention cleanup runs once
   a day and only logs to the console on failure — nothing alerts if it
   silently stops working, so check your database's storage usage
   periodically if this ever becomes a concern.
6. **CGNAT diagnosis is inferential, not directly confirmed**, unless your
   ISP explicitly confirms it. If your network setup ever changes (new
   router, plan upgrade), it may be worth re-testing whether direct RTSP
   port-forwarding has become viable — simpler than running a relay device
   if it ever works.

## 9. Config vars

Core: `PORT`, `MONGO_LINK`, `MONGO_DB_NAME`, `ADMIN_PASSWORD`,
`SESSION_SECRET`

Camera: `ENABLE_CAMERAS`, `CAMERAS_CONFIG`, `ANTHROPIC_API_KEY`,
`IDLE_THRESHOLD_MIN`, `CAMERA_RELAY_SECRET`, `CAMERA_RELAY_RTSP_URL`,
`BUSINESS_HOURS_TZ`, `BUSINESS_HOURS_START`, `BUSINESS_HOURS_END`,
`FRAME_RETENTION_DAYS`, `FFMPEG_PATH` (escape hatch, not normally needed)

Build (Heroku-specific, optional elsewhere): `KEEP_ONNX_PLATFORM`,
`KEEP_ONNX_ARCH`

See `.env.example` for defaults and explanations of each.
