import React, { useState, useEffect } from 'react';
import { api } from '../api';

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

const STATUS_BADGE = { WORKING: 'badge-green', IDLE: 'badge-amber', MIXED: 'badge-blue', EMPTY: 'badge-dim', UNREACHABLE: 'badge-red' };

function fmtPeople(r) {
  if (r.peopleCount == null || r.peopleCount === 0) return null;
  return `${r.engagedCount}E/${r.disengagedCount}D`;
}

export default function CameraReportsPanel() {
  const [rows, setRows] = useState(null);
  const [summary, setSummary] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

  function toggleExpand(id) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function load() {
    api.cameraReports(30).then(setRows);
    api.cameraReportsSummary().then(setSummary);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  async function tagReference(r) {
    const input = window.prompt(
      "What's actually happening in this photo? (which clients' orders are done/pending, what stage of the day it is, etc.)",
      r.referenceNote || ''
    );
    if (input === null) return; // cancelled
    const note = input.trim();
    if (!note) { window.alert('Enter a description.'); return; }
    await api.markReference(r._id, note);
    load();
  }

  async function clearReference(r) {
    await api.unmarkReference(r._id);
    load();
  }

  async function tagEngagement(r) {
    const input = window.prompt(
      "What did it get wrong about engagement/phone-use here, and why? (e.g. \"device in hand at the folding table isn't phone use\")",
      r.engagementNote || ''
    );
    if (input === null) return; // cancelled
    const note = input.trim();
    if (!note) { window.alert('Enter a correction.'); return; }
    await api.markEngagement(r._id, note);
    load();
  }

  async function clearEngagement(r) {
    await api.unmarkEngagement(r._id);
    load();
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">
          Camera Reports
          {summary && summary.idleFlagsToday > 0 && (
            <span style={{ fontSize: 9, color: 'var(--red)', marginLeft: 8 }}>●{summary.idleFlagsToday} alert{summary.idleFlagsToday === 1 ? '' : 's'} today</span>
          )}
        </span>
      </div>

      {summary && (
        <div style={{
          display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center',
          padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 10, flexShrink: 0,
        }}>
          <span style={{ color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 9 }}>Today</span>
          <span style={{ color: 'var(--text)', fontWeight: 700 }}>{summary.totalChecks} checks</span>
          <span style={{ color: 'var(--green)' }}>{summary.totalEngaged || 0} engaged</span>
          <span style={{ color: 'var(--amber)' }}>{summary.totalDisengaged || 0} disengaged</span>
          {summary.totalOnPhone > 0 && (
            <span style={{ color: 'var(--red)' }}>{summary.totalOnPhone} on phone</span>
          )}
          <span style={{ color: 'var(--text3)' }}>{summary.byStatus.EMPTY || 0} empty</span>
          {summary.byStatus.UNREACHABLE > 0 && (
            <span style={{ color: 'var(--red)', fontWeight: 700 }}>{summary.byStatus.UNREACHABLE} unreachable</span>
          )}
          <span style={{ color: summary.idleFlagsToday > 0 ? 'var(--red)' : 'var(--text3)', fontWeight: summary.idleFlagsToday > 0 ? 700 : 400 }}>
            {summary.idleFlagsToday} alert{summary.idleFlagsToday === 1 ? '' : 's'}
          </span>
          {summary.lastCheckAt && (
            <span style={{ color: 'var(--text3)', marginLeft: 'auto' }}>last check {fmtTime(summary.lastCheckAt)}</span>
          )}
        </div>
      )}

      <div className="panel-body" style={{ padding: 0 }}>
        {!rows ? (
          <div className="loading">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="empty">No checks yet</div>
        ) : (
          rows.map(r => {
            const isAnomaly = r.note?.startsWith('ANOMALY:');
            const noteText = r.status === 'UNREACHABLE' ? (r.error || 'Camera unreachable') : (r.note || null);
            const people = fmtPeople(r);
            const isExpanded = expanded.has(r._id);
            const noteStyle = isExpanded
              ? { WebkitLineClamp: 'unset', display: 'block' }
              : {};
            return (
              <div
                key={r._id}
                className="cam-report-row"
                style={{ cursor: 'pointer' }}
                onClick={() => toggleExpand(r._id)}
                title={isExpanded ? 'Click to collapse' : 'Click to expand full text'}
              >
                <div className="cam-report-meta">
                  <span style={{ color: 'var(--text3)' }}>{fmtTime(r.timestamp)}</span>
                  <span className="clamp1" style={{ maxWidth: 90 }} title={r.zone}>{r.zone}</span>
                  <span
                    className={STATUS_BADGE[r.status] || 'badge-dim'}
                    style={{ padding: '2px 5px', borderRadius: 3, fontSize: 9, flexShrink: 0 }}
                  >
                    {r.status}
                  </span>
                  {r.visualCompletionPct != null && (
                    <span style={{ color: 'var(--cyan)', fontWeight: 600 }}>{r.visualCompletionPct}%</span>
                  )}
                  {people && (
                    <span style={{ color: r.onPhoneCount > 0 ? 'var(--red)' : r.disengagedCount > 0 ? 'var(--amber)' : 'var(--text2)' }}>
                      {people}{r.onPhoneCount > 0 ? ` · ${r.onPhoneCount} phone` : ''}
                    </span>
                  )}
                  {r.frameId && (
                    <span
                      className="cam-report-actions"
                      style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 'auto', flexShrink: 0 }}
                      onClick={e => e.stopPropagation()}
                    >
                      <a href={api.cameraFrameUrl(r._id)} target="_blank" rel="noreferrer" className="tag-blue" style={{ textDecoration: 'none' }}>view</a>
                      {r.referenceNote ? (
                        <button
                          className="btn active"
                          style={{ padding: '1px 4px', fontSize: 8 }}
                          title={`"${r.referenceNote}" — click to remove this note`}
                          onClick={() => clearReference(r)}
                        >
                          NOTED
                        </button>
                      ) : (
                        <button
                          className="btn"
                          style={{ padding: '1px 4px', fontSize: 8 }}
                          title="Describe what's actually happening in this photo, so future checks can learn from it"
                          onClick={() => tagReference(r)}
                        >
                          Describe
                        </button>
                      )}
                      {people && (
                        r.engagementNote ? (
                          <button
                            className="btn active"
                            style={{ padding: '1px 4px', fontSize: 8 }}
                            title={`"${r.engagementNote}" — click to remove this correction`}
                            onClick={() => clearEngagement(r)}
                          >
                            FIXED
                          </button>
                        ) : (
                          <button
                            className="btn"
                            style={{ padding: '1px 4px', fontSize: 8 }}
                            title="Correct an engagement/phone-use call this check got wrong, so future checks can learn from it"
                            onClick={() => tagEngagement(r)}
                          >
                            Fix
                          </button>
                        )
                      )}
                    </span>
                  )}
                </div>
                {noteText && (
                  <div
                    className="cam-report-note"
                    style={{
                      color: r.status === 'UNREACHABLE' || isAnomaly ? 'var(--red)' : 'var(--text2)',
                      fontWeight: isAnomaly ? 700 : 400,
                      ...noteStyle,
                    }}
                  >
                    {noteText}
                    {r.suppressedByBreak && <span style={{ color: 'var(--amber)' }}> · on break ({r.onBreak.join(', ')})</span>}
                  </div>
                )}
                {r.referenceNote && (
                  <div className="cam-report-note" style={{ color: 'var(--orange)', fontStyle: 'italic', ...noteStyle }}>
                    Your note: {r.referenceNote}
                  </div>
                )}
                {r.engagementNote && (
                  <div className="cam-report-note" style={{ color: 'var(--red)', fontStyle: 'italic', ...noteStyle }}>
                    Your correction: {r.engagementNote}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
