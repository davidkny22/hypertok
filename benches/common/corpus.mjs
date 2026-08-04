import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const corpusDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "corpus",
);
const roleIds = Object.freeze({
  arena: Object.freeze([
    "english-prose",
    "chinese",
    "source-code",
    "emoji-heavy",
    "long-document",
    "standard-text",
  ]),
  "script-stress": Object.freeze([
    "script-latin",
    "script-han",
    "script-arabic",
    "script-emoji",
  ]),
});

export function loadCorpus({ roles = ["arena"] } = {}) {
  if (
    !Array.isArray(roles) ||
    roles.length === 0 ||
    roles.some((role) => !Object.hasOwn(roleIds, role))
  ) {
    throw new Error(`Unsupported corpus roles: ${roles}`);
  }
  const manifestPath = path.join(corpusDirectory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.workloads)) {
    throw new Error("Unsupported corpus manifest");
  }

  const actualIds = manifest.workloads.map(({ id, role }) => `${role}:${id}`);
  const expectedIds = Object.entries(roleIds).flatMap(([role, ids]) =>
    ids.map((id) => `${role}:${id}`),
  );
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error(`Corpus workload order mismatch: ${actualIds.join(",")}`);
  }

  const selected = new Set(roles);
  return manifest.workloads
    .filter(({ role }) => selected.has(role))
    .map((entry) => {
      const filePath = path.join(corpusDirectory, entry.path);
      const bytes = fs.readFileSync(filePath);
      const digest = crypto.createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== entry.bytes) {
        throw new Error(`${entry.id} byte count ${bytes.length} != ${entry.bytes}`);
      }
      if (digest !== entry.sha256) {
        throw new Error(`${entry.id} sha256 ${digest} != ${entry.sha256}`);
      }

      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return Object.freeze({ ...entry, text });
    });
}

export function loadScriptCorpus() {
  return loadCorpus({ roles: ["arena", "script-stress"] });
}

export const workloadIds = roleIds.arena;
export const scriptStressIds = roleIds["script-stress"];
export const scriptWorkloadIds = Object.freeze([...workloadIds, ...scriptStressIds]);
