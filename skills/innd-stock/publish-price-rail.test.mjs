import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { publishPriceRail, PRICE_RAIL_MIRROR, PRICE_RAIL_SIDECAR } from './publish-price-rail.mjs';

function fixture() {
  const objects = new Map();
  const writes = [];
  return {
    objects, writes,
    put: async (account, container, path, bytes) => {
      assert.equal(account, 'otchealthcfodata');
      writes.push([container, path]);
      objects.set(`${container}/${path}`, Buffer.from(bytes));
    },
    get: async (_account, container, path) => objects.get(`${container}/${path}`) ?? null,
  };
}

test('writes the same binary workbook and a source-bound sidecar to the CFO reader paths', async () => {
  const f = fixture();
  const workbook = Buffer.from([0x50, 0x4b, 0, 0xff, 0x80, 0x0a]);
  const result = await publishPriceRail({ workbook, extractedText: 'Date,Close\n2026-09-03,1.25\n', ...f });
  assert.equal(result.verified, true);
  assert.equal(result.sha256, createHash('sha256').update(workbook).digest('hex'));
  assert.deepEqual(f.objects.get(`cfo-source-docs/${PRICE_RAIL_MIRROR}`), workbook);
  assert.match(f.objects.get(`cfo-source-docs/${PRICE_RAIL_SIDECAR}`).toString('utf8'), new RegExp(result.sha256));
  assert.deepEqual(f.writes.map(w => w[0]), ['innd-stock', 'cfo-source-docs', 'cfo-source-docs']);
});

test('a missing or same-size corrupted readback fails before publishing a misleading sidecar', async () => {
  for (const corrupt of [null, Buffer.from('BAD!')]) {
    const f = fixture();
    await assert.rejects(publishPriceRail({ workbook: Buffer.from('GOOD'), extractedText: 'synthetic text', ...f, get: async () => corrupt }), /verification_failed/);
    assert.equal(f.writes.length, 1);
  }
});

test('a denied finance mirror write propagates failure instead of reporting the source update as success', async () => {
  const f = fixture();
  await assert.rejects(publishPriceRail({ workbook: Buffer.from('synthetic workbook'), extractedText: 'synthetic text', ...f,
    put: async (...args) => { if (args[1] === 'cfo-source-docs') throw new Error('AccessDenied'); await f.put(...args); },
  }), /AccessDenied/);
  assert.equal(f.objects.has(`cfo-source-docs/${PRICE_RAIL_SIDECAR}`), false);
});

test('empty input fails before any write', async () => {
  const f = fixture();
  await assert.rejects(publishPriceRail({ workbook: Buffer.alloc(0), extractedText: 'text', ...f }), /empty_workbook/);
  await assert.rejects(publishPriceRail({ workbook: Buffer.from('x'), extractedText: ' ', ...f }), /empty_text/);
  assert.equal(f.writes.length, 0);
});

test('retry repairs a missing mirror and stays byte-identical', async () => {
  const f = fixture();
  const args = { workbook: Buffer.from('synthetic workbook'), extractedText: 'synthetic text', ...f };
  const first = await publishPriceRail(args);
  f.objects.delete(`cfo-source-docs/${PRICE_RAIL_MIRROR}`);
  const second = await publishPriceRail(args);
  assert.deepEqual(first, second);
  assert.deepEqual(f.objects.get(`cfo-source-docs/${PRICE_RAIL_MIRROR}`), args.workbook);
});
