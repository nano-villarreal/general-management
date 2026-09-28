#!/bin/bash
# Camera Reports — push relay installer for macOS.
# Served pre-filled by GET /api/camera-relay/install-mac; run it on the
# on-site Mac with:   curl -fsSL "<that url>" | bash
#
# Installs relay/push-relay.js into ~/camera-relay, asks for the DVR login
# (stored only on this Mac, in ~/camera-relay/config.json), registers a
# launchd daemon so it starts at boot and restarts if it dies, and stops
# the Mac from sleeping. Safe to re-run: it replaces the previous install.
set -euo pipefail

SERVER_URL='{{SERVER_URL}}'
RELAY_SECRET='{{SECRET}}'
RELAY_NAME='{{RELAY_NAME}}'

DIR="$HOME/camera-relay"
LABEL="com.camerareports.push-relay"
PLIST="/Library/LaunchDaemons/$LABEL.plist"

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ── Node ───────────────────────────────────────────────────────────────────
NODE_BIN="$(command -v node || true)"
for candidate in /usr/local/bin/node /opt/homebrew/bin/node; do
  if [ -z "$NODE_BIN" ] && [ -x "$candidate" ]; then NODE_BIN="$candidate"; fi
done
[ -n "$NODE_BIN" ] || fail "Node.js is not installed. Download the LTS installer (.pkg) from https://nodejs.org, install it, then run this again."
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 10 ] || fail "Node.js $("$NODE_BIN" -v) is too old — install a newer one from https://nodejs.org."
say "Using Node $("$NODE_BIN" -v) at $NODE_BIN"

# ── Relay script ───────────────────────────────────────────────────────────
mkdir -p "$DIR"
curl -fsSL "$SERVER_URL/api/camera-relay/push-relay.js" -o "$DIR/push-relay.js" || fail "Could not download the relay script from $SERVER_URL"
say "Downloaded relay script to $DIR/push-relay.js"

# ── DVR login (asked here, stored only on this Mac) ────────────────────────
# stdin is the piped script, so prompts read from the terminal directly.
read -r -p "DVR address [192.168.1.67]: " DVR_HOST < /dev/tty
DVR_HOST="${DVR_HOST:-192.168.1.67}"
read -r -p "DVR username: " DVR_USER < /dev/tty
read -r -s -p "DVR password: " DVR_PASS < /dev/tty; echo

# One test snapshot. Only ONE attempt — Hikvision locks this computer out
# after a few failed logins, so a typo must not be retried automatically.
say "Testing the DVR login (one attempt)..."
CODE="$(curl -s --digest -u "$DVR_USER:$DVR_PASS" -m 15 -o /tmp/camera-relay-test.jpg -w '%{http_code}' "http://$DVR_HOST/ISAPI/Streaming/channels/101/picture" || true)"
case "$CODE" in
  200) say "DVR login works — got a snapshot ($(wc -c < /tmp/camera-relay-test.jpg | tr -d ' ') bytes)." ;;
  401|403) fail "The DVR rejected that username/password. Check it by logging in at http://$DVR_HOST in a browser, then run this again. (Several wrong attempts lock this Mac out for ~30 minutes.)" ;;
  000) fail "Could not reach the DVR at $DVR_HOST — is this Mac on the same network?" ;;
  *) fail "The DVR answered with HTTP $CODE — check the address." ;;
esac
rm -f /tmp/camera-relay-test.jpg

# Written by node so the password is JSON-escaped correctly whatever it contains.
umask 077
SERVER_URL="$SERVER_URL" RELAY_SECRET="$RELAY_SECRET" RELAY_NAME="$RELAY_NAME" \
DVR_HOST="$DVR_HOST" DVR_USER="$DVR_USER" DVR_PASS="$DVR_PASS" \
"$NODE_BIN" -e '
  const e = process.env;
  require("fs").writeFileSync(process.argv[1], JSON.stringify({
    server: e.SERVER_URL, secret: e.RELAY_SECRET, relay: e.RELAY_NAME,
    dvr: { host: e.DVR_HOST, user: e.DVR_USER, pass: e.DVR_PASS },
  }, null, 2));
' "$DIR/config.json"
chmod 600 "$DIR/config.json"
say "Saved config to $DIR/config.json (readable only by $(whoami))"

# ── Start at boot (launchd) ────────────────────────────────────────────────
say "Installing the startup service — macOS will ask for this Mac's password."
sudo tee "$PLIST" > /dev/null <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>UserName</key><string>$(whoami)</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DIR/push-relay.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DIR/relay.log</string>
  <key>StandardErrorPath</key><string>$DIR/relay.log</string>
</dict>
</plist>
PLIST_EOF
sudo chown root:wheel "$PLIST"
sudo chmod 644 "$PLIST"
sudo launchctl unload "$PLIST" 2>/dev/null || true
sudo launchctl load -w "$PLIST"

# ── Never sleep; come back after a power cut ───────────────────────────────
sudo pmset -a sleep 0 disksleep 0 || true
sudo pmset -a autorestart 1 2>/dev/null || true

sleep 3
say "Done. The relay is running and will start automatically at boot."
echo "    Log:        tail -f $DIR/relay.log"
echo "    Stop:       sudo launchctl unload $PLIST"
echo "    Uninstall:  sudo launchctl unload $PLIST && sudo rm $PLIST && rm -rf $DIR"
echo
tail -n 5 "$DIR/relay.log" 2>/dev/null || true
