# Camera relay setup

There are two relay designs. **Use the push relay** unless you have a reason
not to.

| | Push relay (recommended) | Tunnel relay (legacy) |
|---|---|---|
| Direction | Relay uploads frames to the server | Server fetches frames through a public tunnel to the relay |
| Anything on the LAN reachable from the internet? | **No** | Yes — the relay's `/snapshot` endpoint, guarded by the shared secret |
| Camera source | DVR/NVR JPEG snapshots (Hikvision/HiLook ISAPI), one relay for all channels | One RTSP camera per relay |
| On-site software | Node.js + `curl` | Node.js + ffmpeg + cloudflared |
| DVR/camera password stored on the server? | No — only on the relay machine | Yes (`CAMERA_RELAY_RTSP_URL`) |

## Push relay (DVR/NVR, macOS)

`relay/push-relay.js` runs on any always-on computer on the DVR's LAN. About
once a minute it asks the server (`GET /api/camera-relay/push-config`)
which cameras it serves, how often to capture, and whether it's business
hours; every `IDLE_THRESHOLD_MIN` minutes during business hours it fetches
each camera's JPEG from the DVR
(`http://<dvr>/ISAPI/Streaming/channels/<N>01/picture`, HTTP digest auth)
and uploads it (`POST /api/camera-relay/push-frame`). A failed snapshot is
reported (`POST /api/camera-relay/push-error`) and shows up as an
`UNREACHABLE` report; if the relay stops checking in for 10 minutes the
server marks its cameras `UNREACHABLE` itself. All three routes
authenticate with the `X-Relay-Secret` header.

**Why snapshots and not RTSP:** Hikvision DVRs commonly stream H.265 without
the parameter sets in the SDP, which ffmpeg can't decode from a cold start
("PPS id out of range"). The ISAPI snapshot endpoint returns a ready JPEG
and sidesteps that entirely.

**Hikvision lockout:** the DVR locks an IP address out of RTSP/ISAPI for
~30 minutes after about five failed logins (the web UI keeps working if it
was already logged in, which makes this confusing). The installer tests the
login exactly once, and the relay backs off for 30 minutes after a rejected
login instead of retrying every round.

### Server config

