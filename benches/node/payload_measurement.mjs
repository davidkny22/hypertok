import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { browserOutputDirectory } from "../browser/build.mjs";

let importSequence = 0;

if (typeof Uint8Array.fromBase64 !== "function") {
  Object.defineProperty(Uint8Array, "fromBase64", {
    configurable: true,
    value(encoded) {
      return new Uint8Array(Buffer.from(encoded, "base64"));
    },
  });
}

export async function loadReferencePayload(slug, vocabulary = "gpt2") {
  const payloadPath = path.join(
    browserOutputDirectory,
    "references",
    `${slug}.mjs.gz`,
  );
  const transferStarted = performance.now();
  const compressed = await fs.readFile(payloadPath);
  const transferMilliseconds = performance.now() - transferStarted;

  const decompressionStarted = performance.now();
  const decompressed = gunzipSync(compressed);
  const decompressionMilliseconds = performance.now() - decompressionStarted;
  const modulePath = path.join(browserOutputDirectory, "references", `${slug}.mjs`);
  const moduleBytes = await fs.readFile(modulePath);
  if (!moduleBytes.equals(decompressed)) {
    throw new Error(`${slug}: decompressed payload differs from the importable module`);
  }

  const sequence = importSequence;
  const moduleUrl = `${pathToFileURL(modulePath).href}?payload=${sequence}`;
  importSequence += 1;
  const materialisationStarted = performance.now();
  const module = await import(moduleUrl);
  const adapter = await module.createAdapter(vocabulary);
  const probeIds = Array.from(adapter.encode("x"));
  const materialisationMilliseconds = performance.now() - materialisationStarted;

  return {
    adapter,
    measurement: {
      reference: adapter.id,
      vocabulary: adapter.vocabulary,
      version: adapter.version,
      compressedBytes: compressed.length,
      decompressedBytes: decompressed.length,
      transferMilliseconds,
      decompressionMilliseconds,
      materialisationMilliseconds,
      probeIds,
    },
  };
}

export const nodePayloadModulePath = fileURLToPath(import.meta.url);
