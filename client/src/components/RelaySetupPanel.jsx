import React, { useState } from 'react';
import CopyBlock from './CopyBlock';

// Step-by-step commands for installing the push relay on the on-site Mac
// (docs/camera-relay.md → "Push relay"). Nothing here is secret: the
// secret-bearing install command comes from the one-time
// "Relay install command" button, and the installer file it downloads is
// what step 4 runs.

function Step({ n, title, children }) {
  return (
    <div className="setup-step">
      <div className="setup-step-title"><span className="setup-step-n">{n}</span>{title}</div>
      {children}
    </div>
  );
}

export default function RelaySetupPanel() {
  const [adminName, setAdminName] = useState('');
  const name = adminName.trim() || 'NAME';

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Relay setup — on-site Mac</span>
      </div>
      <div className="panel-body">
        <div className="setup">
          <div className="hint">
            Run these in Terminal on the Mac, in order. Click <b>Copy</b>, then paste in Terminal (⌘V) and press Enter.
            If you are logged in as <b>Guest</b>, do step 1 before logging out — Guest's files are erased at logout.
          </div>

          <Step n="0" title="Get the installer (only if you don't have install.sh yet)">
            <div className="hint">
              Use the one-time <b>Relay install command</b> button at the top right (only shown until it's used once).
              It downloads <code>install.sh</code> and runs it — if it stops with "Node.js is not installed", continue with step 1.
            </div>
          </Step>

          <Step n="1" title="Save the installer somewhere every account can reach">
            <CopyBlock command="cp ~/install.sh /Users/Shared/" />
          </Step>

          <Step n="2" title="Switch this Terminal to an admin account">
            <div className="hint">List the accounts, then type the admin one (not Guest or Shared) in the box below:</div>
            <CopyBlock command="ls /Users" />
            <input
              className="setup-input"
              placeholder="admin account name"
              value={adminName}
              onChange={e => setAdminName(e.target.value)}
            />
            <CopyBlock command={`su - ${name}`} />
            <div className="hint">It asks for that account's password (nothing shows while you type — that's normal).</div>
          </Step>

          <Step n="3" title="Install Node.js 14 (works on this Mac's macOS)">
            <CopyBlock command="curl -fLO https://nodejs.org/dist/v14.21.3/node-v14.21.3.pkg && sudo installer -pkg node-v14.21.3.pkg -target /" />
            <div className="hint">Asks for the password again. Then check — it should print v14.21.3:</div>
            <CopyBlock command="node -v" />
          </Step>

          <Step n="4" title="Run the relay installer">
            <CopyBlock command="bash /Users/Shared/install.sh" />
            <div className="hint">
              DVR address: press Enter. DVR username/password: the DVR login. Then this Mac's password.
              It tests the DVR login once — if it says the login was rejected, check it in a browser before retrying
              (several wrong tries lock the Mac out of the DVR for ~30 min).
            </div>
          </Step>

          <Step n="5" title="Delete the installer copy (it contains the relay secret)">
            <CopyBlock command="rm /Users/Shared/install.sh" />
          </Step>

          <Step n="6" title="Check it's running">
            <CopyBlock command="tail -f ~/camera-relay/relay.log" />
            <div className="hint">
              During business hours you should see <code>sent Camera 04 (ch 4, … bytes)</code> lines every 15 minutes
              once cameras are configured. Press Ctrl+C to stop watching (the relay keeps running).
            </div>
          </Step>

          <Step n="—" title="Day-to-day: pause, resume, restart, check">
            <div className="hint">
              See the <a href="#commands" className="tag-blue">Commands</a> page — it opens without logging in, so
              whoever keeps the relay laptop can use it directly.
            </div>
          </Step>

          <Step n="—" title="If you ever need to stop or remove it">
            <CopyBlock command="sudo launchctl unload /Library/LaunchDaemons/com.camerareports.push-relay.plist" />
            <CopyBlock command="sudo rm /Library/LaunchDaemons/com.camerareports.push-relay.plist && rm -rf ~/camera-relay" />
          </Step>
        </div>
      </div>
    </div>
  );
}
