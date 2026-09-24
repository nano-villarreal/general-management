import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';

// Must match LABEL_CLASSES / EXCLUSIVE_CLASSES in server.js.
const CLASSES = [
  { key: 'person', label: 'Person', short: 'P', color: '#0088ff', hotkey: '1' },
  { key: 'phone', label: 'Phone', short: 'PH', color: '#ff3333', hotkey: '2' },
  { key: 'engaged', label: 'Engaged', short: 'E', color: '#00cc44', hotkey: '3' },
  { key: 'disengaged', label: 'Disengaged', short: 'D', color: '#ffaa00', hotkey: '4' },
  { key: 'sitting', label: 'Sitting', short: 'SIT', color: '#00cccc', hotkey: '5' },
  { key: 'standing', label: 'Standing', short: 'STD', color: '#cc66ff', hotkey: '6' },
];
const CLASS_BY_KEY = Object.fromEntries(CLASSES.map(c => [c.key, c]));
const CLASS_BY_HOTKEY = Object.fromEntries(CLASSES.map(c => [c.hotkey, c.key]));
const EXCLUSIVE = { engaged: 'disengaged', disengaged: 'engaged', sitting: 'standing', standing: 'sitting' };

// Toggling a class on also switches off its mutually-exclusive partner.
function toggleClass(classes, key) {
  if (classes.includes(key)) return classes.filter(c => c !== key);
  return [...classes.filter(c => c !== EXCLUSIVE[key]), key];
}

// Box outline color: phone wins, then engagement state, then plain person.
function boxColor(classes) {
  for (const k of ['phone', 'disengaged', 'engaged', 'person', 'sitting', 'standing']) {
    if (classes.includes(k)) return CLASS_BY_KEY[k].color;
  }
  return '#ffffff';
}

function boxText(classes) {
  return CLASSES.filter(c => classes.includes(c.key)).map(c => c.short).join('·');
}

function fmtWhen(iso) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour12: false, hour: '2-digit', minute: '2-digit' });
}

const FILTERS = [
  { key: 'unlabeled', label: 'Unlabeled' },
  { key: 'labeled', label: 'Labeled' },
  { key: 'all', label: 'All' },
];

