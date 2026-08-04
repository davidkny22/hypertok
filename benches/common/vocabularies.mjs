import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBenchmarkHtk } from "./gpt2_htk.mjs";
import {
  vocabularyIdentity,
  vocabularyIds,
  vocabularyRecord,
  vocabularyRegistry,
} from "./vocabulary_catalog.mjs";

export {
  vocabularyIdentity,
  vocabularyIds,
  vocabularyRecord,
  vocabularyRegistry,
};

const benchesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(benchesDirectory, "..");
const o200kPath = path.join(repositoryDirectory, "hypertok-vocab", "o200k", "vocab.htk");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function prepareVocabularyArtifact(id) {
  const record = vocabularyRecord(id);
  if (id === "gpt2") {
    const artifact = buildBenchmarkHtk();
    if (artifact.sha256 !== record.htkSha256) {
      throw new Error(
        `GPT-2 HTK digest mismatch: expected ${record.htkSha256}, got ${artifact.sha256}`,
      );
    }
    return Object.freeze({ ...artifact, vocabulary: id });
  }

  const fileBytes = fs.readFileSync(o200kPath);
  const actualSha256 = sha256(fileBytes);
  if (actualSha256 !== record.htkSha256) {
    throw new Error(
      `o200k HTK digest mismatch: expected ${record.htkSha256}, got ${actualSha256}`,
    );
  }
  return Object.freeze({
    vocabulary: id,
    bytes: new Uint8Array(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength),
    path: o200kPath,
    sha256: actualSha256,
    sourceSha256: record.source.sha256,
  });
}
