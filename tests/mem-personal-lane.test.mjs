import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mem = resolve(here, "../skills/kb-memory/mem.mjs");

function blocked(writer, target) {
  return spawnSync(process.execPath, [mem, "entity", "list", "--agent", writer, "--on", target], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, BLOB_BACKEND: "s3" },
  });
}

test("mem CLI rejects cross-lane access into clo-personal before credential or storage resolution", () => {
  const result = blocked("cto", "clo-personal");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cross-lane access involving clo-personal is prohibited/);
  assert.doesNotMatch(result.stderr, /credential|storage account|s3 get/i);
});

test("mem CLI rejects cross-lane access out of clo-personal before credential or storage resolution", () => {
  const result = blocked("clo-personal", "cto");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cross-lane access involving clo-personal is prohibited/);
  assert.doesNotMatch(result.stderr, /credential|storage account|s3 get/i);
});