export default function LabelingPanel() {
  const [filter, setFilter] = useState('unlabeled');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(() => {
    setError(null);
    api.labelFrames(filter).then(setData).catch(err => setError(err.message));
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const rows = data?.rows || [];
  const selectedIndex = rows.findIndex(r => r._id === selectedId);
  const selected = selectedIndex >= 0 ? rows[selectedIndex] : null;

  function onSaved(id, boxes) {
    setData(prev => {
      const wasLabeled = !!prev.rows.find(r => r._id === id)?.labelBoxes;
      const isLabeled = boxes.length > 0;
      return {
        ...prev,
        labeledTotal: prev.labeledTotal + (isLabeled ? 1 : 0) - (wasLabeled ? 1 : 0),
        rows: prev.rows.map(r => (r._id === id ? { ...r, labelBoxes: isLabeled ? boxes : null } : r)),
      };
    });
  }

  function goNext() {
    // In the Unlabeled view, the next frame to do is the next one still unlabeled.
    const next = rows.find((r, i) => i > selectedIndex && (filter !== 'unlabeled' || !r.labelBoxes));
    setSelectedId(next ? next._id : null);
  }

  function goPrev() {
    if (selectedIndex > 0) setSelectedId(rows[selectedIndex - 1]._id);
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">
          Labeling
          {data && (
            <span style={{ color: 'var(--text3)', marginLeft: 10, fontWeight: 400 }}>
              {data.labeledTotal} of {data.frameTotal} frames labeled
            </span>
          )}
        </span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {selected ? (
            <button className="btn" onClick={() => { setSelectedId(null); load(); }}>← Back to grid</button>
          ) : (
            <>
              {FILTERS.map(f => (
                <button key={f.key} className={`btn${filter === f.key ? ' active' : ''}`} onClick={() => setFilter(f.key)}>
                  {f.label}
                </button>
              ))}
              <a className="btn" style={{ textDecoration: 'none' }} href={api.labelExportUrl} download="camera_dataset.zip">
                Export YOLO
              </a>
            </>
          )}
        </span>
      </div>

      {selected ? (
        <Annotator
          key={selected._id}
          report={selected}
          position={`${selectedIndex + 1} / ${rows.length}`}
          onSaved={boxes => onSaved(selected._id, boxes)}
          onNext={goNext}
          onPrev={selectedIndex > 0 ? goPrev : null}
        />
      ) : (
        <div className="panel-body">
          {error ? (
            <div className="empty" style={{ color: 'var(--red)' }}>{error}</div>
          ) : !data ? (
            <div className="loading">Loading...</div>
          ) : rows.length === 0 ? (
            <div className="empty">
              {filter === 'unlabeled' ? 'No unlabeled frames' : filter === 'labeled' ? 'No labeled frames yet' : 'No stored frames yet'}
            </div>
          ) : (
            <div className="label-grid">
              {rows.map(r => (
                <div key={r._id} className="label-thumb" onClick={() => setSelectedId(r._id)}>
                  <img src={api.cameraFrameUrl(r._id)} alt="" loading="lazy" />
                  <div className="label-thumb-meta">
                    <span className="clamp1">{r.camera} · {fmtWhen(r.timestamp)}</span>
                    <span className={r.labelBoxes ? 'badge-green' : 'badge-dim'}>
                      {r.labelBoxes ? `${r.labelBoxes.length} box${r.labelBoxes.length === 1 ? '' : 'es'}` : 'unlabeled'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Annotator({ report, position, onSaved, onNext, onPrev }) {
  const [boxes, setBoxes] = useState(report.labelBoxes || []);
  const [activeClasses, setActiveClasses] = useState(['person']);
  const [selectedBox, setSelectedBox] = useState(null);
  const [drawing, setDrawing] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const overlayRef = useRef(null);

  function updateBoxes(fn) {
    setBoxes(fn);
    setDirty(true);
  }

  // With a box selected, class toggles edit that box; otherwise they set the
  // classes the next drawn box gets.
  const onToggle = useCallback(key => {
    if (selectedBox != null) {
      setBoxes(prev => prev.map((b, i) => (i === selectedBox ? { ...b, classes: toggleClass(b.classes, key) } : b)));
      setDirty(true);
    } else {
      setActiveClasses(prev => toggleClass(prev, key));
    }
  }, [selectedBox]);

  const deleteBox = useCallback(i => {
    setBoxes(prev => prev.filter((_, idx) => idx !== i));
    setDirty(true);
    setSelectedBox(null);
  }, []);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (CLASS_BY_HOTKEY[e.key]) onToggle(CLASS_BY_HOTKEY[e.key]);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedBox != null) { e.preventDefault(); deleteBox(selectedBox); }
      else if (e.key === 'Escape') setSelectedBox(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onToggle, deleteBox, selectedBox]);

  function posFromEvent(e) {
    const rect = overlayRef.current.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }

  function handlePointerDown(e) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = posFromEvent(e);
    setDrawing({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  }

  function handlePointerMove(e) {
    if (!drawing) return;
    const p = posFromEvent(e);
    setDrawing(d => ({ ...d, x2: p.x, y2: p.y }));
  }

  function handlePointerUp() {
    if (!drawing) return;
    const x1 = Math.min(drawing.x1, drawing.x2);
    const x2 = Math.max(drawing.x1, drawing.x2);
    const y1 = Math.min(drawing.y1, drawing.y2);
    const y2 = Math.max(drawing.y1, drawing.y2);
    setDrawing(null);

    // A click (no real drag) selects the smallest box under the pointer.
    if (x2 - x1 < 0.01 || y2 - y1 < 0.01) {
      let hit = null, hitArea = Infinity;
      boxes.forEach((b, i) => {
        const area = (b.x2 - b.x1) * (b.y2 - b.y1);
        if (x1 >= b.x1 && x1 <= b.x2 && y1 >= b.y1 && y1 <= b.y2 && area < hitArea) { hit = i; hitArea = area; }
      });
      setSelectedBox(hit);
      return;
    }
    if (activeClasses.length === 0) {
      setError('Pick at least one class before drawing a box.');
      return;
    }
    setError(null);
    updateBoxes(prev => [...prev, { x1, y1, x2, y2, classes: activeClasses }]);
    setSelectedBox(null);
  }

  async function save() {
    if (boxes.some(b => b.classes.length === 0)) {
      setError('Every box needs at least one class — select it and pick one, or delete it.');
      return false;
    }
    setSaving(true);
    setError(null);
    try {
      await api.saveLabel(report._id, boxes);
      setDirty(false);
      onSaved(boxes);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveAndNext() {
    if (await save()) onNext();
  }

  function leave(fn) {
    if (dirty && !window.confirm('Discard unsaved boxes on this frame?')) return;
    fn();
  }

  const editing = selectedBox != null ? boxes[selectedBox] : null;
  const shownClasses = editing ? editing.classes : activeClasses;

  return (
    <div className="annotator">
      <div className="annotator-stage">
        <div className="annotator-image">
          <img src={api.cameraFrameUrl(report._id)} alt="" draggable={false} />
          <svg
            ref={overlayRef}
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            className="annotator-overlay"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => setDrawing(null)}
          >
            {boxes.map((b, i) => (
              <rect
                key={i}
                x={b.x1} y={b.y1} width={b.x2 - b.x1} height={b.y2 - b.y1}
                fill={i === selectedBox ? '#ffffff22' : 'none'}
                stroke={boxColor(b.classes)}
                strokeWidth={i === selectedBox ? 3 : 2}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {drawing && (
              <rect
                x={Math.min(drawing.x1, drawing.x2)}
                y={Math.min(drawing.y1, drawing.y2)}
                width={Math.abs(drawing.x2 - drawing.x1)}
                height={Math.abs(drawing.y2 - drawing.y1)}
                fill="none" stroke="#ffffff" strokeWidth={2} strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {boxes.map((b, i) => (
            <span
              key={i}
              className="annotator-box-label"
              style={{ left: `${b.x1 * 100}%`, top: `${b.y1 * 100}%`, background: boxColor(b.classes) }}
            >
              {boxText(b.classes) || '?'}
            </span>
          ))}
        </div>
      </div>

      <div className="annotator-side">
        <div className="annotator-meta">
          <div style={{ color: 'var(--text)' }}>{report.camera} · {report.zone}</div>
          <div>{fmtWhen(report.timestamp)} · {report.status}{report.peopleCount != null ? ` · model saw ${report.peopleCount}` : ''}</div>
          <div>Frame {position}</div>
        </div>

        <div className="field-label">
          {editing ? `Classes — box ${selectedBox + 1} (selected)` : 'Classes for next box'}
        </div>
        <div className="class-grid">
          {CLASSES.map(c => {
            const on = shownClasses.includes(c.key);
            return (
              <button
                key={c.key}
                className="btn"
                style={on ? { background: c.color, borderColor: c.color, color: '#000' } : {}}
                onClick={() => onToggle(c.key)}
                title={`Hotkey: ${c.hotkey}`}
              >
                {c.hotkey} {c.label}
              </button>
            );
          })}
        </div>
        <div className="hint">
          Drag on the frame to draw a box. Click a box to select it, then edit its classes or press Delete. Esc deselects.
          Engaged/Disengaged and Sitting/Standing can't both be on for the same box.
        </div>

        <div className="field-label">Boxes ({boxes.length})</div>
        <div className="box-list">
          {boxes.length === 0 ? (
            <div className="hint">No boxes yet. Saving with none marks the frame unlabeled.</div>
          ) : boxes.map((b, i) => (
            <div
              key={i}
              className={`box-row${i === selectedBox ? ' selected' : ''}`}
              onClick={() => setSelectedBox(i === selectedBox ? null : i)}
            >
              <span className="swatch" style={{ background: boxColor(b.classes) }} />
              <span className="box-desc">
                {i + 1}. {b.classes.length ? b.classes.map(k => CLASS_BY_KEY[k].label).join(', ') : <em style={{ color: 'var(--red)' }}>no class</em>}
              </span>
              <button className="box-del" onClick={e => { e.stopPropagation(); deleteBox(i); }} title="Delete">×</button>
            </div>
          ))}
        </div>

        {error && <div className="hint" style={{ color: 'var(--red)' }}>{error}</div>}

        <div className="annotator-actions">
          <button className="btn" onClick={() => leave(onPrev)} disabled={!onPrev}>← Prev</button>
          <button className="btn" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving...' : dirty ? 'Save' : 'Saved'}</button>
          <button className="btn active" onClick={saveAndNext} disabled={saving}>Save & Next</button>
          <button className="btn" onClick={() => leave(onNext)}>Skip →</button>
        </div>
      </div>
    </div>
  );
}
