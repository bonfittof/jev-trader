import { existsSync, readFileSync } from "fs";

const FILE = process.argv[2] ?? "data/test_200MON_clean.jsonl";

const lines = readFileSync(FILE, "utf8").split(String.fromCharCode(10)).filter(Boolean);
const rows = lines.map((line) => JSON.parse(line));

// New sessions persist fills separately because fills can arrive after the block event
// has already been appended to the event log.
const fillFile = FILE.replace(/\/events_([^/]+)\.jsonl$/, "/fills_$1.jsonl");
const persistedFills = existsSync(fillFile)
  ? readFileSync(fillFile, "utf8").split(String.fromCharCode(10)).filter(Boolean).map((line) => JSON.parse(line))
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


const rowByBlock = new Map<number, any>(rows.filter((r) => typeof r.block === "number").map((r) => [r.block, r]));

type FillDiag = {
  side: "buy" | "sell";
  confidence: number;
  spreadBps: number;
  bookImbalance: number;
  ret1: number;
  ret5: number;
  ret20: number;
  ret100: number;
  cvdRatio: number;
  edge10: number | null;
  edge20: number | null;
};

const fillDiagnostics: FillDiag[] = persistedFills.map((fill) => {
  const b = Number(fill.block);
  const row = rowByBlock.get(b);
  const side = fill.side as "buy" | "sell";
  const confidence = Number(row?.decision?.probabilities?.[side] ?? NaN);
  const spreadBps = Number(row?.spreadBps ?? NaN);
  const bookImbalance = Number(row?.bookImbalance ?? NaN);
  const ret1 = Number(row?.returnsBps?.last1 ?? NaN);
  const ret5 = Number(row?.returnsBps?.last5 ?? NaN);
  const ret20 = Number(row?.returnsBps?.last20 ?? NaN);
  const ret100 = Number(row?.returnsBps?.last100 ?? NaN);
  const cvdRatio = Number(row?.trades?.cvdRatio ?? NaN);
  const edgeAt = (h: number) => {
    const future = rowByBlock.get(b + h);
    if (!future || !Number.isFinite(Number(future.mid))) return null;
    const px = Number(fill.price), mid = Number(future.mid), size = Number(fill.size ?? 0);
    return (side === "buy" ? mid - px : px - mid) * size;
  };
  return { side, confidence, spreadBps, bookImbalance, ret1, ret5, ret20, ret100, cvdRatio, edge10: edgeAt(10), edge20: edgeAt(20) };
});

const summarizeDiag = (label: string, xs: FillDiag[]) => {
  const edge = xs.map((x) => x.edge20).filter((x): x is number => x !== null);
  const conf = xs.map((x) => x.confidence).filter(Number.isFinite);
  const spreads = xs.map((x) => x.spreadBps).filter(Number.isFinite);
  const avg = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  const favorable = edge.length ? edge.filter((x) => x > 0).length / edge.length : 0;
  console.log(`${label}: n=${xs.length} edge20=${avg(edge).toFixed(6)} favorable=${(favorable * 100).toFixed(1)}% avgConf=${avg(conf).toFixed(3)} avgSpread=${avg(spreads).toFixed(2)}bps`);
};

const scanFeature = (label: string, value: (x: FillDiag) => number, cuts: number[]) => {
  console.log(`--- ${label} scan (edge20) ---`);
  for (const cut of cuts) {
    for (const [op, test] of [
      [">=", (v: number) => v >= cut],
      ["<=", (v: number) => v <= cut],
    ] as const) {
      const xs = fillDiagnostics.filter((x) => Number.isFinite(value(x)) && test(value(x)));
      if (xs.length < 30) continue;
      summarizeDiag(`${label} ${op} ${cut}`, xs);
    }
  }
};

const scanCombined = () => {
  console.log("--- Candidate pre-fill filters (edge20) ---");
  const candidates: [string, (x: FillDiag) => boolean][] = [
    ["BUY only", x => x.side === "buy"],
    ["SELL only", x => x.side === "sell"],
    ["BUY conf>=.62", x => x.side === "buy" && x.confidence >= 0.62],
    ["SELL conf>=.62", x => x.side === "sell" && x.confidence >= 0.62],
    ["BUY flow>=0", x => x.side === "buy" && x.cvdRatio >= 0],
    ["SELL flow<=0", x => x.side === "sell" && x.cvdRatio <= 0],
    ["BUY ret20>=0", x => x.side === "buy" && x.ret20 >= 0],
    ["SELL ret20<=0", x => x.side === "sell" && x.ret20 <= 0],
    ["BUY flow+ret20", x => x.side === "buy" && x.cvdRatio >= 0 && x.ret20 >= 0],
    ["SELL flow+ret20", x => x.side === "sell" && x.cvdRatio <= 0 && x.ret20 <= 0],
    ["BUY flow+ret20+imb", x => x.side === "buy" && x.cvdRatio >= 0 && x.ret20 >= 0 && x.bookImbalance >= 0],
    ["SELL flow+ret20+imb", x => x.side === "sell" && x.cvdRatio <= 0 && x.ret20 <= 0 && x.bookImbalance <= 0],
  ];
  for (const [label, test] of candidates) {
    const xs = fillDiagnostics.filter(test);
    if (xs.length >= 20) summarizeDiag(label, xs);
  }
};

