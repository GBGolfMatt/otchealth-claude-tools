import test from "node:test";
import assert from "node:assert/strict";
import {
  STATE_MUTATION_RECEIPTS_FIELD, StateMutationUnknownError, commitStateMutation,
} from "../state-mutation-recovery.mjs";

function base(agent = "cto") {
  return { agent, goal: "", constraints: [], open_decisions: [], last_state: "", updated_at: null, updated_by: null, version: 0 };
}
function store(initial = base()) {
  let state = structuredClone(initial), version = 0, lose = false, failRead = false;
  return {
    get state() { return structuredClone(state); },
    loseNextResponse() { lose = true; },
    failReads() { failRead = true; },
    async read() { if (failRead) throw new Error("synthetic read failure"); return { state: structuredClone(state), etag: String(version) }; },
    async write(candidate, etag) {
      if (etag !== String(version)) return { ok: false, status: 412 };
      state = structuredClone(candidate); version += 1;
      if (lose) { lose = false; throw new Error("synthetic accepted response loss"); }
      return { ok: true, status: 201 };
    },
    externalMutation(mutator, preserveReceipts = true) {
      state = mutator(structuredClone(state));
      if (!preserveReceipts) delete state[STATE_MUTATION_RECEIPTS_FIELD];
      state.version = (state.version || 0) + 1; version += 1;
    },
    externalUnversionedMutation(mutator, preserveReceipts = true) {
      state = mutator(structuredClone(state));
      if (!preserveReceipts) delete state[STATE_MUTATION_RECEIPTS_FIELD];
      version += 1;
    },
  };
}
const setGoal = (goal) => ({ kind: "set", fields: { goal }, updated_by: "cli" });

test("accepted response loss recovers from its immutable receipt without overwriting a later state mutation", async () => {
  const remote = store();
  remote.loseNextResponse();
  let unknown;
  await assert.rejects(
    commitStateMutation({ agent: "cto", operationId: "state-loss-recovery-001", mutation: setGoal("first"), ...remote }),
    (error) => { unknown = error; return error instanceof StateMutationUnknownError && error.durability === "UNKNOWN"; },
  );
  await commitStateMutation({ agent: "cto", operationId: "state-later-write-001", mutation: { kind: "set", fields: { last_state: "later" }, updated_by: "cli" }, ...remote });
  const recovered = await commitStateMutation({ agent: "cto", operationId: "state-loss-recovery-001", mutation: setGoal("first"), receipt: unknown.receipt, ...remote });
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.receipt, remote.state[STATE_MUTATION_RECEIPTS_FIELD][0]);
  assert.equal(recovered.receipt.expected_version, 0);
  assert.equal(recovered.receipt.mutation_hash.length, 64);
  assert.equal(remote.state.goal, "first");
  assert.equal(remote.state.last_state, "later");
  assert.equal(remote.state.version, 2);
});

test("a receipt cannot be reused for a changed mutation intent", async () => {
  const remote = store();
  remote.loseNextResponse();
  let unknown;
  await assert.rejects(
    commitStateMutation({ agent: "cto", operationId: "state-intent-bind-001", mutation: setGoal("original"), ...remote }),
    (error) => { unknown = error; return error instanceof StateMutationUnknownError; },
  );
  await assert.rejects(
    commitStateMutation({ agent: "cto", operationId: "state-intent-bind-001", mutation: setGoal("changed"), receipt: unknown.receipt, ...remote }),
    /does not bind this operation intent/,
  );
  assert.equal(remote.state.goal, "original");
});

test("an unprovable accepted write refuses a replacement when a newer state lacks its receipt", async () => {
  const remote = store();
  remote.loseNextResponse();
  let unknown;
  await assert.rejects(
    commitStateMutation({ agent: "cto", operationId: "state-unproven-001", mutation: setGoal("original"), ...remote }),
    (error) => { unknown = error; return error instanceof StateMutationUnknownError; },
  );
  remote.externalMutation((state) => ({ ...state, last_state: "later writer" }), false);
  await assert.rejects(
    commitStateMutation({ agent: "cto", operationId: "state-unproven-001", mutation: setGoal("original"), receipt: unknown.receipt, ...remote }),
    (error) => error instanceof StateMutationUnknownError && error.durability === "UNKNOWN",
  );
  assert.equal(remote.state.goal, "original");
  assert.equal(remote.state.last_state, "later writer");
  assert.equal(remote.state[STATE_MUTATION_RECEIPTS_FIELD], undefined);
});

test("a recovery read failure remains UNKNOWN and never creates a replacement", async () => {
  const remote = store();
  remote.loseNextResponse();
  let unknown;
  await assert.rejects(
    commitStateMutation({ agent: "cto", operationId: "state-read-unknown-001", mutation: setGoal("original"), ...remote }),
    (error) => { unknown = error; return error instanceof StateMutationUnknownError; },
  );
  remote.failReads();
  await assert.rejects(
    commitStateMutation({ agent: "cto", operationId: "state-read-unknown-001", mutation: setGoal("original"), receipt: unknown.receipt, ...remote }),
    (error) => error instanceof StateMutationUnknownError && error.durability === "UNKNOWN" && error.receipt.operation_id === "state-read-unknown-001",
  );
  assert.equal(remote.state.goal, "original");
  assert.equal(remote.state.version, 1);
});

