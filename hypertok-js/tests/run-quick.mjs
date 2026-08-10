import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.resolve(packageRoot, "..", "tests", "run.ps1");
const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";
const result = spawnSync(
  executable,
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner, "quick"],
  { stdio: "inherit" },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