const confidenceBands = [
  { label: "conf <0.55", lo: 0, hi: 0.55 },
  { label: "conf 0.55-0.62", lo: 0.55, hi: 0.62 },
  { label: "conf 0.62-0.70", lo: 0.62, hi: 0.70 },
  { label: "conf >=0.70", lo: 0.70, hi: Infinity },
];

const horizons = [5, 10, 20, 100];
const adverse = horizons.map((h) => {
  const vals: number[] = [];
  for (const fill of persistedFills) {
    const b = Number(fill.block);
    const future = rowByBlock.get(b + h);
    if (!future || !Number.isFinite(Number(future.mid))) continue;
    const px = Number(fill.price), mid = Number(future.mid);
    const signedMove = fill.side === "buy" ? mid - px : px - mid;
    vals.push(signedMove * Number(fill.size ?? 0));
  }
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const win = vals.length ? vals.filter((v) => v > 0).length / vals.length : 0;
  return { h, n: vals.length, avg, win };
});

let capRows = 0, longRows = 0, shortRows = 0, flatRows = 0;
for (const r of rows) {
  const size = Number(r.position?.size ?? 0);
  const side = r.position?.side;
  if (side === "long") longRows++;
  else if (side === "short") shortRows++;
  else flatRows++;
  if (size >= 999.999) capRows++;
}

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

console.log();
console.log("=== JEV TEST ANALYSIS ===");
console.log("File:", FILE);
console.log("Rows:", rows.length);
console.log("BUY / SELL / HOLD:", buys, "/", sells, "/", holds);
console.log("Fill events:", fillEvents);
console.log("Fill log:", persistedFills.length ? fillFile : "legacy event-only session");
console.log("Filled MON:", fillMon.toFixed(4));
console.log("BUY fills:", buyFills.length, "/", buyFillMon.toFixed(4), "MON @", buyVwap.toFixed(6));
console.log("SELL fills:", sellFills.length, "/", sellFillMon.toFixed(4), "MON @", sellVwap.toFixed(6));
console.log("Fill rate / row:", fillRate.toFixed(3) + "%");
if (fillDiagnostics.length) {
  console.log("--- Fill diagnostics (edge measured 20 blocks after fill) ---");
  summarizeDiag("BUY ", fillDiagnostics.filter((x) => x.side === "buy"));
  summarizeDiag("SELL", fillDiagnostics.filter((x) => x.side === "sell"));
  for (const band of confidenceBands) {
    summarizeDiag(band.label, fillDiagnostics.filter((x) => Number.isFinite(x.confidence) && x.confidence >= band.lo && x.confidence < band.hi));
  }
  scanFeature("confidence", x => x.confidence, [0.55, 0.62, 0.70, 0.80, 0.90]);
  scanFeature("spreadBps", x => x.spreadBps, [4, 5, 6, 7, 8, 10]);
  scanFeature("bookImbalance", x => x.bookImbalance, [-0.50, -0.25, 0, 0.25, 0.50]);
  scanFeature("ret1", x => x.ret1, [-5, -2, 0, 2, 5]);
  scanFeature("ret5", x => x.ret5, [-10, -5, 0, 5, 10]);
  scanFeature("ret20", x => x.ret20, [-20, -10, 0, 10, 20]);
  scanFeature("ret100", x => x.ret100, [-50, -20, 0, 20, 50]);
  scanFeature("cvdRatio", x => x.cvdRatio, [-0.50, -0.25, 0, 0.25, 0.50]);
  scanCombined();
}
console.log("Inventory rows long/short/flat:", longRows, "/", shortRows, "/", flatRows);
console.log("Rows at ~1000 MON cap:", capRows, "/", rows.length, "(" + (rows.length ? (capRows / rows.length * 100).toFixed(2) : "0.00") + "%)");
for (const x of adverse) console.log(`Post-fill edge +${x.h} blocks: n=${x.n} avgUSD/fill=${x.avg.toFixed(6)} favorable=${(x.win * 100).toFixed(1)}%`);
console.log("Duration:", hours.toFixed(4), "hours");
console.log("Realized P&L USD:", realized.toFixed(6));
console.log("Gas:", gasUsd.toFixed(6), "USD /", gasMon.toFixed(6), "MON");
console.log("Min P&L USD:", (Number.isFinite(minPnl) ? minPnl : 0).toFixed(6));
console.log("Max P&L USD:", (Number.isFinite(maxPnl) ? maxPnl : 0).toFixed(6));
console.log("Max drawdown USD:", maxDrawdown.toFixed(6));
console.log("Final NET P&L USD:", finalPnl.toFixed(6));
console.log("Net P&L / fill USD:", pnlPerFill.toFixed(6));
console.log("Net P&L / hour USD:", pnlPerHour.toFixed(6));
console.log("=========================");
console.log();