test("an unchanged embedded version with a changed ETag remains UNKNOWN", async () => {
  const remote = store();
  remote.loseNextResponse();
  let unknown;
  await assert.rejects(
    commitStateMutation({ agent: "cto", operationId: "state-etag-unknown-001", mutation: setGoal("original"), ...remote }),
    (error) => { unknown = error; return error instanceof StateMutationUnknownError; },
  );
  remote.externalUnversionedMutation((state) => ({ ...state, last_state: "writer without version discipline" }), false);
  await assert.rejects(
    commitStateMutation({ agent: "cto", operationId: "state-etag-unknown-001", mutation: setGoal("original"), receipt: unknown.receipt, ...remote }),
    (error) => error instanceof StateMutationUnknownError && error.durability === "UNKNOWN",
  );
  assert.equal(remote.state.last_state, "writer without version discipline");
});

test("a recovery call bounds a noncooperative read and forwards an aborted signal", async () => {
  const remote = store();
  remote.loseNextResponse();
  let unknown;
  await assert.rejects(
    commitStateMutation({ agent: "cto", operationId: "state-deadline-unknown-001", mutation: setGoal("original"), ...remote }),
    (error) => { unknown = error; return error instanceof StateMutationUnknownError; },
  );
  let signal;
  await assert.rejects(
    commitStateMutation({
      agent: "cto", operationId: "state-deadline-unknown-001", mutation: setGoal("original"), receipt: unknown.receipt, deadlineMs: 10,
      read: async (candidateSignal) => { signal = candidateSignal; return new Promise(() => {}); }, write: remote.write,
    }),
    (error) => error instanceof StateMutationUnknownError && error.durability === "UNKNOWN",
  );
  assert.equal(signal.aborted, true);
});

test("a state document for another agent is rejected before any write", async () => {
  const remote = store(base("cfo"));
  await assert.rejects(
    commitStateMutation({ agent: "cto", operationId: "state-agent-bind-001", mutation: setGoal("must not write"), ...remote }),
    /different agent state/,
  );
  assert.equal(remote.state.goal, "");
});

test("the immutable receipt is persisted before a conditional write", async () => {
  const remote = store();
  let persisted = null;
  let writes = 0;
  const result = await commitStateMutation({
    agent: "cto", operationId: "state-prewrite-receipt-001", mutation: setGoal("durable receipt"),
    read: remote.read,
    onReceipt: async (receipt, lifecycle) => {
      assert.deepEqual(lifecycle, { phase: "prepared" });
      persisted = structuredClone(receipt);
    },
    write: async (...args) => {
      writes += 1;
      assert.ok(persisted, "write must not begin before receipt persistence");
      return remote.write(...args);
    },
  });
  assert.equal(writes, 1);
  assert.deepEqual(result.receipt, persisted);
});

test("a failing or timed-out receipt persistence callback prevents every write", async () => {
  for (const onReceipt of [
    async () => { throw new Error("synthetic receipt persistence failure"); },
    async () => new Promise(() => {}),
  ]) {
    const remote = store();
    let writes = 0;
    await assert.rejects(
      commitStateMutation({
        agent: "cto", operationId: "state-receipt-failure-001", mutation: setGoal("must not write"),
        read: remote.read, write: async (...args) => { writes += 1; return remote.write(...args); }, onReceipt, deadlineMs: 10,
      }),
      /receipt persistence failure|deadline exceeded/,
    );
    assert.equal(writes, 0);
    assert.equal(remote.state.goal, "");
  }
});

test("conditional conflicts preserve disjoint fields and retain immutable receipts", async () => {
  const remote = store();
  let firstRead = true;
  const delayedWrite = async (candidate, etag) => {
    if (firstRead) { firstRead = false; await commitStateMutation({ agent: "cto", operationId: "state-disjoint-a-001", mutation: setGoal("goal A"), ...remote }); }
    return remote.write(candidate, etag);
  };
  await commitStateMutation({
    agent: "cto", operationId: "state-disjoint-b-001", mutation: { kind: "set", fields: { last_state: "last B" }, updated_by: "cli" },
    read: remote.read, write: delayedWrite,
  });
  assert.equal(remote.state.goal, "goal A");
  assert.equal(remote.state.last_state, "last B");
  assert.equal(remote.state[STATE_MUTATION_RECEIPTS_FIELD].length, 2);
});

test("same-field conditional conflicts retain both receipts and the later successful mutation", async () => {
  const remote = store();
  let firstWrite = true;
  const delayedWrite = async (candidate, etag) => {
    if (firstWrite) { firstWrite = false; await commitStateMutation({ agent: "cto", operationId: "state-same-a-001", mutation: setGoal("first"), ...remote }); }
    return remote.write(candidate, etag);
  };
  await commitStateMutation({ agent: "cto", operationId: "state-same-b-001", mutation: setGoal("second"), read: remote.read, write: delayedWrite });
  assert.equal(remote.state.goal, "second");
  assert.deepEqual(remote.state[STATE_MUTATION_RECEIPTS_FIELD].map((receipt) => receipt.operation_id).sort(), ["state-same-a-001", "state-same-b-001"]);
});

test("sync preserves state fields, uses its pinned timestamp, and keeps the current fact ordering", async () => {
  const remote = store({ ...base(), goal: "keep", constraints: ["c"], open_decisions: ["d"], session_facts: ["Existing"], version: 3 });
  const result = await commitStateMutation({
    agent: "cto", operationId: "state-sync-immutable-001",
    mutation: { kind: "sync", facts: ["Existing", "First", "Second"], source: "stop", session_id: "session-1", updated_by: "hook:stop" },
    now: () => "2026-09-09T00:00:00.000Z", ...remote,
  });
  assert.equal(result.state.goal, "keep");
  assert.deepEqual(result.state.constraints, ["c"]);
  assert.deepEqual(result.state.open_decisions, ["d"]);
  assert.deepEqual(result.state.session_facts, ["Second", "First", "Existing"]);
  assert.deepEqual(result.state.checkpoint, { as_of: "2026-09-09T00:00:00.000Z", source: "stop", session_id: "session-1" });
});
