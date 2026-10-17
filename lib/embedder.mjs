// The local embedding model behind lib/search.mjs: bge-small-en-v1.5 through
// transformers.js, quantized, run on the CPU in this process. The model files (about
// 35 MB) download from the Hugging Face hub on first use into tools/board/.models/ and
// are read from there afterwards, so a search needs no network once that is done.
// Nothing imports @huggingface/transformers until createEmbedder runs, which keeps the
// MCP server's start-up and every lexical search free of the model.
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultModelsDir } from './registry.mjs';
import { BoardError } from './store.mjs';

export const MODEL = 'Xenova/bge-small-en-v1.5';
export const DIMS = 384;
const LOCAL_MODELS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.models');
export const MODELS_DIR = existsSync(LOCAL_MODELS) ? LOCAL_MODELS : defaultModelsDir();
/** bge-small asymmetric retrieval: the query carries this instruction, passages do not. */
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const BATCH = 16;

export async function createEmbedder({ model = MODEL, cacheDir = MODELS_DIR, quiet = true, log = message => process.stderr.write(`${message}\n`) } = {}) {
  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch (error) {
    throw new BoardError('no_model', `the embedding model cannot load (${error.message}); run "npm ci", or search with mode "lexical"`);
  }
  const { pipeline, env } = transformers;
  env.cacheDir = cacheDir;
  // The library reports "download" even when it reads from its cache, so the cache is checked here.
  const cached = await access(path.join(cacheDir, model, 'onnx', 'model_quantized.onnx')).then(() => true, () => false);
  if (!quiet && !cached) log(`fetching ${model} (about 35 MB) into ${cacheDir}; later runs read it from there`);
  let extractor;
  try {
    extractor = await pipeline('feature-extraction', model, { dtype: 'q8' });
  } catch (error) {
    throw new BoardError('no_model', `the embedding model ${model} is not available (${error.message}); the first run needs a network connection to fetch it into ${cacheDir}, or search with mode "lexical"`);
  }
  const embed = async texts => {
    const out = [];
    for (let start = 0; start < texts.length; start += BATCH) {
      const tensor = await extractor(texts.slice(start, start + BATCH), { pooling: 'cls', normalize: true });
      for (const row of tensor.tolist()) out.push(Float32Array.from(row));
      tensor.dispose?.();
    }
    return out;
  };
  return {
    model,
    dims: DIMS,
    embedPassages: embed,
    embedQuery: async text => (await embed([QUERY_PREFIX + text]))[0],
  };
}
