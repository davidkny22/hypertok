import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(directory, "..", "..");
const executable = process.env.HYPERTOK_POWERSHELL ??
  (process.platform === "win32" ? "powershell.exe" : "pwsh");
const result = spawnSync(
  executable,
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(directory, "measure.ps1"),
  ],
  { cwd: repositoryDirectory, env: process.env, stdio: "inherit" },
);
if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
