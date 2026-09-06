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
// Every form that can create a module dependency, not just `import x from "..."`. An earlier draft
// of this file matched only static `from "..."` specifiers, which silently ignored dynamic
// `import(...)` and `export ... from` re-exports -- so a module could acquire a dependency on a
// third sibling directory and these tests would still pass while the installed layout broke. That
// is not hypothetical: setup/drift-recon.mjs and setup/image-drift.mjs already use dynamic
// `await import("../skills/...")` today, and the first version of this test could not see them.
// Backticks are included because a template literal with a static prefix
// (`import(\`./model-routing.mjs?t=${x}\`)`, which setup/model-routing.test.mjs really does) is
// still a real dependency on a real path; only the prefix before any ${ is meaningful.
const SPECIFIER_FORMS = [
  /\bfrom\s*["'`]([^"'`$]+)/g,               // import x from "..."  /  export x from "..."
  /\bimport\s*\(\s*["'`]([^"'`$]+)/g,        // await import("...")
  /\brequire\s*\(\s*["'`]([^"'`$]+)/g,       // require("...") in any CommonJS holdout
  // Side-effect-only static import: `import "../../setup/foo.mjs";`. It has NO `from` token, so
  // the from-specifier pattern above cannot see it. Unused in this repo today, which is exactly
  // why it is easy to leave out and exactly why it belongs here: the claim these tests make is
  // about every dependency form, and a claim that happens to hold only because nobody has written
  // the missing form yet is not the claim being made. The negative lookahead keeps it from also
  // matching the `import(` call form, which the pattern above already handles.
  /\bimport\s+(?!\()["'`]([^"'`$]+)/g,
];

function specifiersIn(src) {
  const out = [];
  for (const re of SPECIFIER_FORMS) for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

const SHARED_PREFIX = "../../setup/";

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
    for (const spec of specifiersIn(src)) {
      if (!spec.startsWith(SHARED_PREFIX)) continue;
      const mod = spec.slice(SHARED_PREFIX.length);
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
    for (const spec of specifiersIn(src)) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue; // bare package specifier
      if (spec.startsWith("./") || spec.startsWith("../skills/")) continue;
      offenders.push(`${e} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `shared setup modules reaching outside setup/ and skills/:\n${offenders.join("\n")}`);
});
