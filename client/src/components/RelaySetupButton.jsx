import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api';

// One-time reveal of the pre-filled relay install command (see
// /api/relay-setup/claim in server.js). The server hands it out exactly once;
// after that this button never renders again.
export default function RelaySetupButton() {
  const [available, setAvailable] = useState(false);
  const [command, setCommand] = useState(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const textRef = useRef(null);

  useEffect(() => {
    api.relaySetup().then(r => setAvailable(!!(r && r.available))).catch(() => {});
  }, []);

  useEffect(() => {
    if (!command || !textRef.current) return;
    textRef.current.focus();
    textRef.current.select();
    // Old Safari has no navigator.clipboard; execCommand works on the
    // selected textarea there. If both fail, the text stays selected for ⌘C.
    const fallback = () => { try { setCopied(document.execCommand('copy')); } catch (e) { /* manual copy */ } };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(command).then(() => setCopied(true), fallback);
    } else {
      fallback();
    }
  }, [command]);

  async function reveal() {
    if (!window.confirm('This shows the relay install command ONE time only — the button disappears for good afterwards. Click it on the computer where you will paste the command. Continue?')) return;
    setAvailable(false);
    try {
      const r = await api.claimRelayCommand();
      setCommand(r.command);
    } catch (err) {
      setError(err.message);
    }
  }

  if (command) {
    return (
      <div className="relay-reveal">
        <div className="relay-reveal-box">
          <div className="field-label">Relay install command — shown once</div>
          <textarea ref={textRef} readOnly value={command} rows={4} onFocus={e => e.target.select()} />
          <div className="hint" style={{ color: copied ? 'var(--green)' : 'var(--amber)' }}>
            {copied ? 'Copied to clipboard. Paste it into Terminal and press Enter.' : 'Press ⌘C (Ctrl+C) now to copy it — it is already selected.'}
          </div>
          <button
            className="btn"
            onClick={() => {
              if (window.confirm('Hide it for good? Make sure it is pasted somewhere first.')) setCommand(null);
            }}
          >
            Done
          </button>
        </div>
      </div>
    );
  }
  if (error) return <span className="hint" style={{ color: 'var(--red)' }}>{error}</span>;
  if (!available) return null;
  return <button className="btn" onClick={reveal}>Relay install command</button>;
}
