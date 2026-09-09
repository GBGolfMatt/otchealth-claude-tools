import { existsSync, writeFileSync } from "node:fs";

const { advanceOperation, completeOperation, stageOperation } = await import(process.argv[2]);
const home = process.argv[3];
const ready = home + "/initializer-ready";
const release = home + "/initializer-release";
const acquired = home + "/initializer-acquired";
const finish = home + "/initializer-finish";
const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);

try {
  const operation = stageOperation({
    agent: "cto",
    callerLane: "cto",
    targetLane: "cto",
    idempotencyKey: "delayed-initializer-key-001",
    intent: { type: "fact", text: "synthetic delayed initializer" },
    wantsShared: false,
    home,
    _lockTestHooks: {
      afterDirectoryCreated() {
        writeFileSync(ready, "");
        const deadline = Date.now() + 5_000;
        while (!existsSync(release)) {
          if (Date.now() >= deadline) throw new Error("initializer barrier timeout");
          wait();
        }
      },
    },
  });
  writeFileSync(acquired, String(process.pid));
  const deadline = Date.now() + 5_000;
  while (!existsSync(finish)) {
    if (Date.now() >= deadline) throw new Error("initializer finish timeout");
    wait();
  }
  completeOperation(advanceOperation(operation, "private_stored", { private_entry_id: "synthetic" }));
} catch (error) {
  process.stderr.write(String(error.message));
  process.exitCode = 2;
}
