import React, { useState } from 'react';

// Copy synchronously inside the click handler — old Safari (the relay Mac
// runs Sierra) has no navigator.clipboard, and execCommand only works
// during the user gesture.
function copyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { /* fall through */ }
  document.body.removeChild(ta);
  if (!ok && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text);
    ok = true;
  }
  return ok;
}

export default function CopyBlock({ command }) {
  const [state, setState] = useState(null);
  return (
    <div className="copy-block">
      <code>{command}</code>
      <button
        className={`btn${state === 'ok' ? ' active' : ''}`}
        onClick={() => {
          setState(copyText(command) ? 'ok' : 'fail');
          setTimeout(() => setState(null), 2000);
        }}
      >
        {state === 'ok' ? 'Copied' : state === 'fail' ? 'Select + ⌘C' : 'Copy'}
      </button>
    </div>
  );
}
