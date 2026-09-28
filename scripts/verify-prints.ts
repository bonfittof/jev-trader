import { readFileSync } from "node:fs";
import { rpc } from "../src/chain";
import { TRADE_TOPIC0 } from "../src/trades";
import { config } from "../src/config";

const FILE=process.argv[2];
if(!FILE) throw new Error("Usage: bun run verify-prints data/prints_<session>.jsonl");
const rows=readFileSync(FILE,"utf8").split("\n").filter(Boolean).map(x=>JSON.parse(x));
const ranges=rows.filter(x=>x.kind==="range"&&x.ok);
let checked=0, mismatches=0;
for(const r of ranges){
  const logs=await rpc<any[]>("eth_getLogs",[{
    address:config.market, topics:[TRADE_TOPIC0],
    fromBlock:"0x"+Number(r.from).toString(16), toBlock:"0x"+Number(r.to).toString(16)
  }],config.readRpcUrl);
  checked++;
  if(logs.length!==Number(r.count)){ mismatches++; console.log(`MISMATCH ${r.from}-${r.to}: logged=${r.count} chain=${logs.length}`); }
}
console.log(`verified ranges=${checked} mismatches=${mismatches}`);
if(mismatches) process.exitCode=1;
