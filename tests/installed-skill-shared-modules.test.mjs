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
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A file V8 could not parse is a file whose dependencies were never checked. Surface it instead of
// letting it count as "no dependencies found", which would read as a pass.
function assertNoParseErrors(parsed) {
  const bad = Object.entries(parsed)
    .filter(([, v]) => v && !Array.isArray(v) && v.__parseError)
    .map(([f, v]) => `${f}: ${v.__parseError}`);
  assert.deepEqual(bad, [], `files that could not be parsed, so their imports went unchecked:\n${bad.join("\n")}`);
}
// HOW DEPENDENCIES ARE FOUND, and why it is not a pile of regexes.
//
// Three rounds of review on this file each found another import form the pattern list had missed:
// dynamic import and re-exports, then side-effect-only `import "x.mjs"`, then block-comment trivia,
// and a line-comment variant after that. Every one was a real, valid form. The lesson was not "add
// another alternation" -- it was that pattern-matching JavaScript syntax has no natural stopping
// point, and each round shipped a slightly-less-wrong claim of completeness.
//
// So STATIC imports are now parsed by V8 itself. `vm.SourceTextModule` compiles the source and
// exposes `dependencySpecifiers`, the exact list of static specifiers, without executing anything.
// That covers every static form -- `import x from`, bare `import "x"`, `export ... from`, and any
// comment or whitespace trivia between the tokens -- because it is the same parser Node uses to
// load the file. It needs --experimental-vm-modules, so it runs in a child process; no runner
// change required.
//
// DYNAMIC `import(...)` and `require(...)` are still pattern-matched, because they are call
// expressions whose argument is only known at runtime and so never appear in dependencySpecifiers.
// This is the remaining, stated limit of the check: a dynamic specifier built from a variable, or
// one written with comment trivia inside the call, is not seen. That floor is accepted rather than
// papered over.
const CALL_FORMS = [
  /\bimport\s*\(\s*["'`]([^"'`$]+)/g,   // await import("...")
  /\brequire\s*\(\s*["'`]([^"'`$]+)/g,  // require("...") in any CommonJS holdout
];

const SHARED_PREFIX = "../../setup/";

// One child process for every file, rather than one per file.
function staticSpecifiersFor(files) {
  const script = `
    const vm = require("node:vm");
    const { readFileSync } = require("node:fs");
    const out = {};
    for (const f of JSON.parse(process.argv[1])) {
      try {
        out[f] = new vm.SourceTextModule(readFileSync(f, "utf8")).dependencySpecifiers;
      } catch (err) {
        out[f] = { __parseError: String(err && err.message || err) };
      }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ["--experimental-vm-modules", "-e", script, JSON.stringify(files)], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // Fail LOUDLY rather than falling back to the weaker regex path. A silent downgrade here would
  // reproduce exactly the class of bug this whole file exists to catch: a check that keeps
  // reporting success while quietly no longer checking the thing it claims to.
  if (r.status !== 0 || !r.stdout) {
    throw new Error(
      `could not parse modules with vm.SourceTextModule (exit ${r.status}): ${r.stderr || "no output"}`,
    );
  }
  return JSON.parse(r.stdout);
}

function callSpecifiersIn(src) {
  const out = [];
  for (const re of CALL_FORMS) for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

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
  const files = walk(join(ROOT, "skills"));
  const statics = staticSpecifiersFor(files);
  assertNoParseErrors(statics);
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const spec of [...(statics[file] || []), ...callSpecifiersIn(src)]) {
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
  const setupFiles = readdirSync(join(ROOT, "setup"))
    .filter((e) => e.endsWith(".mjs"))
    .map((e) => join(ROOT, "setup", e));
  const setupStatics = staticSpecifiersFor(setupFiles);
  assertNoParseErrors(setupStatics);
  for (const e of readdirSync(join(ROOT, "setup"))) {
    if (!e.endsWith(".mjs")) continue;
    const full = join(ROOT, "setup", e);
    const src = readFileSync(full, "utf8");
    for (const spec of [...(setupStatics[full] || []), ...callSpecifiersIn(src)]) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue; // bare package specifier
      if (spec.startsWith("./") || spec.startsWith("../skills/")) continue;
      offenders.push(`${e} -> ${spec}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `shared setup modules reaching outside setup/ and skills/, which breaks the two-directory ` +
      `installed layout:\n${offenders.join("\n")}\n(Static imports come from V8 via ` +
      `vm.SourceTextModule and are complete. Dynamic import() and require() are pattern-matched, ` +
      `so a specifier built from a variable is not seen; see CALL_FORMS.)`,
  );
});
