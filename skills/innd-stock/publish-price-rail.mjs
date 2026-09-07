import { createHash } from 'node:crypto';

export const PRICE_RAIL_ACCOUNT = 'otchealthcfodata';
export const PRICE_RAIL_CONTAINER = 'innd-stock';
export const PRICE_RAIL_FILE = 'INND-daily-stock-history.xlsx';
export const PRICE_RAIL_MIRROR = `innd-stock/${PRICE_RAIL_FILE}`;
export const PRICE_RAIL_SIDECAR = `_TEXT/${PRICE_RAIL_MIRROR}.txt`;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Publish only the public-price workbook to the existing finance room. No commons,
// personal records, new credentials, or changes to the price calculation are involved.
// Read back every object to prove byte integrity using the job's credentials.
// This does not verify CFO authorization or search visibility; those need CFO acceptance.
export async function publishPriceRail({ workbook, extractedText, put, get }) {
  if (!Buffer.isBuffer(workbook) || workbook.length === 0) throw new Error('price_rail_empty_workbook');
  if (typeof extractedText !== 'string' || !extractedText.trim()) throw new Error('price_rail_empty_text');
  const sha256 = digest(workbook);
  const text = Buffer.from(`Source workbook SHA256: ${sha256}\n\n${extractedText}`, 'utf8');
  const objects = [
    [PRICE_RAIL_CONTAINER, PRICE_RAIL_FILE, workbook, XLSX_TYPE],
    ['cfo-source-docs', PRICE_RAIL_MIRROR, workbook, XLSX_TYPE],
    ['cfo-source-docs', PRICE_RAIL_SIDECAR, text, 'text/plain; charset=utf-8'],
  ];
  for (const [container, name, bytes, contentType] of objects) {
    await put(PRICE_RAIL_ACCOUNT, container, name, bytes, contentType);
    const stored = await get(PRICE_RAIL_ACCOUNT, container, name);
    if (!Buffer.isBuffer(stored) || stored.length !== bytes.length || digest(stored) !== digest(bytes)) {
      throw new Error(`price_rail_verification_failed:${container}/${name}`);
    }
  }
  return { sha256, bytes: workbook.length, dest_path: PRICE_RAIL_MIRROR, sidecar_path: PRICE_RAIL_SIDECAR, sidecar_sha256: digest(text), verified: true };
}
