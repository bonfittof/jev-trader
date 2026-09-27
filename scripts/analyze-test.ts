import { existsSync, readFileSync } from "fs";

const FILE = process.argv[2] ?? "data/test_200MON_clean.jsonl";

const lines = readFileSync(FILE, "utf8").split("\n").filter(Boolean);
const rows = lines.map((line) => JSON.parse(line));

// New sessions persist fills separately because fills can arrive after the block event
// has already been appended to the event log.
const fillFile = FILE.replace(/\/events_([^/]+)\.jsonl$/, "/fills_$1.jsonl");
const persistedFills = existsSync(fillFile)
  ? readFileSync(fillFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];

let buys = 0, sells = 0, holds = 0;
let fillEvents = 0, fillMon = 0;
let minPnl = Infinity, maxPnl = -Infinity, maxDrawdown = 0, peakPnl = -Infinity;
let firstTs: number | null = null, lastTs: number | null = null;

for (const r of rows) {
  const action = r.decision?.action;
  if (action === "buy") buys++;
  if (action === "sell") sells++;
  if (action === "hold") holds++;

  if (r.fill) {
    fillEvents++;
    fillMon += Number(r.fill.size ?? 0);
  }

  if (typeof r.ts === "number") {
    firstTs ??= r.ts;
    lastTs = r.ts;
  }

  // totals.pnlUsd already includes realized + unrealized - gas.
  // Do NOT add realizedUsd again.
  const pnl = Number(r.totals?.pnlUsd ?? 0);
  minPnl = Math.min(minPnl, pnl);
  maxPnl = Math.max(maxPnl, pnl);
  peakPnl = Math.max(peakPnl, pnl);
  maxDrawdown = Math.max(maxDrawdown, peakPnl - pnl);
}

if (persistedFills.length) {
  fillEvents = persistedFills.length;
  fillMon = persistedFills.reduce((sum, f) => sum + Number(f.size ?? 0), 0);
}

const buyFills = persistedFills.filter((f) => f.side === "buy");
const sellFills = persistedFills.filter((f) => f.side === "sell");
const buyFillMon = buyFills.reduce((s, f) => s + Number(f.size ?? 0), 0);
const sellFillMon = sellFills.reduce((s, f) => s + Number(f.size ?? 0), 0);
const buyNotional = buyFills.reduce((s, f) => s + Number(f.size ?? 0) * Number(f.price ?? 0), 0);
const sellNotional = sellFills.reduce((s, f) => s + Number(f.size ?? 0) * Number(f.price ?? 0), 0);
const buyVwap = buyFillMon ? buyNotional / buyFillMon : 0;
const sellVwap = sellFillMon ? sellNotional / sellFillMon : 0;

const last = rows.at(-1);
const totals = last?.totals ?? {};
const finalPnl = Number(totals.pnlUsd ?? 0);
const realized = Number(totals.realizedUsd ?? 0);
const gasUsd = Number(totals.gasUsd ?? 0);
const gasMon = Number(totals.gasMon ?? 0);
const hours = firstTs !== null && lastTs !== null && lastTs > firstTs ? (lastTs - firstTs) / 3_600_000 : 0;
const fillRate = rows.length ? (fillEvents / rows.length) * 100 : 0;
const pnlPerFill = fillEvents ? finalPnl / fillEvents : 0;
const pnlPerHour = hours > 0 ? finalPnl / hours : 0;

console.log("\n=== JEV TEST ANALYSIS ===");
console.log("File:", FILE);
console.log("Rows:", rows.length);
console.log("BUY / SELL / HOLD:", buys, "/", sells, "/", holds);
console.log("Fill events:", fillEvents);
console.log("Fill log:", persistedFills.length ? fillFile : "legacy event-only session");
console.log("Filled MON:", fillMon.toFixed(4));
console.log("BUY fills:", buyFills.length, "/", buyFillMon.toFixed(4), "MON @", buyVwap.toFixed(6));
console.log("SELL fills:", sellFills.length, "/", sellFillMon.toFixed(4), "MON @", sellVwap.toFixed(6));
console.log("Fill rate / row:", fillRate.toFixed(3) + "%");
console.log("Duration:", hours.toFixed(4), "hours");
console.log("Realized P&L USD:", realized.toFixed(6));
console.log("Gas:", gasUsd.toFixed(6), "USD /", gasMon.toFixed(6), "MON");
console.log("Min P&L USD:", (Number.isFinite(minPnl) ? minPnl : 0).toFixed(6));
console.log("Max P&L USD:", (Number.isFinite(maxPnl) ? maxPnl : 0).toFixed(6));
console.log("Max drawdown USD:", maxDrawdown.toFixed(6));
console.log("Final NET P&L USD:", finalPnl.toFixed(6));
console.log("Net P&L / fill USD:", pnlPerFill.toFixed(6));
console.log("Net P&L / hour USD:", pnlPerHour.toFixed(6));
console.log("=========================\n");
