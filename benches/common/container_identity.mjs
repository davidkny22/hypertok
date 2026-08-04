import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function readContainerIdentity(commit, environment = process.env) {
  const requested = environment.HYPERTOK_CONTAINER_IDENTITY;
  if (requested === undefined || requested.length === 0) return null;
  const filePath = path.resolve(requested);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Container identity is absent: ${filePath}`);
  }
  const bytes = fs.readFileSync(filePath);
  const record = JSON.parse(bytes.toString("utf8"));
  if (
    record.commit !== commit ||
    typeof record.containerId !== "string" ||
    record.containerId.length === 0 ||
    record.crossOriginIsolated !== true
  ) {
    throw new Error("Container identity does not match the isolated product commit");
  }
  return Object.freeze({
    containerId: record.containerId,
    containerIdentitySha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  });
}
