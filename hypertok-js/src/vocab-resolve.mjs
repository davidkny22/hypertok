import { verifyVocabBytes, VocabIntegrityError } from "./vocab-integrity.mjs";

const DEFAULT_TIMEOUT_MS = 5_000;

export { VocabIntegrityError };

export const VOCAB_VERSIONS = Object.freeze({
  "cl100k": "1.0.0",
  "command-a-plus": "1.0.0",
  "deepseek-v4": "1.0.0",
  "gemma4": "1.0.0",
  "glm5-2": "1.0.0",
  "gpt2": "1.0.0",
  "kimi-k3": "1.0.0",
  "llama3": "1.0.0",
  "minimax-m3": "1.0.0",
  "mistral-tekken": "1.0.0",
  "nemotron3": "1.0.0",
  "o200k": "1.0.0",
  "p50k": "1.0.0",
  "qwen3-6": "1.0.0",
});

function vocabName(value) {
  if (typeof value !== "string") throw new TypeError("vocabulary name must be a string");
  const name = value.startsWith("@hypertok/vocab-")
    ? value.slice("@hypertok/vocab-".length)
    : value;
  if (!Object.hasOwn(VOCAB_VERSIONS, name)) {
    throw new RangeError(`unknown hypertok vocabulary: ${value}`);
  }
  return name;
}

function vocabFile(value) {
  if (value === undefined) return "vocab.htk";
  if (typeof value !== "string" || !/^[a-z0-9-]+\.htk$/u.test(value)) {
    throw new TypeError("vocabulary file must be a package-root .htk filename");
  }
  return value;
}

function timeoutMilliseconds(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("vocabulary load timeout must be a positive number");
  }
  return value;
}

async function readInstalledVocab(packageName, file) {
  if (typeof import.meta.resolve !== "function") {
    throw new Error("installed package resolution is unavailable");
  }
  const asset = import.meta.resolve(`${packageName}/${file}`);
  const moduleName = "node:fs/promises";
  const { readFile } = await import(/* webpackIgnore: true */ /* @vite-ignore */ moduleName);
  return readFile(new URL(asset));
}

function defaultFetch(...parameters) {
  if (typeof globalThis.fetch !== "function") throw new Error("fetch is unavailable");
  return globalThis.fetch(...parameters);
}

async function fetchWithTimeout(fetcher, url, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`vocabulary load timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const request = (async () => {
      const response = await fetcher(url, { signal: controller.signal });
      if (response === null || typeof response !== "object" || response.ok !== true) {
        const status = response?.status ?? "unknown";
        throw new Error(`vocabulary fetch failed with status ${status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    })();
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function verifiedFetchedVocab(fetcher, url, timeoutMs, packageName, suffix, file) {
  const bytes = await fetchWithTimeout(fetcher, url, timeoutMs);
  return verifyVocabBytes(bytes, packageName, suffix, file);
}

export function createVocabLoader({
  readLocal = readInstalledVocab,
  fetch = defaultFetch,
} = {}) {
  if (typeof readLocal !== "function") throw new TypeError("readLocal must be a function");
  if (typeof fetch !== "function") throw new TypeError("fetch must be a function");
  return async function load(name, options = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("vocabulary load options must be an object");
    }
    const suffix = vocabName(name);
    const file = vocabFile(options.file);
    const timeoutMs = timeoutMilliseconds(options.timeoutMs);
    const packageName = `@hypertok/vocab-${suffix}`;
    try {
      const bytes = await readLocal(packageName, file);
      if (bytes instanceof Uint8Array) return bytes;
      if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
      throw new TypeError("local vocabulary reader returned neither Uint8Array nor ArrayBuffer");
    } catch {
      const version = VOCAB_VERSIONS[suffix];
      const url = `https://cdn.jsdelivr.net/npm/${packageName}@${version}/${file}`;
      return verifiedFetchedVocab(fetch, url, timeoutMs, packageName, suffix, file);
    }
  };
}

export const loadVocab = createVocabLoader();
