// onnxruntime-node ships every platform's native binary in ONE package
// (~283MB unpacked) instead of per-platform optional deps. .slugignore
// can't trim this — Heroku's Node buildpack applies it BEFORE `npm install`
// populates node_modules, so it always matches zero files (confirmed: slug
// grew by the full ~286MB on the first deploy of this feature, not the
// trimmed amount). This runs as part of `heroku-postbuild` instead — which
// executes AFTER npm install, when the files actually exist — and deletes
// every platform/arch except the one the target runtime needs.
//
// Only wired into `heroku-postbuild`, never plain `build`, so local dev
// (any OS) is untouched — deleting your own platform's binary here would
// break local `node`/testing until the next `npm install`.
const fs = require('fs');
const path = require('path');

const KEEP_PLATFORM = process.env.KEEP_ONNX_PLATFORM || 'linux'; // Heroku dynos are linux/x64
const KEEP_ARCH = process.env.KEEP_ONNX_ARCH || 'x64';

const onnxBin = path.join(__dirname, '..', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');

if (!fs.existsSync(onnxBin)) {
  console.log('[trim-onnx] node_modules/onnxruntime-node/bin/napi-v6 not found — skipping');
  process.exit(0);
}

for (const platform of fs.readdirSync(onnxBin)) {
  const platformDir = path.join(onnxBin, platform);
  if (platform !== KEEP_PLATFORM) {
    fs.rmSync(platformDir, { recursive: true, force: true });
    console.log(`[trim-onnx] removed platform ${platform}`);
    continue;
  }
  for (const arch of fs.readdirSync(platformDir)) {
    if (arch !== KEEP_ARCH) {
      fs.rmSync(path.join(platformDir, arch), { recursive: true, force: true });
      console.log(`[trim-onnx] removed ${platform}/${arch}`);
    }
  }
}
console.log(`[trim-onnx] kept only ${KEEP_PLATFORM}/${KEEP_ARCH}`);

// The kept platform/arch still bundles GPU execution-provider libraries
// (CUDA alone is ~220MB) alongside the CPU one — dead weight on a Heroku
// dyno, which has no GPU. detectPersonsAndPhones never requests a
// non-default execution provider, so onnxruntime-node silently falls back
// to CPU either way; these files are pure bloat here.
const keptDir = path.join(onnxBin, KEEP_PLATFORM, KEEP_ARCH);
const GPU_PROVIDER_FILES = [
  'libonnxruntime_providers_cuda.so',
  'libonnxruntime_providers_tensorrt.so',
];
if (fs.existsSync(keptDir)) {
  for (const file of GPU_PROVIDER_FILES) {
    const filePath = path.join(keptDir, file);
    if (fs.existsSync(filePath)) {
      const sizeMB = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);
      fs.rmSync(filePath, { force: true });
      console.log(`[trim-onnx] removed GPU provider ${file} (${sizeMB}MB)`);
    }
  }
}
