#!/usr/bin/env node
// INND daily stock-price history for the CFO records.
// InnerScope Hearing Technologies, Inc. (OTC: INND) - a public company. This pulls
// PUBLIC market data only (published OTC prices) for INTERNAL CFO record-keeping. It
// is not investor-facing publishing or stock promotion (securities firewall safe).
//
// Sources (HYBRID, best-of-both):
//   - Massive (a Polygon.io white-label; same API + flat-files surface). Daily OHLCV
//     with TRUE volume-weighted VWAP (`vw`), per-day TRADE COUNT (`n`), and the OTC
//     consolidated tape. The plan authorizes ~2 years of daily history (true VWAP +
//     trades for the most recent ~24 months and every new day going forward).
//   - Yahoo Finance daily OHLCV + adjusted close for the DEEP history before Massive's
//     2-year window (INND from 2017-03-15). VWAP there is the typical-price proxy
//     (High+Low+Close)/3, clearly labeled per-row in the Source column.
// The two are merged by date; Massive wins on the overlap (true VWAP + trades). If the
// Massive keys are absent or a call fails, the skill degrades gracefully to Yahoo-only.
//
// The canonical workbook lives in the CFO's finance-legal S3 DR mirror (see STORAGE below) so it is
// one file that grows over time. `backfill` builds it from full history; `update` appends any
// new trading days (idempotent) - run `update` daily after the close.
//
// STORAGE (ported to S3, 2026-08-27): this workbook used to live in EITHER Google Cloud Storage (the
// original path) or Azure Blob Storage (the later, funded-credit `STORAGE_BACKEND=azure` default,
// SharedKey-signed directly in this file). GCP Secret Manager billing was intentionally disabled
// fleet-wide (2026-07) and the Azure subscription holding that storage account was permanently
// deleted (2026-08-13) -- both backends are equally dead now, so this file no longer has a "pick one"
// switch at all: it targets ONE place, the S3 DR mirror, via skills/kb-memory/s3-blob.mjs (the same
// dependency-free SigV4 client every other ported skill in this cluster uses). A read-only preflight
// listing confirmed the evacuated workbook is already present at this exact key.
//
// RING NOTE (called out explicitly, not merely inherited): INND market data is public, but this
// workbook is the CFO's internal record-keeping artifact, adjacent to MNPI, and INND is
// securities-firewalled. It belongs in the shared finance-legal S3 bucket (the same one cfo-source-docs
// uses; see s3-blob.mjs's MIRROR table), never in the commons/brain bucket, never brain-federated,
// never web-published. The About-sheet compliance language below (internal CFO record-keeping, not
// stock promotion) is unchanged by the storage swap.
//
// Creds (hydrated): resolved by s3-blob.mjs's awsCreds() (ECS task role -> AWS_ACCESS_KEY_ID/SECRET ->
//   OTC_AWS_ACCESS_KEY_ID/SECRET) -- no new credential path added here.
//   MASSIVE_API_KEY (+ optional MASSIVE_API_KEY_2 for rate-limit failover).
//
// Usage:
//   node innd-stock.mjs backfill         # build the full-history workbook from scratch + upload
//   node innd-stock.mjs update           # fetch recent days, append new ones, re-upload (daily)
//   node innd-stock.mjs status           # show last date + row count in the stored workbook
//   node innd-stock.mjs local <file>     # write the full workbook to a local path (no upload)

import { createRequire } from "node:module";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getBufferFromS3, putObjectToS3 } from "../kb-memory/s3-blob.mjs";
import { publishPriceRail } from "./publish-price-rail.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Lazy-install xlsx if missing (skill is dependency-light otherwise).
function loadXLSX() {
  const require = createRequire(import.meta.url);
  try { return require("xlsx"); }
  catch {
    console.error("installing xlsx ...");
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: HERE, stdio: "ignore" });
    return require("xlsx");
  }
}

const TICKER = "INND";
const COMPANY = "InnerScope Hearing Technologies, Inc.";
const START_EPOCH = 1451606400; // 2016-01-01 (Yahoo returns from the stock's first available day)

