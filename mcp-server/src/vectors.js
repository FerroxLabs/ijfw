// --- Vector embeddings (W3.3 / H5a-b-c) ---
//
// Thin wrapper around a user-installed @xenova/transformers package. IJFW does
// not ship that dependency by default: vectors are an explicit opt-in so the
// zero-deps install path and npm-audit surface stay small.
//
// Environment control:
//   IJFW_VECTORS=off  -- disable vectors entirely (BM25-only; default)
//   IJFW_VECTORS=on   -- enable if the library is installed by the user
//   IJFW_VECTORS_MODEL -- override the embedding model (default: Xenova/all-MiniLM-L6-v2, ~23MB)
//
// Fallback: if @xenova/transformers isn't installed, vectors silently
// disable and callers get an `{ available: false, reason }` from getEmbedder().

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

// X3/S8 -- model integrity pin. When IJFW_VECTORS_MODEL_SHA256 is set, we
// SHA-256 the loaded model.onnx after download and refuse the embedder if
// the hash doesn't match. Empty (default) allows any -- documented as opt-in
// in NO_TELEMETRY.md. Implemented in Phase 6 after the audit found the var
// was read but never enforced.

let _pipelinePromise = null;

// R2-B -- locate the actual ONNX file the pipeline loaded. transformers.js
// uses several cache layouts (HuggingFace-style models--{org}--{name}
// snapshots; flat cacheDir; explicit localModelPath). Scan candidates,
// return the first that exists.
async function resolveModelFile(env, modelId) {
  const { existsSync, readdirSync, statSync } = await import('node:fs');
  const { join: pjoin } = await import('node:path');
  const roots = [];
  if (env && env.localModelPath) roots.push(env.localModelPath);
  if (env && env.cacheDir)       roots.push(env.cacheDir);
  if (process.env.IJFW_VECTORS_CACHE) roots.push(process.env.IJFW_VECTORS_CACHE);
  if (process.env.HOME)          roots.push(pjoin(process.env.HOME, '.cache', 'huggingface'));

  const filenames = ['model.onnx', 'model_quantized.onnx', 'model_fp16.onnx'];
  const modelSlugs = [
    modelId,
    modelId.replace('/', '_'),
    'models--' + modelId.replace('/', '--'),
  ];

  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    // Direct layout: {root}/{slug}/onnx/{file}
    for (const slug of modelSlugs) {
      for (const f of filenames) {
        const p = pjoin(root, slug, 'onnx', f);
        if (existsSync(p)) return p;
      }
    }
    // HF snapshots: {root}/models--{org}--{name}/snapshots/{rev}/onnx/{file}
    const hfDir = pjoin(root, 'models--' + modelId.replace('/', '--'));
    if (existsSync(hfDir) && statSync(hfDir).isDirectory()) {
      const snapshotsDir = pjoin(hfDir, 'snapshots');
      if (existsSync(snapshotsDir)) {
        for (const rev of readdirSync(snapshotsDir)) {
          for (const f of filenames) {
            const p = pjoin(snapshotsDir, rev, 'onnx', f);
            if (existsSync(p)) return p;
          }
        }
      }
    }
  }
  return null;
}

async function verifyModelSha(env, modelId) {
  const expected = process.env.IJFW_VECTORS_MODEL_SHA256;
  if (!expected) return { ok: true }; // no pin configured, skip verification
  try {
    const { createReadStream } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const modelPath = await resolveModelFile(env, modelId);
    if (!modelPath) {
      // R2-B -- fail OPEN with a clear reason rather than closed. A path-guess
      // miss should not disable a working embedder; surface the lack of
      // verification so the user can set IJFW_VECTORS_CACHE explicitly.
      process.stderr.write(
        `IJFW: SHA verification skipped -- couldn't locate ONNX for ${modelId}. ` +
        `Set IJFW_VECTORS_CACHE to the cache root or clear IJFW_VECTORS_MODEL_SHA256.\n`
      );
      return { ok: true, skipped: true };
    }
    await new Promise((resolve, reject) => {
      const h = createHash('sha256');
      const s = createReadStream(modelPath);
      s.on('error', reject);
      s.on('data', (c) => h.update(c));
      s.on('end', () => {
        const got = h.digest('hex');
        if (got === expected.toLowerCase()) resolve();
        else reject(new Error(`sha256 mismatch at ${modelPath}: expected ${expected}, got ${got}`));
      });
    });
    return { ok: true, verified: true };
  } catch (e) {
    // Hash mismatch IS a closed-fail (user pinned; we can't trust this model).
    return { ok: false, reason: `sha-verify-failed: ${e.message}` };
  }
}

async function loadPipeline() {
  if (_pipelinePromise) return _pipelinePromise;
  _pipelinePromise = (async () => {
    try {
      const lib = await import('@xenova/transformers');
      const { pipeline, env } = lib;
      // Models cache locally under $XDG_CACHE_HOME or ~/.cache/xenova/.
      env.localModelPath = process.env.IJFW_VECTORS_CACHE || undefined;
      env.allowRemoteModels = true;
      const model = process.env.IJFW_VECTORS_MODEL || DEFAULT_MODEL;
      const extractor = await pipeline('feature-extraction', model);
      // X3/S8 -- verify pinned SHA256 after load (post-download if remote).
      const sha = await verifyModelSha(env, model);
      if (!sha.ok) return { ok: false, reason: sha.reason };
      return { ok: true, extractor, model };
    } catch (e) {
      return { ok: false, reason: e.code === 'ERR_MODULE_NOT_FOUND'
        ? 'transformers-not-installed'
        : `load-failed: ${e.message}` };
    }
  })();
  return _pipelinePromise;
}

export function vectorsEnabled() {
  const v = (process.env.IJFW_VECTORS || 'off').toLowerCase();
  return v === 'on' || v === '1' || v === 'true';
}

// Returns { available: true, embed(text) → Float32Array } or
//         { available: false, reason }.
export async function getEmbedder() {
  if (!vectorsEnabled()) return { available: false, reason: 'disabled-by-env' };
  const loaded = await loadPipeline();
  if (!loaded.ok) return { available: false, reason: loaded.reason };
  return {
    available: true,
    model: loaded.model,
    embed: async (text) => {
      const out = await loaded.extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(out.data);
    },
  };
}

// Cosine similarity on two equal-length Float32 arrays (or plain arrays).
// Both inputs should already be L2-normalized (our embedder's normalize: true
// guarantees that) so this reduces to a dot product.
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Hybrid rerank: BM25 scores + vector cosine. Mixes with weights.
//   bm25Results: [{ id, score, ... }]
//   vectorMatches: Map<id, cosine>
// Returns merged, resorted list.
export function hybridRerank(bm25Results, vectorScores, opts = {}) {
  const wBm25 = opts.wBm25 ?? 0.6;
  const wVec = opts.wVec ?? 0.4;
  // Normalize BM25 scores to 0..1 by dividing by max.
  const maxB = Math.max(0.0001, ...bm25Results.map(r => r.score));
  return bm25Results
    .map(r => {
      const vec = vectorScores.get(r.id) ?? 0;
      const merged = (r.score / maxB) * wBm25 + vec * wVec;
      return { ...r, bm25_score: r.score, vector_score: vec, score: merged };
    })
    .sort((a, b) => b.score - a.score);
}
