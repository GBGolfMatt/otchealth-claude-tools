// Skills that import shared helpers as "../../setup/<mod>.mjs" must still resolve once installed
// into ~/.claude/skills, which means the installers have to place those modules at ~/.claude/setup.
//
// THE FAILURE THIS PINS (2026-09-06). skills/ and setup/ are siblings in the git tree, so
// `import { awsFetch } from "../../setup/aws-sigv4.mjs"` resolves fine from a clone. Both installers
// copied ONLY skills/, so at the installed path the same import resolved to ~/.claude/setup/... ,
// which did not exist. Thirteen skills across twenty files died with ERR_MODULE_NOT_FOUND when
// invoked from ~/.claude/skills, INCLUDING kb-memory (the fleet working-memory ledger) and
// company-brain.
//
// It stayed invisible for the worst possible reason: the same code worked perfectly when run from
// the /tmp/octools clone, which is how the ECS jobs and every explicitly-pathed call reach it. Only
// the installed path was dark, and the one signal it produced was a SessionStart hook line reading
// "kb-memory unavailable this session" -- which looks exactly like a benign transient.
//
// The check matches the DESTINATION, not merely the presence of a copy command. An installer that
// copied setup/*.mjs somewhere else would satisfy a source-only assertion while every import still
// failed, so the assertion is on the ~/.claude/setup path the runtime actually resolves to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_IMPORT = /["']\.\.\/\.\.\/setup\/([A-Za-z0-9._-]+\.mjs)["']/g;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".mjs") || e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

function sharedModulesReferencedBySkills() {
  const refs = new Map(); // module -> [files]
  for (const file of walk(join(ROOT, "skills"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(SHARED_IMPORT)) {
      const mod = m[1];
      if (!refs.has(mod)) refs.set(mod, []);
      refs.get(mod).push(file.slice(ROOT.length + 1));
    }
  }
  return refs;
}

test("every ../../setup module a skill imports actually exists in setup/", () => {
  const refs = sharedModulesReferencedBySkills();
  assert.ok(refs.size > 0, "expected at least one skill to import a shared setup module");
  const missing = [];
  for (const [mod, files] of refs) {
    if (!existsSync(join(ROOT, "setup", mod))) missing.push(`${mod} (imported by ${files.join(", ")})`);
  }
  assert.deepEqual(missing, [], `shared modules imported by skills but absent from setup/:\n${missing.join("\n")}`);
});

// Both install paths matter and for different reasons. session-start.sh is the fresh-session
// install; octools-sync.sh is the mid-session live refresh, so a skill that starts importing a NEW
// shared module would break in every already-running session until restart if only the former
// copied setup/.
for (const script of ["setup/session-start.sh", "setup/octools-sync.sh"]) {
  test(`${script} installs the shared setup modules into ~/.claude/setup`, () => {
    const src = readFileSync(join(ROOT, script), "utf8");

    // Expand the handful of shell variables that can stand in for the destination, so the assertion
    // reads the effective path rather than whichever spelling the script happens to use.
    let expanded = src;
    for (const [, name, value] of src.matchAll(/^\s*([A-Z_]+)="([^"]*)"\s*$/gm)) {
      expanded = expanded.split(`\${${name}}`).join(value).split(`$${name}`).join(value);
    }
    expanded = expanded.split("${HOME}").join("~").split("$HOME").join("~");

    const copiesShared = expanded
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .some((l) => /setup\/"?\*\.mjs/.test(l) && /~\/\.claude\/setup/.test(l));

    assert.ok(
      copiesShared,
      `${script} must copy setup/*.mjs into ~/.claude/setup, or every skill importing ` +
        `"../../setup/<mod>.mjs" fails with ERR_MODULE_NOT_FOUND when run from ~/.claude/skills.`,
    );
  });
}

test("the shared setup modules only reach back into setup/ or skills/, so the two-dir install is sufficient", () => {
  // If a shared module ever imported a THIRD sibling directory, installing skills/ + setup/ would
  // stop being enough and this test should be the thing that says so.
  const offenders = [];
  for (const e of readdirSync(join(ROOT, "setup"))) {
    if (!e.endsWith(".mjs")) continue;
    const src = readFileSync(join(ROOT, "setup", e), "utf8");
    for (const m of src.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)) {
      const spec = m[1];
      if (spec.startsWith("./") || spec.startsWith("../skills/")) continue;
      offenders.push(`${e} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `shared setup modules reaching outside setup/ and skills/:\n${offenders.join("\n")}`);
});