// ---- corporate events (splits + press releases), verified, from innd-events.json ----
function loadEvents(){
  try { return JSON.parse(readFileSync(join(HERE, "innd-events.json"), "utf8")); }
  catch { return { splits: [], events: [] }; }
}
const EVENTS = loadEvents();
// Split factor to convert a SPLIT-ADJUSTED price to AS-TRADED (and the inverse for volume).
// For a reverse split (from:2500 -> to:1) effective on `date`, prices BEFORE the effective
// date are back-adjusted x2500 in adjusted feeds; as-traded = adjusted / factor. Volume is
// the inverse: as-traded volume = adjusted volume x factor. factor = product of (from/to)
// for every split whose effective date is AFTER the given trading day.
function splitFactor(date){
  let f = 1;
  for (const s of EVENTS.splits || []) if (s.date > date) f *= (s.from / s.to);
  return f;
}

// ---- storage: the S3 DR mirror (single backend; both GCS and Azure are permanently dead) ----------
// account/container match s3-blob.mjs's verified MIRROR row exactly (otchealthcfodata/innd-stock ->
// otchealth-finance-legal-dr-55c84f6b/otchealthcfodata/innd-stock/); the blob name is unprefixed
// (relative to that mirror's own keyPrefix), confirmed against a real read-only listing that already
// shows the evacuated workbook sitting at this exact key.
const S3_ACCOUNT = "otchealthcfodata";
const S3_CONTAINER = "innd-stock";
const S3_BLOB = "INND-daily-stock-history.xlsx";
const XLSX_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
// STORAGE_BACKEND is no longer a real choice (there is only one backend left), but a stale env value
// left over from the Azure-era job definition (STORAGE_BACKEND=azure) must fail LOUD, not be silently
// ignored -- an operator seeing "it worked" after setting a now-meaningless flag is exactly the kind of
// quiet drift this whole port exists to close. Unset / "s3" both mean "use the only backend there is".
const STORAGE_BACKEND = (process.env.STORAGE_BACKEND || "s3").toLowerCase();
if (STORAGE_BACKEND !== "s3") {
  console.error(`innd-stock: STORAGE_BACKEND=${STORAGE_BACKEND} is no longer supported -- GCS and Azure Blob are both permanently dead (GCP billing retired 2026-07; the Azure subscription was deleted 2026-08-13). The only backend is the S3 DR mirror; unset STORAGE_BACKEND or set it to "s3".`);
  process.exit(2);
}
function storageURI(){ return `s3://${S3_ACCOUNT}/${S3_CONTAINER}/${S3_BLOB}`; }
// getBufferFromS3, NOT getTextFromS3: the workbook is a binary .xlsx, and the text variant would
// decode the body as UTF-8 and silently corrupt it (see s3-blob.mjs's own getBufferFromS3 doc comment,
// which calls this out by name as the reason it exists as a separate export). null ONLY on a genuine
// 404 (no workbook stored yet); throws loud on anything else (a permission failure must never read as
// "no workbook", the exact class of bug this whole cluster of ports exists to close).
async function storageDownload(){ return getBufferFromS3(S3_ACCOUNT, S3_CONTAINER, S3_BLOB); }
async function storageUpload(buf){
  const XLSX = loadXLSX();
  const workbook = XLSX.read(buf, { type: "buffer" });
  const extractedText = workbook.SheetNames.map((name) =>
    `Sheet: ${name}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`
  ).join("\n\n");
  const receipt = await publishPriceRail({ workbook: buf, extractedText, put: putObjectToS3, get: getBufferFromS3 });
  console.log(JSON.stringify({ event: "price_rail_published", ...receipt }));
  return storageURI();
}

