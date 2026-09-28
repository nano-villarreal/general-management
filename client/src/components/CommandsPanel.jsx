import React from 'react';
import CopyBlock from './CopyBlock';

// Day-to-day commands for whoever keeps the relay laptop. Deliberately
// viewable WITHOUT logging in (App.jsx renders it before the auth gate for
// #commands) — the laptop's owner may not have the app password, and
// nothing here is secret.

const PLIST = '/Library/LaunchDaemons/com.camerareports.push-relay.plist';

function Section({ title, children }) {
  return (
    <div className="setup-step">
      <div className="setup-step-title">{title}</div>
      {children}
    </div>
  );
}

export default function CommandsPanel() {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Relay laptop — commands</span>
      </div>
      <div className="panel-body">
        <div className="setup">
          <div className="hint">
            For the laptop that sends the warehouse camera snapshots. Open <b>Terminal</b>, click <b>Copy</b>, paste (⌘V),
            press Enter. Commands starting with <code>sudo</code> ask for the laptop's password — nothing shows while you
            type, that's normal.
          </div>

          <Section title="Lost Wi-Fi, went to sleep, or restarted? Nothing to do.">
            <div className="hint">
              The relay retries every minute and starts itself when the laptop boots. As soon as the laptop is back on
              the warehouse Wi-Fi, awake, snapshots resume on their own.
            </div>
          </Section>

          <Section title="Leaving the warehouse → pause">
            <div className="hint">
              Stops the relay so it doesn't try to reach the DVR from another network. Stays paused through restarts.
            </div>
            <CopyBlock command={`sudo launchctl unload -w ${PLIST}`} />
          </Section>

          <Section title="Back at the warehouse → resume">
            <CopyBlock command={`sudo launchctl load -w ${PLIST}`} />
          </Section>

          <Section title="Is it working? → see the latest activity">
            <CopyBlock command="tail -n 20 ~/camera-relay/relay.log" />
            <div className="hint">
              Healthy: recent <code>sent Camera 04 (ch 4, … bytes)</code> lines, every 15 minutes during business hours.
              <br /><code>cannot reach server</code> → no internet. <code>could not reach the DVR</code> → not on the
              warehouse Wi-Fi. <code>DVR rejected the login</code> → the DVR password changed (reinstall with the new one).
            </div>
            <div className="hint">Watch it live (Ctrl+C to stop watching — the relay keeps running):</div>
            <CopyBlock command="tail -f ~/camera-relay/relay.log" />
          </Section>

          <Section title="Seems stuck → restart it">
            <CopyBlock command="sudo launchctl kickstart -k system/com.camerareports.push-relay" />
          </Section>

          <Section title="Put the laptop's normal sleep settings back">
            <div className="hint">
              The installer turned sleep off so the relay keeps running. This restores the defaults — but the relay then
              stops whenever the laptop sleeps (including with the lid closed).
            </div>
            <CopyBlock command="sudo pmset restoredefaults" />
          </Section>

          <Section title="Remove the relay completely">
            <CopyBlock command={`sudo launchctl unload -w ${PLIST} && sudo rm ${PLIST} && rm -rf ~/camera-relay`} />
          </Section>
        </div>
      </div>
    </div>
  );
}
