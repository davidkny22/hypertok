import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));

function validate(document) {
  assert.equal(document.schemaVersion, 1);
  assert.ok(document.profiles && typeof document.profiles === "object");
  assert.ok(!Array.isArray(document.profiles));
  assert.ok(Array.isArray(document.commands));
  const commandIds = document.commands.map(({ id }) => id);
  assert.equal(new Set(commandIds).size, commandIds.length, "suite command ids must be unique");
  const commandById = new Map(document.commands.map((command) => [command.id, command]));
  for (const [id, command] of commandById) {
    assert.match(id, /^[a-z0-9-]+$/);
    assert.equal(typeof command.cwd, "string", id);
    assert.ok(!path.isAbsolute(command.cwd), `${id} cwd must be relative`);
    const workingDirectory = path.resolve(repository, command.cwd);
    assert.ok(
      workingDirectory === repository || workingDirectory.startsWith(`${repository}${path.sep}`),
      `${id} cwd escapes the repository`,
    );
    assert.equal(typeof command.executable, "string", id);
    assert.ok(command.executable.length > 0, id);
    assert.ok(Array.isArray(command.arguments), id);
    assert.ok(command.arguments.every((argument) => typeof argument === "string"), id);
  }

  const profiles = new Map(Object.entries(document.profiles));
  for (const [name, profile] of profiles) {
    assert.match(name, /^[a-z0-9-]+$/);
    assert.ok(Array.isArray(profile.includes), `${name} includes must be an array`);
    assert.ok(Array.isArray(profile.commands), `${name} commands must be an array`);
    assert.equal(new Set(profile.includes).size, profile.includes.length, `${name} includes repeat`);
    assert.equal(new Set(profile.commands).size, profile.commands.length, `${name} commands repeat`);
    for (const include of profile.includes) {
      assert.ok(profiles.has(include), `unknown included profile ${include}`);
    }
    for (const id of profile.commands) assert.ok(commandById.has(id), `unknown command ${id}`);
  }

  const expanded = new Set();
  const visiting = new Set();
  function expand(name) {
    if (expanded.has(name)) return;
    assert.ok(!visiting.has(name), `suite profile cycle at ${name}`);
    visiting.add(name);
    for (const include of profiles.get(name).includes) expand(include);
    visiting.delete(name);
    expanded.add(name);
  }
  for (const name of profiles.keys()) expand(name);
}

validate(manifest);
const duplicate = structuredClone(manifest);
duplicate.commands.push(duplicate.commands[0]);
assert.throws(() => validate(duplicate), /must be unique/);
const unknown = structuredClone(manifest);
const firstProfile = Object.values(unknown.profiles)[0];
firstProfile.commands.push("missing-command");
assert.throws(() => validate(unknown));
const cycle = structuredClone(manifest);
const [firstName, secondName] = Object.keys(cycle.profiles);
cycle.profiles[firstName].includes.push(secondName);
cycle.profiles[secondName].includes.push(firstName);
assert.throws(() => validate(cycle), /cycle/);

console.log(
  `suite manifest PASS (${Object.keys(manifest.profiles).length} profiles, ${manifest.commands.length} commands)`,
);
console.log("suite manifest mutations RED (duplicate id, unknown command, profile cycle)");
