import { existsSync, readFileSync } from "node:fs";

const FILE = process.argv[2] ?? "data/test_200MON_clean.jsonl";
const MAKER_FEE_BPS = Number(process.env.MAKER_FEE_BPS ?? "0");
const CLUSTER_BLOCKS = 600;

const parseJsonl = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x));
const rows = parseJsonl(FILE);
if (!rows.length) throw new Error("Empty event file: " + FILE);
const fillFile = FILE.replace(/\/events_([^/]+)\.jsonl$/, "/fills_$1.jsonl");
const fills = existsSync(fillFile) ? parseJsonl(fillFile) : rows.filter((r) => r.fill).map((r) => ({ ...r.fill, block: r.block }));
const rowByBlock = new Map<number, any>(rows.filter((r) => Number.isFinite(r.block)).map((r) => [Number(r.block), r]));
const ordered = rows.filter((r) => Number.isFinite(r.block) && Number.isFinite(r.mid)).sort((a,b) => a.block-b.block);

const avg = (xs: number[]) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : NaN;
const pct = (x: number) => (100*x).toFixed(1)+"%";
const fmt = (x: number, d=4) => Number.isFinite(x) ? x.toFixed(d) : "n/a";
const nearestAtOrAfter = (target: number) => {
  let lo=0, hi=ordered.length-1, ans:any=null;
  while(lo<=hi){ const m=(lo+hi)>>1; if(ordered[m].block>=target){ans=ordered[m];hi=m-1}else lo=m+1; }
  return ans;
};

// Reconstruct placement rows for legacy dry-runs: simulated ids are -1, -2, ... in quote order.
const placementByOrder = new Map<number, any>();
let simId=0;
for (const r of ordered) {
  if (r.quote?.status === "sim") placementByOrder.set(--simId, r);
  if (Number.isFinite(r.quote?.orderId)) placementByOrder.set(Number(r.quote.orderId), r);
}

type D = {
  side:"buy"|"sell"; block:number; placementBlock:number|null; age:number|null; reason:string;
  confidence:number; spread:number; imbalance:number; ret1:number; ret5:number; ret20:number; ret100:number; cvdRatio:number;
  size:number; price:number; placementMid:number; captureBps:number;
  m5:number|null;m10:number|null;m20:number|null;m100:number|null;
};

let missingPlacement=0, missingFeatures=0;
const diags:D[] = fills.map((fill:any) => {
  const side=fill.side as "buy"|"sell";
  const placement = fill.placementFeatures ? null : placementByOrder.get(Number(fill.orderId));
  const placementBlock = Number.isFinite(fill.placementBlock) ? Number(fill.placementBlock) : Number.isFinite(placement?.block) ? Number(placement.block) : null;
  const features = fill.placementFeatures ?? placement?.features ?? placement;
  if (placementBlock===null) missingPlacement++;
  if (!features) missingFeatures++;
  const probs = fill.placementConfidence ?? placement?.decision?.probabilities?.[side];
  const tr = features?.trades ?? {};
  const buy=Number(tr.buyMon ?? 0), sell=Number(tr.sellMon ?? 0), den=buy+sell;
  const cvdRatio = Number.isFinite(Number(tr.cvdRatio)) ? Number(tr.cvdRatio) : den>0 ? (buy-sell)/den : NaN;
  const placementMid=Number(features?.mid ?? placement?.mid ?? NaN);
  const price=Number(fill.price), size=Number(fill.size ?? 0);
  const captureBps = Number.isFinite(placementMid) && price>0 ? (side==="buy" ? placementMid-price : price-placementMid)/price*1e4 : NaN;
  const mark=(h:number)=>{
    const future=nearestAtOrAfter(Number(fill.block)+h);
    if(!future || !Number.isFinite(price) || price<=0) return null;
    return (side==="buy" ? Number(future.mid)-price : price-Number(future.mid))/price*1e4;
  };
  return {
    side, block:Number(fill.block), placementBlock, age:placementBlock===null?null:Number(fill.block)-placementBlock,
    reason:String(fill.reason ?? (placement && placement.decision?.action===side ? "legacy/unknown" : "legacy/unknown")),
    confidence:Number(probs ?? NaN), spread:Number(features?.spreadBps ?? placement?.spreadBps ?? NaN),
    imbalance:Number(features?.bookImbalance ?? NaN), ret1:Number(features?.returnsBps?.last1 ?? NaN),
    ret5:Number(features?.returnsBps?.last5 ?? NaN), ret20:Number(features?.returnsBps?.last20 ?? NaN),
    ret100:Number(features?.returnsBps?.last100 ?? NaN), cvdRatio, size, price, placementMid, captureBps,
    m5:mark(5),m10:mark(10),m20:mark(20),m100:mark(100)
  };
});

function summary(label:string, xs:D[], key:keyof Pick<D,"m5"|"m10"|"m20"|"m100">="m20"){
  const vals=xs.map(x=>x[key]).filter((x):x is number=>typeof x==="number"&&Number.isFinite(x));
  const cap=xs.map(x=>x.captureBps).filter(Number.isFinite);
  const adverse=xs.map(x=>x.m20!==null&&Number.isFinite(x.captureBps)?x.m20-x.captureBps:null).filter((x):x is number=>x!==null&&Number.isFinite(x));
  console.log(`${label}: n=${xs.length} markout20=${fmt(avg(vals),3)}bps favorable=${vals.length?pct(vals.filter(x=>x>0).length/vals.length):"n/a"} capture=${fmt(avg(cap),3)}bps adverse=${fmt(avg(adverse),3)}bps`);
}

