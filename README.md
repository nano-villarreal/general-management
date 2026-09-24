# Camera Reports

Standalone camera-based engagement/idle monitoring: point it at one or more
RTSP cameras, and every few minutes it grabs a frame, asks Claude to count
who's present and whether they're working or idle (and flags phone use and
safety anomalies), and logs it. A small React viewer shows the running log,
today's summary, and lets you annotate reports to improve future accuracy.

Extracted from a larger internal ops dashboard — this repo is just the
camera-reporting slice, with no dependency on any other system (attendance,
payroll, inventory, etc.). See [`CONTEXT.md`](./CONTEXT.md) for the full
architecture writeup.

## Quick start

```
npm install
cd client && npm install && cd ..
cp .env.example .env   # fill in MONGO_LINK, ADMIN_PASSWORD, ANTHROPIC_API_KEY, CAMERAS_CONFIG
npm run dev            # server + Vite dev server
```

Open http://localhost:5173, log in with `ADMIN_PASSWORD`.

For a production build served by the Node server itself:
```
npm run prod
```

## What you need before this is useful

1. **A MongoDB database.** Any Atlas free-tier cluster works. Nothing else
   in this repo needs a schema set up in advance — collections are created
   on first write.
2. **An Anthropic API key** (`ANTHROPIC_API_KEY`) — this is what actually
   classifies each frame. Without it, the watcher still runs and grabs
   frames, but writes no reports.
3. **At least one IP camera that speaks RTSP.** Most consumer/pro IP cameras
   do (look for "RTSP" or "ONVIF" in the spec sheet). Two ways to reach it:
   - If the camera is on a network with a real public IP and you can
     port-forward to it, use direct RTSP (`rtspUrl` in `CAMERAS_CONFIG`).
   - If it's behind CGNAT / an ISP firewall (very common on residential and
     small-business internet — the standard symptom is a port-forward that
     "just hangs" with no response), use the relay approach instead — see
     [`docs/camera-relay.md`](./docs/camera-relay.md). This is the path
     that's actually been exercised in production; expect to need it.

## Deploying

Any Node host works. This was built and tested for Heroku specifically —
`heroku-postbuild` handles both the client build and trimming
`onnxruntime-node`'s bundled platform binaries down to just the deployed
platform (see `scripts/trim-onnx-platforms.js`), which otherwise adds
~280MB to the slug. If you deploy somewhere else, you can drop that trim
step and its `KEEP_ONNX_PLATFORM`/`KEEP_ONNX_ARCH` env vars entirely — they
only matter for slug/image size.

Config vars — see `.env.example` for the full list with explanations.

## What's deliberately not here

This was pulled out of a bigger app that also had employee attendance,
payroll, and inventory tracking, all of which the original camera module
partly integrated with (e.g. suppressing idle alerts during a scheduled
break). None of that made it into this repo — it's a clean-room extraction
of only the camera piece, so:

- There's no per-employee or per-break awareness — every IDLE check is
  flagged, with no suppression logic. Add your own if you have a system to
  suppress against.
- Auth is a single shared password, not per-user accounts. Fine for a small
  team; swap in something heavier if you need audit trails on who annotated
  what.
- There's no bounding-box labeling UI for training a custom object
  detector — the local YOLO pre-check (`lib/yoloDetect.js`) runs a stock,
  pretrained model (person/phone only, COCO classes) with no training
  pipeline attached.
