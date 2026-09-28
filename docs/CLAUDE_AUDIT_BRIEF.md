# JEV-Trader — Technical Audit Brief for Claude/Codex

## Mission
Act as an independent quantitative developer and code auditor. Do **not** assume the current strategy has an edge and do not optimize toward a requested profit target. First verify that the simulator, fill accounting, P&L, markouts and feature logging are correct; then identify testable hypotheses and validate them out-of-sample.

Do not enable live trading or expose/use private keys. Keep DRY_RUN=true unless the owner explicitly changes that later.

## Repository / runtime
- Repository: bonfittof/jev-trader
- TypeScript + Bun, usually run in GitHub Codespaces from iPad.
- Current market: Kuru MON-USDC on Monad.
- Current concept: post-only market making / spread capture, limit order roughly one tick inside the touch, frequent refresh.
- Nominal trade size: 200 MON.
- Position cap: +/-1000 MON.
- Default horizon: 100 blocks.
- Live wallet/margin checks exist, but current evaluation is dry-run.
- Important source files: src/trader.ts, src/model.ts, src/market.ts, src/book.ts, src/trades.ts, src/config.ts.
- Analyzer: scripts/analyze-test.ts.
- Event and fill JSONL data are generated locally under data/ and may not be committed to GitHub.

## Current objective
Find a repeatable, economically positive edge with controlled drawdown. The longer-term business target discussed by the owner is about EUR 6/hour average over substantial operating time, but **do not fit or tune to that number**. Treat it only as a later economic hurdle after robust validation.

Future roadmap, only after the present engine is audited:
1. MON-USDC remains benchmark.
2. Compare more liquid crypto markets, starting with BTC and likely ETH, using equivalent metrics.
3. Later evaluate EUR/USD; this will require a different market-data/execution adapter.
4. Long-term possibility: multi-market selector that trades only when measured conditions indicate sufficient edge.

## Key current risk logic
src/trader.ts computes prospective exposure including current position + same-side resting orders + new order size and rejects orders beyond maxPositionMon. In live mode it also checks available margin. Fill accounting updates position/cost and realized P&L. Block events contain market state, decisions, quotes/fills/resting orders, position and totals.

## Long dry-run result (important baseline)
Latest meaningful session:
- Duration: 3.6354 hours
- Rows: 43,328
- Fill events: 2,179
- BUY fills: 1,079
- SELL fills: 1,100
- Fill rate / row: 5.029%
- Inventory rows long/short/flat: 21,541 / 21,778 / 9
- Rows near 1000 MON cap: 31 / 43,328 (0.07%)
- Realized P&L: -$5.491600
- Final NET P&L: -$5.489500
- Net P&L/fill: -$0.002519
- Net P&L/hour: -$1.510015
- Max P&L: +$0.046600
- Min P&L: -$5.503300
- Max drawdown: $5.549900
- Gas in dry run: $0, so the result is already negative before realistic live costs.

Post-fill markout:
- +5 blocks: n=2179, avg -$0.001853/fill, favorable 50.6%
- +10: n=2179, avg -$0.001917/fill, favorable 48.6%
- +20: n=2179, avg -$0.002166/fill, favorable 47.6%
- +100: n=2175, avg -$0.002390/fill, favorable 48.5%

Confidence buckets at +20 blocks:
- <0.55: n=1025, edge -$0.003177, favorable 45.2%
- 0.55-0.62: n=116, edge -$0.001716, favorable 48.3%
- 0.62-0.70: n=110, edge -$0.000950, favorable 50.9%
- >=0.70: n=928, edge -$0.001249, favorable 49.8%

BUY: n=1079, edge20 -$0.000890, favorable 50.0%
SELL: n=1100, edge20 -$0.003417, favorable 45.2%

Interpretation so far: the current strategy shows adverse selection / negative expectancy. An earlier ~1.13h sample made high-confidence fills look positive at +20 blocks, but that apparent edge did not persist in the longer session. Do not use the earlier sample as proof of an edge.

## Analyzer status
scripts/analyze-test.ts now computes fill diagnostics and has feature scanners for confidence, spread, book imbalance, returns (1/5/20/100) and CVD ratio, plus combined candidate filters. A bug where scanner functions were defined but never invoked was fixed in commit e4855db. New output still needs to be run against the local long-session data and reviewed.

Recent analyzer repair commits included parser/newline fixes. Please audit the analyzer rather than assuming its metrics are correct.

## Audit priorities
1. Verify dry-run fill simulation is realistic and not using future information.
2. Verify fills cannot be double-counted between event log and separate fill log.
3. Verify realized/unrealized P&L signs, cost basis, inventory transitions and NET P&L.
4. Verify post-fill markout aligns each fill with the intended future market state. Check whether exact block-number lookup creates missing/biased samples and whether block distance is the correct time basis.
5. Verify decision confidence is joined to the correct pre-fill state. Fills may arrive after the block event was written.
6. Verify bookImbalance, returns and CVD fields are actually present in persisted rows; detect NaN/missing features explicitly.
7. Check for look-ahead bias in all proposed filters.
8. Quantify spread captured vs adverse selection separately.
9. Add realistic transaction/gas/slippage assumptions as a separate sensitivity layer; do not hide gross strategy quality behind costs.
10. Avoid overfitting: use chronological train/validation/test or walk-forward validation. Any discovered rule must survive an untouched later sample.

## Desired deliverables
A. Concise audit report: confirmed bugs, suspected biases, and what is trustworthy.
B. Minimal code changes required to make measurement reliable.
C. A reproducible analysis that ranks **hypotheses**, not assets or guaranteed profits: sample count, avg edge/fill, favorable %, confidence interval/uncertainty, P&L impact and stability across time slices.
D. Separate BUY and SELL behavior.
E. Regime analysis: spread, volatility/returns, imbalance, trade flow/CVD, inventory, and time windows.
F. Walk-forward/out-of-sample testing plan.
G. Only after A-F: recommendations for the next dry-run experiment.
H. Architecture note for later BTC/ETH adapters while preserving MON as benchmark; do not implement live trading unless explicitly requested.

## Working rules
- Prefer small, reviewable commits.
- Do not rewrite unrelated code.
- Never read, print, commit, or expose .env/private keys.
- Do not switch DRY_RUN off.
- State uncertainty clearly.
- A strategy with positive in-sample P&L but negative validation P&L is not accepted.
- Do not claim profitability from a short test.
- Preserve raw test data.