function clusterCI(xs:D[], value:(x:D)=>number|null){
  const buckets=new Map<number,number[]>();
  for(const x of xs){ const v=value(x); if(v===null||!Number.isFinite(v))continue; const k=Math.floor(x.block/CLUSTER_BLOCKS); const a=buckets.get(k)??[];a.push(v);buckets.set(k,a); }
  const means=[...buckets.values()].map(avg).filter(Number.isFinite).sort((a,b)=>a-b);
  if(means.length<5) return {n:means.length,lo:NaN,hi:NaN};
  return {n:means.length,lo:means[Math.floor((means.length-1)*.025)]!,hi:means[Math.ceil((means.length-1)*.975)]!};
}

const firstTs=Number(rows[0]?.ts), lastTs=Number(rows.at(-1)?.ts);
const hours=Number.isFinite(firstTs)&&Number.isFinite(lastTs)&&lastTs>firstTs?(lastTs-firstTs)/3_600_000:NaN;
const last=rows.at(-1)?.totals??{};
const realized=Number(last.realizedUsd??0), markToMid=Number(last.pnlUsd??0), gas=Number(last.gasUsd??0), ai=Number(last.jevUsd??0);
const notional=fills.reduce((s:number,f:any)=>s+Number(f.size??0)*Number(f.price??0),0);
const makerFees=notional*MAKER_FEE_BPS/1e4;
const afterFeeScenario=markToMid-makerFees-ai;

console.log("\n=== JEV MEASUREMENT-RELIABILITY ANALYSIS ===");
console.log("Events:",FILE,"rows=",rows.length);
console.log("Fills:",fills.length, existsSync(fillFile) ? fillFile : "event/legacy");
console.log("Duration hours:",fmt(hours,3));
if(missingPlacement) console.warn("WARNING: placement not reconstructed for",missingPlacement,"fills");
if(missingFeatures) console.warn("WARNING: placement features unavailable for",missingFeatures,"fills; feature scans are not trustworthy for those fills.");
console.log("\n--- Execution decomposition (bps, placement-time features) ---");
summary("ALL",diags); summary("BUY",diags.filter(x=>x.side==="buy")); summary("SELL",diags.filter(x=>x.side==="sell"));
for(const reason of [...new Set(diags.map(x=>x.reason))]) summary("reason="+reason,diags.filter(x=>x.reason===reason));
for(const h of [5,10,20,100] as const){
  const key=("m"+h) as "m5"|"m10"|"m20"|"m100"; const vals=diags.map(x=>x[key]).filter((x):x is number=>x!==null);
  console.log(`markout +${h}: ${fmt(avg(vals),3)}bps n=${vals.length}`);
}
const ci=clusterCI(diags,x=>x.m20);
console.log(`cluster CI (~${CLUSTER_BLOCKS} blocks) markout20: clusters=${ci.n} 2.5%-97.5%=[${fmt(ci.lo,3)}, ${fmt(ci.hi,3)}] bps`);

console.log("\n--- Placement feature checks ---");
const feature=(name:string,get:(x:D)=>number)=>{
  const good=diags.filter(x=>Number.isFinite(get(x))); if(!good.length){console.warn("MISSING FEATURE:",name);return;}
  const sorted=[...good].sort((a,b)=>get(a)-get(b)); const thirds=[sorted.slice(0,Math.floor(sorted.length/3)),sorted.slice(Math.floor(sorted.length/3),Math.floor(2*sorted.length/3)),sorted.slice(Math.floor(2*sorted.length/3))];
  thirds.forEach((g,i)=>summary(`${name} tercile ${i+1}`,g));
};
feature("confidence",x=>x.confidence); feature("spread",x=>x.spread); feature("imbalance",x=>x.imbalance); feature("ret20",x=>x.ret20); feature("cvdRatio",x=>x.cvdRatio);

console.log("\n--- Chronological out-of-sample view ---");
const sorted=[...diags].sort((a,b)=>a.block-b.block), n=sorted.length;
[["train",0,.6],["validation",.6,.8],["test",.8,1]].forEach(([label,a,b])=>summary(String(label),sorted.slice(Math.floor(n*Number(a)),Math.floor(n*Number(b)))));

console.log("\n--- P&L labels (do not confuse these) ---");
console.log("Realized trading P&L USD:",fmt(realized,6));
console.log("Mark-to-mid P&L USD (realized + unrealized - logged gas):",fmt(markToMid,6));
console.log("Logged gas USD:",fmt(gas,6));
console.log("AI cost USD:",fmt(ai,6));
console.log("Maker fee scenario:",MAKER_FEE_BPS,"bps =>",fmt(makerFees,6),"USD");
console.log("Mark-to-mid after maker-fee scenario and AI cost:",fmt(afterFeeScenario,6),"USD");
console.log("BANKROLL_USD is only the denominator used by the bot for pnlPct; it does not create the dollar P&L.");
console.log("================================================\n");