// ---- Yahoo Finance daily history ------------------------------------------
async function fetchYahoo(fromEpoch){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${TICKER}?period1=${fromEpoch}&period2=${Math.floor(Date.now()/1000)}&interval=1d&includeAdjustedClose=true`;
  const r = await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"}});
  if(!r.ok) throw new Error("Yahoo "+r.status);
  const j = await r.json();
  const res = j.chart?.result?.[0];
  if(!res) throw new Error("Yahoo: no result "+JSON.stringify(j.chart?.error));
  const ts = res.timestamp||[];
  const q = res.indicators?.quote?.[0]||{};
  const adj = res.indicators?.adjclose?.[0]?.adjclose||[];
  const rows = [];
  for(let i=0;i<ts.length;i++){
    const o=q.open?.[i], h=q.high?.[i], l=q.low?.[i], c=q.close?.[i], v=q.volume?.[i];
    if(o==null||c==null||h==null||l==null) continue; // skip halted/empty days
    const date = new Date(ts[i]*1000).toISOString().slice(0,10);
    // Yahoo's INND series is SPLIT-ADJUSTED (it back-adjusts the whole history for the
    // 2024-08-22 1:2500 split; verified: Yahoo 2024-06-24 close 0.375 / vol 4966 == the
    // adjusted Polygon values). Convert to AS-TRADED so the workbook shows what actually
    // traded: price / factor, volume x factor.
    const f = splitFactor(date);
    rows.push({
      date, open:o/f, high:h/f, low:l/f, close:c/f, volume: (v||0)*f, src:"yahoo",
    });
  }
  rows.sort((a,b)=> a.date<b.date?-1:1);
  return rows;
}

// ---- Massive (Polygon white-label) daily history --------------------------
// True VWAP (vw) + trade count (n) + OTC consolidated tape, ~2-year plan window.
const MASSIVE_HOST = process.env.MASSIVE_HOST || "https://api.massive.com";
function massiveKeys(){
  return [process.env.MASSIVE_API_KEY, process.env.MASSIVE_API_KEY_2].filter(Boolean);
}
async function massiveGET(path){
  const keys = massiveKeys();
  let last;
  for(const k of keys){
    const u = `${MASSIVE_HOST}${path}${path.includes("?")?"&":"?"}apiKey=${k}`;
    const r = await fetch(u);
    const j = await r.json().catch(()=>({}));
    if(r.ok) return j;
    last = { status:r.status, msg:j.message };
    if(r.status!==429) break; // only fail over to the backup key on a rate-limit
  }
  const e = new Error(`Massive ${last?.status}: ${last?.msg}`); e.status=last?.status; throw e;
}
function ymd(d){ return d.toISOString().slice(0,10); }
// Pull INND daily bars for ~`maxDays` back. The plan caps history at ~2 years, so step
// the window down on a NOT_AUTHORIZED (403) until it is accepted. Returns [] (never
// throws) so a Massive outage just falls back to Yahoo.
async function fetchMassiveDaily(maxDays){
  if(massiveKeys().length===0){ console.error("Massive: no API key in env; using Yahoo only"); return []; }
  const today = new Date();
  const windows = [maxDays, 725, 365, 180].filter((v,i,a)=> v && a.indexOf(v)===i);
  for(const days of windows){
    const from = ymd(new Date(Date.now()-days*86400000)), to = ymd(today);
    try{
      // adjusted=false -> AS-TRADED prices, ACTUAL volume, and the true as-traded VWAP (vw)
      // + trade count (n). We keep the whole workbook on the as-traded basis (split handling
      // is explicit via the Split-Adj Close column + the Corporate Actions sheet).
      const j = await massiveGET(`/v2/aggs/ticker/${TICKER}/range/1/day/${from}/${to}?adjusted=false&sort=asc&limit=50000`);
      const rows = (j.results||[]).map(x=>({
        date: new Date(x.t).toISOString().slice(0,10),
        open:x.o, high:x.h, low:x.l, close:x.c, volume:x.v||0,
        vwapTrue: x.vw!=null?x.vw:null, trades: x.n!=null?x.n:null,
        src:"massive",
      }));
      console.error(`Massive: ${rows.length} daily bars ${from}..${to} (as-traded; true VWAP + trade counts)`);
      return rows;
    }catch(e){
      if(e.status===403){ console.error(`Massive: ${days}d window not authorized, stepping down`); continue; }
      console.error(`Massive: ${e.message}; falling back to Yahoo for this window`); return [];
    }
  }
  return [];
}

// ---- merge the two sources by date (Massive wins on overlap) --------------
function mergeByDate(baseRows, overlayRows){
  const map = new Map();
  for(const r of baseRows){ if(!map.has(r.date)) map.set(r.date, r); }
  for(const m of overlayRows){ const prev = map.get(m.date); map.set(m.date, { ...m, event: (prev&&prev.event)||m.event||"" }); }
  return [...map.values()].sort((a,b)=> a.date<b.date?-1:1);
}

// ---- derive computed columns ----------------------------------------------
// All OHLC / Volume / VWAP columns are AS-TRADED (what actually changed hands that day).
// "Split-Adj Close" is the continuous, split-adjusted close (comparable across the
// 2024-08-22 1:2500 reverse split). Daily Change is computed on the Split-Adj Close so the
// split does not show up as a fake ~2500x one-day move.
const HEADERS = ["Date","Open","High","Low","Close","Split-Adj Close","Volume","VWAP","Trades","Daily Change ($)","Daily Change (%)","Dollar Volume (Close x Vol)","Traded Value ($) (Vol x VWAP)","Day Range (H-L)","Press Release / Corporate Event","Source"];
function toRowArray(r, prevAdjClose){
  const isMassive = r.src === "massive";
  // VWAP: true volume-weighted (as-traded) from Massive when available, else the proxy.
  const vwap = (isMassive && r.vwapTrue!=null) ? r.vwapTrue : (r.high + r.low + r.close)/3;
  const trades = (r.trades!=null) ? r.trades : "";
  const splitAdjClose = r.close * splitFactor(r.date);     // continuous comparable series
  const chg = prevAdjClose!=null ? splitAdjClose - prevAdjClose : "";
  const chgPct = (prevAdjClose!=null && prevAdjClose!==0) ? ((splitAdjClose - prevAdjClose)/prevAdjClose)*100 : "";
  const vol = r.volume||0;
  const dollarVol = r.close * vol;          // simple proxy (closing price x shares)
  const tradedValue = vwap * vol;           // the real money traded: shares x VWAP (the avg price each share traded at)
  const source = isMassive
    ? "Massive (Polygon): as-traded, true VWAP + trade count, OTC consolidated"
    : "Yahoo Finance (daily, de-split to as-traded); VWAP = typical-price proxy (H+L+C)/3";
  return [ r.date, r.open, r.high, r.low, r.close, splitAdjClose, vol, vwap, trades, chg, chgPct, dollarVol, tradedValue, r.high - r.low, r.event||"", source ];
}

// ---- attach verified press releases / corporate events to trading days -----
function applyEvents(rows){
  if(!rows.length) return;
  const dates = rows.map(r=>r.date); // ascending
  for(const ev of (EVENTS.events||[])){
    const idx = dates.findIndex(d=> d>=ev.date); // first trading day on or after the event
    if(idx<0) continue;
    const cur = rows[idx].event || "";
    rows[idx].event = cur ? (cur.includes(ev.text) ? cur : cur+" | "+ev.text) : ev.text;
  }
}

// ---- workbook build / merge -----------------------------------------------
function buildWorkbook(XLSX, rows){
  applyEvents(rows);
  const aoa = [HEADERS];
  let prevAdj=null;
  for(const r of rows){ aoa.push(toRowArray(r, prevAdj)); prevAdj = r.close * splitFactor(r.date); }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // column widths (Date,O,H,L,C,SplitAdjC,Vol,VWAP,Trades,Chg$,Chg%,$Vol,TradedValue,Range,PR,Source)
  ws["!cols"] = [{wch:12},{wch:13},{wch:13},{wch:13},{wch:13},{wch:13},{wch:14},{wch:14},{wch:9},{wch:15},{wch:12},{wch:20},{wch:22},{wch:14},{wch:40},{wch:52}];
  // number formats (sub-penny prices need many decimals)
  const priceFmt="0.00000000", volFmt="#,##0", pctFmt="0.00", dollarFmt="#,##0.00";
  const ref = XLSX.utils.decode_range(ws["!ref"]);
  for(let R=1; R<=ref.e.r; R++){
    const set=(C,z)=>{ const a=XLSX.utils.encode_cell({r:R,c:C}); if(ws[a]) ws[a].z=z; };
    [1,2,3,4,5].forEach(C=>set(C,priceFmt));      // OHLC + adjclose
    set(6,volFmt);                                 // volume
    set(7,priceFmt);                               // vwap
    set(8,volFmt);                                 // trades (integer count)
    set(9,priceFmt);                               // change $
    set(10,pctFmt);                                // change %
    set(11,dollarFmt);                             // dollar volume (close x vol)
    set(12,dollarFmt);                             // traded value (vol x vwap)
    set(13,priceFmt);                              // range
  }
  ws["!freeze"] = { xSplit:0, ySplit:1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "INND Daily");
  // About sheet
  const about = [
    ["INND Daily Stock Price History"],
    ["Company", COMPANY+"  (OTC: INND)"],
    ["Purpose", "Internal CFO record-keeping. Public market data only; not investor-facing / not stock promotion."],
    ["Price sources", "Massive (Polygon white-label) for the most recent ~2 years (as-traded prices, true VWAP, actual volume + trade count, OTC consolidated tape); Yahoo Finance for the deep history before that. Merged by date; the Source column on every row says which fed that day."],
    ["History available from", rows.length?rows[0].date:"-"],
    ["Through", rows.length?rows[rows.length-1].date:"-"],
    ["Trading days", String(rows.length)],
    ["Massive (Polygon) coverage", `${rows.filter(r=>r.src==="massive").length} of ${rows.length} days carry TRUE VWAP + trade count (the rest use the Yahoo proxy).`],
    ["PRICE BASIS = AS-TRADED", "Open / High / Low / Close / Volume / VWAP are AS-TRADED: what actually changed hands that day. INND did a 1-for-2500 reverse split on 2024-08-22 (see the Corporate Actions sheet). Yahoo reports a split-adjusted series, so its deep-history values are de-split back to as-traded here (price / 2500, volume x 2500 before 2024-08-22). Source comments document a 2024-06-24 spot check against Polygon; this is not evidence that every historical row or 2021-11-23 was independently verified."],
    ["Split-Adj Close column", "A continuous, split-adjusted close on today's share basis, comparable across the reverse split. Daily Change ($/%) is computed on THIS column, so the 2024-08-22 split is not shown as a fake ~2500x one-day move. The as-traded Close jumps ~2500x on the split date by design (that is what the tape shows)."],
    ["VWAP note", "For Massive (Polygon) rows the VWAP is the TRUE daily volume-weighted average price (as-traded). For the older Yahoo rows it is the typical-price proxy (High+Low+Close)/3. The Source column flags each."],
    ["Trades note", "Trades = the day's number of executed transactions (Massive/Polygon). Blank for the older Yahoo-only history. A useful liquidity gauge for a thinly traded stock (some recent days have under 50 trades)."],
    ["Two dollar-value columns", "Dollar Volume (Close x Vol) = the simple proxy that prices the whole day's shares at the closing price. Traded Value (Vol x VWAP) = the REAL money that changed hands = shares traded x VWAP (the average price each share actually traded at). Both are computed here, not native feed fields, and are basis-invariant. Traded Value is the accurate one (for Massive rows it uses the true VWAP)."],
    ["Press release / events", "The Press Release / Corporate Event column is populated from verified public sources (StockTitan / PR Newswire / company IR / OTC Markets) for major INND milestones; see the Corporate Actions sheet for the full list. Most days have no event (blank)."],
    ["Updated", "Run `innd-stock update` daily after the US market close; it appends only new trading days (idempotent) and refreshes the recent window from Massive."],
    ["Generated (UTC)", new Date().toISOString()],
  ];
  const wsa = XLSX.utils.aoa_to_sheet(about); wsa["!cols"]=[{wch:26},{wch:100}];
  XLSX.utils.book_append_sheet(wb, wsa, "About");

  // Corporate Actions sheet: verified splits + the press-release / event log.
  const ca = [["INND Corporate Actions and Press Releases (verified, public sources)"], [""], ["REVERSE STOCK SPLITS"], ["Effective date","Ratio","Note"]];
  for(const s of (EVENTS.splits||[])) ca.push([s.date, `1-for-${s.from} (${s.from}:${s.to})`, s.note||""]);
  ca.push([""], ["Price-basis math", "As-traded = split-adjusted price / 2500 before 2024-08-22 (=price on/after). Volume is the inverse (x2500 before). Verified: Yahoo 2024-06-24 close 0.375 / vol 4,966 == Polygon adjusted; Polygon raw = 0.0002 / 12,416,430 shares as-traded."], [""], ["PRESS RELEASES / CORPORATE EVENTS"], ["Date","Event"]);
  for(const e of (EVENTS.events||[])) ca.push([e.date, e.text]);
  ca.push([""], ["Note", "Public market data + public company announcements, compiled for INTERNAL CFO records only. Not investor-facing publishing and not stock promotion (securities firewall). INND is not an SEC/EDGAR filer; events sourced from StockTitan / PR Newswire / company IR / OTC Markets."]);
  const wsca = XLSX.utils.aoa_to_sheet(ca); wsca["!cols"]=[{wch:16},{wch:110}];
  XLSX.utils.book_append_sheet(wb, wsca, "Corporate Actions");
  return wb;
}
function sheetToRows(XLSX, wb){
  const ws = wb.Sheets["INND Daily"]; if(!ws) return [];
  const aoa = XLSX.utils.sheet_to_json(ws,{header:1});
  const out=[];
  for(let i=1;i<aoa.length;i++){ const a=aoa[i]; if(!a||!a[0]) continue;
    const source = String(a[15]||"");
    const isMassive = /Massive/i.test(source);
    // Columns are AS-TRADED (col 5 "Split-Adj Close" is derived, not re-read).
    out.push({
      date:String(a[0]).slice(0,10), open:+a[1],high:+a[2],low:+a[3],close:+a[4],volume:+a[6]||0,
      vwapTrue: isMassive && a[7]!=null && a[7]!=="" ? +a[7] : null,
      trades: a[8]!=null && a[8]!=="" ? +a[8] : null,
      event:a[14]||"", src: isMassive ? "massive" : "yahoo",
    });
  }
  return out;
}

// ---- main -----------------------------------------------------------------
const cmd = process.argv[2] || "status";
try {
  const XLSX = loadXLSX();

  if (cmd === "backfill" || cmd === "local") {
    const yahoo = await fetchYahoo(START_EPOCH);            // deep history (2017->)
    const massive = await fetchMassiveDaily(730);           // recent ~2yr: true VWAP + trades
    const rows = mergeByDate(yahoo, massive);               // Massive wins on overlap
    const wb = buildWorkbook(XLSX, rows);
    const buf = XLSX.write(wb, { type:"buffer", bookType:"xlsx" });
    if (cmd === "local") { const f=process.argv[3]||"INND-daily-stock-history.xlsx"; writeFileSync(f, buf); console.log(`wrote ${rows.length} trading days -> ${f} (${rows[0].date}..${rows[rows.length-1].date})`); }
    else { const uri=await storageUpload(buf); console.log(`backfilled ${rows.length} trading days (${rows[0].date}..${rows[rows.length-1].date}) -> ${uri}`); }

  } else if (cmd === "update") {
    const existing = await storageDownload();
    let rows;
    if (!existing) {
      console.error("no existing workbook; running full backfill");
      rows = mergeByDate(await fetchYahoo(START_EPOCH), await fetchMassiveDaily(730));
    } else {
      const wb = XLSX.read(existing, { type:"buffer" });
      const have = sheetToRows(XLSX, wb);
      const haveDates = new Set(have.map(r=>r.date));
      // fill any brand-new Yahoo days (deep-history gaps), then overlay the recent
      // Massive window (true VWAP + trades, refreshes the tail). Massive wins.
      const recentYahoo = await fetchYahoo(Math.floor(Date.now()/1000) - 90*86400);
      const newYahoo = recentYahoo.filter(r=>!haveDates.has(r.date));
      const recentMassive = await fetchMassiveDaily(120);
      rows = mergeByDate(have.concat(newYahoo), recentMassive);
      console.error(`update: +${newYahoo.length} new Yahoo day(s), refreshed ${recentMassive.length} Massive day(s); total ${rows.length}`);
    }
    const wb2 = buildWorkbook(XLSX, rows);
    const buf = XLSX.write(wb2, { type:"buffer", bookType:"xlsx" });
    const uri = await storageUpload(buf);
    console.log(`updated workbook -> ${uri} (through ${rows[rows.length-1].date}, ${rows.length} days)`);

  } else if (cmd === "status") {
    const existing = await storageDownload();
    if (!existing) { console.log("no workbook stored yet; run `backfill`"); }
    else { const wb=XLSX.read(existing,{type:"buffer"}); const rows=sheetToRows(XLSX,wb); console.log(`stored workbook: ${rows.length} trading days, ${rows[0]?.date}..${rows[rows.length-1]?.date} (${storageURI()})`); }

  } else { console.error("commands: backfill | update | status | local <file>"); process.exit(2); }
} catch (e) { console.error("ERROR: "+e.message); process.exit(1); }
