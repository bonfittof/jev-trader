import { readFileSync } from "fs";

const FILE = "data/test_200MON_clean.jsonl";

const lines = readFileSync(FILE, "utf8")
  .split("\n")
  .filter(Boolean);

const rows = lines.map(line => JSON.parse(line));

let minPnl = Infinity;
let maxPnl = -Infinity;
let lastPnl = 0;
let fills = 0;
let buys = 0;
let sells = 0;
let holds = 0;

for (const r of rows) {
  const action = r.decision?.action;

  if (action === "buy") buys++;
  if (action === "sell") sells++;
  if (action === "hold") holds++;

  if (r.fill) fills++;

  const pnl =
    (r.totals?.realizedUsd ?? 0) +
    (r.totals?.pnlUsd ?? 0);

  minPnl = Math.min(minPnl, pnl);
  maxPnl = Math.max(maxPnl, pnl);
  lastPnl = pnl;
}

console.log("\n=== JEV TEST ANALYSIS ===");
console.log("Rows:", rows.length);
console.log("BUY:", buys);
console.log("SELL:", sells);
console.log("HOLD:", holds);
console.log("Fills:", fills);
console.log("Min P&L:", minPnl.toFixed(6));
console.log("Max P&L:", maxPnl.toFixed(6));
console.log("Final P&L:", lastPnl.toFixed(6));
console.log("=========================\n");