1. `CAMERA_RELAY_SECRET` — a long random string.
2. `CAMERAS_CONFIG` entries with `push` (the relay's name) and `channel`
   (the DVR channel number):
   ```json
   [{"name":"Camera 04","zone":"Workshop","push":"warehouse","channel":4}]
   ```
   Adding/removing cameras later only needs this config var changed — the
   relay picks it up within a minute.

### Installing on a Mac

1. Keep the Mac plugged in, on the same network as the DVR (Ethernet
   preferred), lid open if it's a laptop.
2. Install **Node.js** LTS from https://nodejs.org (the `.pkg`). Very old
   macOS versions can't run current Node — the nodejs.org "previous
   releases" page lists older installers; the relay only needs Node 10+.
3. In Terminal, run the installer served by the app (it's pre-filled with
   the server URL, secret and relay name):
   ```
   curl -fsSL "https://<app>/api/camera-relay/install-mac?secret=<CAMERA_RELAY_SECRET>&relay=warehouse" | bash
   ```
   It asks for the DVR address and login (stored only in
   `~/camera-relay/config.json`, mode 600), tests one snapshot, installs a
   launchd daemon (`/Library/LaunchDaemons/com.camerareports.push-relay.plist`
   — starts at boot without anyone logging in, restarts if it dies), and
   disables system sleep (`pmset sleep 0`, `autorestart 1`). It asks for
   the Mac's admin password for those last two steps.
4. Check it: `tail -f ~/camera-relay/relay.log` — within a minute of
   business hours you should see `sent Camera 04 (ch 4, … bytes)` lines.

Re-running the installer updates the script and replaces the config.
Uninstall: `sudo launchctl unload /Library/LaunchDaemons/com.camerareports.push-relay.plist && sudo rm /Library/LaunchDaemons/com.camerareports.push-relay.plist && rm -rf ~/camera-relay`.

The script has no npm dependencies and uses only `curl` besides Node, so
it runs unchanged on Linux (e.g. a Raspberry Pi) — only the installer is
macOS-specific; on Linux, write the same `config.json` by hand and run it
under systemd.

---

# Tunnel relay (legacy: an always-on phone on the camera's LAN)

Use this when the camera's network can't accept inbound connections (CGNAT,
ISP firewall, etc. — see `integrations/camera.js`'s Option A vs B). An
always-on device sits on the camera's own LAN, grabs snapshots locally, and
pushes them out through an outbound tunnel that this server fetches from. It
self-registers its tunnel URL with the server since that URL is random and
changes every time the tunnel restarts.

Any always-on Linux-capable device on the camera's LAN works — an old
Android phone (via Termux or UserLAnd) is the cheapest option and what this
doc assumes, but a Raspberry Pi or spare mini-PC works the same way and is
more reliable long-term (no OS-level battery/background-app killing to fight
— see "Hardening against silent kills" below, which is Android-specific).

## Getting the pre-filled script

Don't hand-type the relay script or copy real secrets into a doc — this repo
serves a ready-to-run copy with your actual values already filled in:

```
GET /api/camera-relay/script?secret=<CAMERA_RELAY_SECRET>&camera=<camera name>
```

`wget`/`curl` that URL directly from the relay device once it has network
access, e.g.:

```
wget -O ~/camera-relay.js "https://your-app.example.com/api/camera-relay/script?secret=YOUR_SECRET&camera=Front%20Desk"
```

This avoids hand-typing a multi-line script (and a long secret) on a phone's
on-screen keyboard, which is a reliable source of transcription typos.

## One-time device setup (Android via Termux)

1. Install **Termux** from F-Droid (not the Play Store version — it's
   unmaintained). Also install **Termux:Boot** from F-Droid if you want the
   relay to auto-start after a phone reboot.
2. In Android Settings > Apps > Termux > Battery, set it to **Unrestricted**.
   Without this, Android will kill the relay in the background within
   minutes — this is the single most commonly missed step.
3. Open Termux and run:
   ```
   pkg update -y && pkg install nodejs ffmpeg wget -y
   ```
4. Check the device's CPU architecture:
   ```
   uname -m
   ```
   Most phones from the last ~8 years report `aarch64` (use the arm64
   download below). Older 32-bit phones report `armv7l` (use `-linux-arm`
   instead of `-linux-arm64` in the next step).
5. Download cloudflared (Cloudflare's tunnel client — free, no signup, no
   domain needed for this):
   ```
   wget -O ~/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
   chmod +x ~/cloudflared
   ```
6. Fetch the pre-filled relay script (see above):
   ```
   wget -O ~/camera-relay.js "https://your-app.example.com/api/camera-relay/script?secret=YOUR_SECRET&camera=YOUR_CAMERA_NAME"
   ```
7. Create the supervisor script so it restarts itself if Node or cloudflared
   ever crash. **The shebang line differs by app** — Termux's `sh` lives at
   a Termux-specific path; if you use UserLAnd's Ubuntu instead, `/bin/bash`
   exists as a normal path and there's no `termux-wake-lock` equivalent
   (drop that line — UserLAnd's own persistent-session notification plus
   exempting *UserLAnd itself* from battery optimization is what keeps it
   alive there). Using the wrong shebang is what "No such file or directory"
   on a supposedly-present script means: the shell isn't complaining the
   script is missing, it's complaining the *interpreter path in the
   shebang* is missing.

   **Termux:**
   ```
   cat > ~/run-relay.sh <<'EOF'
   #!/data/data/com.termux/files/usr/bin/sh
   termux-wake-lock
   while true; do
     node ~/camera-relay.js
     sleep 5
   done
   EOF
   chmod +x ~/run-relay.sh
   ```

   **UserLAnd (Ubuntu):**
   ```
   cat > ~/run-relay.sh <<'EOF'
   #!/bin/bash
   while true; do
     node ~/camera-relay.js
     sleep 5
   done
   EOF
   chmod +x ~/run-relay.sh
   ```
8. Start it:
   ```
   ~/run-relay.sh
   ```
   Leave this running (screen can turn off, just don't force-close the app).
   You should see `relay listening on :8080`, then a `tunnel URL: https://...`
   line, then `register -> 200`.

## Auto-start on reboot (optional but recommended)

With Termux:Boot installed:
```
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start-relay.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
~/run-relay.sh &
EOF
chmod +x ~/.termux/boot/start-relay.sh
```

## Hardening against silent kills (Android, especially UserLAnd)

A background process on Android can be killed by the OS with no crash log
and no reboot — the relay just goes silent for hours until someone notices.
If using UserLAnd specifically (no Termux:Boot / Termux:API equivalent — no
boot-autostart, no OS-level job scheduler it exposes), the fix has to come
from Android's own settings plus a small watchdog app outside UserLAnd's
process tree:

1. **Battery: Unrestricted, for the app itself** — Android Settings > Apps
   > [Termux/UserLAnd] > Battery > Unrestricted.
2. **Never swipe away a persistent session notification**, if the app shows
   one (UserLAnd does). That notification marks the process as
   foreground/protected to Android — swiping it away (even by accident while
   clearing other notifications) demotes it to a normal background process,
   which is exactly what gets reaped first when the OS wants memory back
   overnight.
3. **Check for an OEM autostart/"protected apps" list.** This is separate
   from the standard Android battery setting above and isn't reachable from
   stock Settings — each manufacturer ships its own app-killer with its own
   toggle:
   - Xiaomi/Redmi/POCO (MIUI): Security app > Battery > App battery saver >
     [app] > No restrictions, **and** Security app > Permissions >
     Autostart > enable [app].
   - Samsung: Battery > Background usage limits > move [app] to
     **Never sleeping apps** (different from turning off "Put unused apps to
     sleep" generally).
   - Huawei/Honor: Phone Manager > App launch > [app] > switch to
     **Manage manually** and enable all three (auto-launch, secondary
     launch, run in background).
   - Oppo/vivo/OnePlus: Settings > Battery > App battery management >
     [app] > allow background activity; also check the phone manager app's
     own "Startup Manager"/"Auto-start" list.
   - Any other brand: search "\<brand\> autostart battery [app name]" —
     nearly every OEM has one of these, and it's the most common reason a
     properly-configured background app still dies overnight on Android.
4. **Add an external watchdog** — something outside the relay app that
   notices if it got killed and relaunches it, since nothing inside the app
   can save itself from its own process being terminated. **MacroDroid**
   (free tier covers this) or **Tasker** (paid, equally capable) both work:
   - Trigger: *Application State* — [app] — **Not Running**.
   - Add a second, redundant trigger: *Periodic* — every 15 minutes — with a
     constraint that [app] is not running (belt-and-suspenders, in case the
     state-change trigger itself gets missed while the phone is deep
     asleep).
   - Action: *Launch Application* — [app]. If the app lets you create a
     home-screen shortcut for the specific relay session, point the action
     at that shortcut instead of the bare app icon, so it drops straight
     back into the running session instead of a session-picker screen.
   - Also exempt MacroDroid/Tasker itself from battery optimization —
     obviously, a watchdog that Android kills is no watchdog at all.

None of this makes a kill impossible — it makes it self-healing within
minutes instead of requiring someone to notice a wall of `UNREACHABLE`
checks and walk over to the device.

## camera-relay.js (reference — fetch the pre-filled version instead)

```js
const http = require('http');
const https = require('https');
const { spawn, execFile } = require('child_process');

// ---- filled in per-deployment via GET /api/camera-relay/script ----
const CAMERA_NAME    = 'Front Desk';
const RTSP_URL       = 'rtsp://user:pass@192.168.1.50:554/stream1';
const SECRET         = 'your-camera-relay-secret';
const REGISTER_URL   = 'https://your-app.example.com/api/camera-relay/register';
const PORT           = 8080;
const CLOUDFLARED_BIN = process.env.HOME + '/cloudflared';
// ---------------------------------------------------------------------

function grabSnapshot(cb) {
  execFile('ffmpeg', [
    '-y', '-rtsp_transport', 'tcp', '-i', RTSP_URL,
    '-frames:v', '1', '-q:v', '4', '-f', 'image2', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
    if (err) return cb(err);
    if (!stdout || !stdout.length) return cb(new Error('empty frame'));
    cb(null, stdout);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/snapshot' || url.searchParams.get('key') !== SECRET) {
    res.writeHead(404);
    res.end();
    return;
  }
  grabSnapshot((err, buf) => {
    if (err) {
      console.error('grab failed:', err.message);
      res.writeHead(502);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length });
    res.end(buf);
  });
});
server.listen(PORT, () => console.log(`relay listening on :${PORT}`));

function registerUrl(tunnelUrl) {
  const body = JSON.stringify({ camera: CAMERA_NAME, url: tunnelUrl, secret: SECRET });
  const req = https.request(REGISTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => console.log('register ->', res.statusCode));
  req.on('error', e => console.error('register failed:', e.message));
  req.write(body);
  req.end();
}

let heartbeat;
function startTunnel() {
  console.log('starting cloudflared...');
  const proc = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', `http://localhost:${PORT}`]);
  let registered = false;
  const onData = (data) => {
    const text = data.toString();
    process.stdout.write(text);
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !registered) {
      registered = true;
      console.log('tunnel URL:', m[0]);
      registerUrl(m[0]);
      clearInterval(heartbeat);
      heartbeat = setInterval(() => registerUrl(m[0]), 4 * 60 * 1000);
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData); // cloudflared logs its URL to stderr
  proc.on('exit', (code) => {
    console.log('cloudflared exited, restarting in 5s...', code);
    clearInterval(heartbeat);
    setTimeout(startTunnel, 5000);
  });
}
startTunnel();
```

## Verifying it's working

- The relay device should keep printing `register -> 200` every ~4 minutes.
- On the dashboard, camera checks should stop showing `UNREACHABLE` within
  one check cycle (`IDLE_THRESHOLD_MIN`, default 15 min) of the relay coming
  online.
- If the device reboots or the app is killed and later restarts, the tunnel
  URL changes automatically and the relay re-registers it — no manual config
  update needed on the server side.

## Known failure points

1. **The relay depends entirely on one device staying powered, connected,
   and running.** None of this survives a reboot automatically unless you
   set up auto-start (above). If it restarts, someone has to go re-run
   `~/run-relay.sh` unless auto-start is configured and working.
2. **No DHCP reservation for the camera** means its LAN IP can change
   silently, breaking `CAMERA_RELAY_RTSP_URL` until manually updated. Set a
   DHCP reservation for the camera's MAC address on your router to avoid
   this entirely.
3. **No built-in alerting on stale relay data.** Nothing pages anyone when
   the relay goes stale (`camera_relays.updatedAt` older than 10 minutes) or
   when `ANTHROPIC_API_KEY` goes invalid — both fail silently unless someone
   is watching the reports feed. Consider wiring `/api/alerts` into your own
   monitoring/notification channel if this matters to you.
4. **CGNAT diagnosis is usually inferential, not directly confirmed** — if a
   direct port-forward (Option A in `integrations/camera.js`) ever hangs
   with no response even though the router's NAT rule looks correct, that's
   the CGNAT signature, but only your ISP can fully confirm it.
