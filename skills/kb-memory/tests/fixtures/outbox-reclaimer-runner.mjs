import { existsSync, writeFileSync } from "node:fs";

const { advanceOperation, completeOperation, stageOperation } = await import(process.argv[2]);
const home = process.argv[3];
const label = process.argv[4];
const ready = home + "/ready-" + label;
const result = home + "/result-" + label + ".json";
const release = home + "/release";
const finish = home + "/finish";
const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);

try {
  const operation = stageOperation({
    agent: "cto",
    callerLane: "cto",
    targetLane: "cto",
    idempotencyKey: "reclaim-race-key-001",
    intent: { type: "fact", text: "synthetic reclaim fixture" },
    wantsShared: false,
    home,
    _lockTestHooks: {
      afterStaleObserved() {
        writeFileSync(ready, "");
        const deadline = Date.now() + 5_000;
        while (!existsSync(release)) {
          if (Date.now() >= deadline) throw new Error("barrier timeout");
          wait();
        }
      },
    },
  });
  writeFileSync(result, JSON.stringify({ status: "acquired", pid: process.pid }));
  const deadline = Date.now() + 5_000;
  while (!existsSync(finish)) {
    if (Date.now() >= deadline) throw new Error("finish timeout");
    wait();
  }
  completeOperation(advanceOperation(operation, "private_stored", { private_entry_id: "synthetic" }));
} catch (error) {
  writeFileSync(result, JSON.stringify({ status: "blocked", reason: String(error.message) }));
}
