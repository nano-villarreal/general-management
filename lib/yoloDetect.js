// Local, free, zero-API-cost object detection (YOLOv8n, pretrained on COCO —
// no custom training, "person" and "cell phone" are already COCO classes 0
// and 67) used as a deterministic pre-check before the Claude classification
// call in integrations/camera.js. This does NOT decide engagement on its
// own — it hands Claude a second, independent signal ("N phone-shaped
// objects near a person") alongside its own visual judgment, since a
// generic object detector has real false positives (a scanner/remote/radio
// can look like a phone) and false negatives (a phone held low or angled
// away is easy to miss) of its own.
//
// Reuses ffmpeg-static (already a dependency for frame capture in
// camera.js) to decode/resize the JPEG to the model's 640x640 input,
// instead of adding an image-processing library for one conversion step.
//
// Model: a stock, pretrained yolov8n.onnx (~13MB) vendored at
// models/yolov8n.onnx — see scripts/trim-onnx-platforms.js (wired into
// heroku-postbuild) for why the onnxruntime-node package, which bundles
// every platform's native binary plus GPU execution providers in one
// package (~283MB unpacked), is trimmed to just the CPU linux/x64 build in
// the deployed Heroku slug.

const { execFile } = require('child_process');
const path = require('path');
const ort = require('onnxruntime-node');
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');

const MODEL_PATH = path.join(__dirname, '..', 'models', 'yolov8n.onnx');
const INPUT_SIZE = 640;
const PERSON_CLASS = 0;
const PHONE_CLASS = 67;
// Separate thresholds, not one shared value — diagnosed live against a
// report where Claude correctly saw 3 people but yoloDetection said 1
// (scripts/debug-yolo-report.js): the model actually proposed all 3 (raw
// scores 0.58-0.75, 0.199, ~0.11), but two were sitting/partially-occluded
// people that only scored ~0.10-0.20, below the general-purpose 0.35
// default. Phones are a different failure mode — that same frame had ZERO
// phone candidates at any score down to 0.10, a true miss, not a threshold
// problem — so PHONE_CONF_THRESHOLD is left at the conservative default.
const PERSON_CONF_THRESHOLD = 0.15;
const PHONE_CONF_THRESHOLD = 0.35;
const IOU_THRESHOLD = 0.45;
// How far a phone's center can be from a person's box — as a fraction of
// that person's own box size — and still count as "near" them. A phone
// detected across the room from anyone isn't "in someone's hand".
const PROXIMITY_MARGIN = 0.35;
const DETECT_TIMEOUT_MS = 10000;

let sessionPromise = null;
function getSession() {
  if (!sessionPromise) sessionPromise = ort.InferenceSession.create(MODEL_PATH);
  return sessionPromise;
}

function decodeToRgb(jpegBuffer) {
  return new Promise((resolve, reject) => {
    const proc = execFile(ffmpegPath, [
      '-y', '-i', 'pipe:0',
      '-vf', `scale=${INPUT_SIZE}:${INPUT_SIZE}`,
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024, timeout: DETECT_TIMEOUT_MS }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
    proc.stdin.on('error', () => {}); // ffmpeg exiting early throws EPIPE here; the execFile callback's err covers it
    proc.stdin.end(jpegBuffer);
  });
}

// HWC uint8 RGB -> CHW float32 [0,1], the layout YOLOv8's ONNX export expects.
function toTensor(rgbBuffer) {
  const size = INPUT_SIZE * INPUT_SIZE;
  const data = new Float32Array(3 * size);
  for (let i = 0; i < size; i++) {
    data[i] = rgbBuffer[i * 3] / 255;
    data[size + i] = rgbBuffer[i * 3 + 1] / 255;
    data[2 * size + i] = rgbBuffer[i * 3 + 2] / 255;
  }
  return new ort.Tensor('float32', data, [1, 3, INPUT_SIZE, INPUT_SIZE]);
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter);
}

function nms(boxes) {
  boxes.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of boxes) {
    if (kept.every(k => k.cls !== box.cls || iou(k, box) < IOU_THRESHOLD)) kept.push(box);
  }
  return kept;
}

// Output dims [1, 84, 8400]: rows 0-3 are cx,cy,w,h (in 640-space), rows
// 4-83 are the 80 COCO class scores. Checks person/phone scores directly
// per anchor rather than taking an argmax across all 80 classes first —
// the argmax approach silently dropped valid person/phone candidates
// whenever some unrelated class (e.g. "chair", "dining table") scored
// marginally higher at that anchor, even below any threshold that mattered
// to us; since only these 2 of 80 classes are ever used, there's no reason
// to let the other 78 compete for the slot at all.
function parseOutput(tensor) {
  const data = tensor.data;
  const numAnchors = tensor.dims[2];
  const boxes = [];
  for (let i = 0; i < numAnchors; i++) {
    const personScore = data[(4 + PERSON_CLASS) * numAnchors + i];
    const phoneScore = data[(4 + PHONE_CLASS) * numAnchors + i];
    if (personScore < PERSON_CONF_THRESHOLD && phoneScore < PHONE_CONF_THRESHOLD) continue;
    const cx = data[i], cy = data[numAnchors + i];
    const w = data[2 * numAnchors + i], h = data[3 * numAnchors + i];
    const box = { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
    if (personScore >= PERSON_CONF_THRESHOLD) boxes.push({ ...box, score: personScore, cls: PERSON_CLASS });
    if (phoneScore >= PHONE_CONF_THRESHOLD) boxes.push({ ...box, score: phoneScore, cls: PHONE_CLASS });
  }
  return nms(boxes);
}

function phoneNearAnyPerson(phone, persons) {
  const phoneCx = (phone.x1 + phone.x2) / 2, phoneCy = (phone.y1 + phone.y2) / 2;
  return persons.some(p => {
    const mx = (p.x2 - p.x1) * PROXIMITY_MARGIN, my = (p.y2 - p.y1) * PROXIMITY_MARGIN;
    return phoneCx >= p.x1 - mx && phoneCx <= p.x2 + mx && phoneCy >= p.y1 - my && phoneCy <= p.y2 + my;
  });
}

// Returns null on any failure (missing model file, ffmpeg hiccup, bad
// frame) — this is a best-effort second opinion, never a hard dependency
// for the check to proceed. Callers must treat null as "no local signal
// available this time" and fall back to Claude's own judgment alone.
async function detectPersonsAndPhones(jpegBuffer) {
  try {
    const [session, rgb] = await Promise.all([getSession(), decodeToRgb(jpegBuffer)]);
    const tensor = toTensor(rgb);
    const out = await session.run({ images: tensor });
    const boxes = parseOutput(out.predictions);
    const persons = boxes.filter(b => b.cls === PERSON_CLASS);
    const phones = boxes.filter(b => b.cls === PHONE_CLASS);
    const phonesNearPerson = phones.filter(p => phoneNearAnyPerson(p, persons)).length;
    return { personCount: persons.length, phoneCount: phones.length, phonesNearPerson };
  } catch (err) {
    console.error('[yolo] detection failed:', err.message);
    return null;
  }
}

module.exports = { detectPersonsAndPhones };
