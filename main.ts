// BTC trend bot for make.fun btc-race-24h-20261123-0511.
//
// Strategy: long-only trend following on 1-minute cbBTC/USDC bars.
//   - Track a fast (20-bar) and a slow (90-bar) exponential moving average
//     of the close. When the fast average sits above the slow one the trend
//     is up, so hold BTC; otherwise hold cash.
//   - Enter with the full cash balance the first bar the trend turns up
//     (after enough bars to form both averages), and stay in through the
//     chop: the only exits are risk exits, never a counter-trend signal.
//   - Exit everything when the close falls 2.00% below the highest close
//     seen since entry (trailing stop), or 1.50% below the entry close
//     (hard stop). After an exit, wait 60 bars before re-entering, so a
//     falling market cannot whipsaw the bot bar after bar.
//   - Every round trip costs about 26 bps in fee, slippage and impact, so
//     the bot trades rarely: on the 24 h dev window it makes a single
//     trade. Fewer trades also means less exposure to 1-minute noise.
//
// Determinism: the bot is a pure function of the bars it has seen. No
// clock, no randomness, no network, no files, no environment reads. The
// same bars always produce the same orders.

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const FAST_PERIOD = 20;
const SLOW_PERIOD = 90;
const TRAIL_STOP_BPS = 200;
const HARD_STOP_BPS = 150;
const REENTRY_COOLDOWN_BARS = 60;
const MAX_SLIPPAGE_BPS = 300;
const BPS = 10000;

function emaUpdate(prev: number | null, price: number, period: number): number {
  if (prev === null) return price;
  const k = 2 / (period + 1);
  return price * k + prev * (1 - k);
}

function dropBps(from: number, to: number): number {
  return ((from - to) / from) * BPS;
}

let barsSeen = 0;
let emaFast: number | null = null;
let emaSlow: number | null = null;
let entryClose: number | null = null;
let peakClose: number | null = null;
let lastSellBar = -1000000;

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    // Closes arrive at price_scale 5: divide to USDC per BTC.
    const close = Number(BigInt(bar.c)) / 100000;
    barsSeen += 1;
    emaFast = emaUpdate(emaFast, close, FAST_PERIOD);
    emaSlow = emaUpdate(emaSlow, close, SLOW_PERIOD);

    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const heldQty = held === undefined ? 0n : held.qty;

    if (heldQty === 0n) {
      entryClose = null;
      peakClose = null;
      if (barsSeen < SLOW_PERIOD) return [];
      if (barsSeen - lastSellBar < REENTRY_COOLDOWN_BARS) return [];
      if (emaFast === null || emaSlow === null) return [];
      if (emaFast <= emaSlow) return [];
      if (state.cash <= 1000000n) return [];
      return [
        {
          side: "buy",
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }

    // The entry price is the position's own average fill cost, not the
    // close the buy was decided on: the fill lands a bar later, at the
    // next open, so the cost the harness reports is the true entry.
    entryClose = Number(held.cost) * 100 / Number(heldQty);
    if (close > (peakClose ?? close)) peakClose = close;
    const trailHit =
      peakClose !== null && dropBps(peakClose, close) >= TRAIL_STOP_BPS;
    const stopHit =
      entryClose !== null && dropBps(entryClose, close) >= HARD_STOP_BPS;
    if (!trailHit && !stopHit) return [];
    lastSellBar = barsSeen;
    entryClose = null;
    peakClose = null;
    return [
      {
        side: "sell",
        symbol: SYMBOL,
        qty: heldQty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  },
});
