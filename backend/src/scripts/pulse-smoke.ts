/**
 * Live smoke check for Strangle Pulse. Read-only: public Delta market data only, no engine, store or database.
 * Resolves the three slots, plans the strangle for each and prints a one-grid dry-run snapshot.
 */
import { randomUUID } from 'node:crypto';
import { fetchChain, fetchPerpQuote, fetchOptionFeeRates, DEFAULT_OPTION_FEES, type FeeRates } from '../services/bot/delta-public.js';
import { resolveSlots, SLOTS, cohortSlotMs, snapshotGridMs } from '../lib/pulse/grid.js';
import { oiBand, planOpen } from '../lib/pulse/cohort.js';
import { buildSnapshot, type PulseCohort } from '../lib/pulse/snapshot.js';

const f = (v: number | null | undefined, d = 4): string => (v === null || v === undefined ? 'null' : v.toFixed(d));

async function main(): Promise<void> {
  const now = Date.now();
  const [chain, perp] = await Promise.all([fetchChain(now), fetchPerpQuote()]);
  console.log(`spot=${f(perp.spot, 2)} perp_bid=${f(perp.bid, 2)} perp_ask=${f(perp.ask, 2)} perp_mark=${f(perp.mark, 2)}`);
  console.log(`expiries=${chain.expiries.slice(0, 5).map((e) => new Date(e).toISOString()).join(', ')}`);

  const slots = resolveSlots(chain.expiries);
  const plans = SLOTS.map((slot) => ({ slot, expiryMs: slots[slot], plan: slots[slot] === undefined ? null : planOpen(chain.options, slots[slot] as number) }));
  const symbols = plans.flatMap((p) => (p.plan?.kind === 'open' ? [p.plan.call.symbol, p.plan.put.symbol] : []));
  const fees = symbols.length > 0 ? await fetchOptionFeeRates(symbols) : new Map<string, FeeRates>();

  let open = 0;
  for (const { slot, expiryMs, plan } of plans) {
    console.log(`\n== slot ${slot} ==`);
    if (expiryMs === undefined || plan === null) {
      console.log('SLOT_MISSING (no expiry resolved)');
      continue;
    }
    console.log(`expiry=${new Date(expiryMs).toISOString()}`);
    if (plan.kind === 'no_valid_strikes') {
      console.log(`NO_VALID_STRIKES missing=${plan.missing.join(',')}`);
      continue;
    }
    open++;
    const { call, put } = plan;
    const cohort: PulseCohort = {
      id: randomUUID(), slot, series_id: randomUUID(), slot_ms: cohortSlotMs(now), expiry_ms: expiryMs,
      status: 'open', opened_at: now, closed_at: null, close_reason: null,
      spot_entry: perp.spot, fut_entry_bid: perp.bid, fut_entry_ask: perp.ask,
      call_symbol: call.symbol, put_symbol: put.symbol, call_strike: call.strike, put_strike: put.strike,
      call_bid: call.bid, put_bid: put.bid, call_mid: (call.bid + call.ask) / 2, put_mid: (put.bid + put.ask) / 2,
      call_delta: call.delta, put_delta: put.delta, call_theta: call.theta ?? null, put_theta: put.theta ?? null,
      call_iv: call.iv, put_iv: put.iv,
      call_gamma: call.gamma ?? null, put_gamma: put.gamma ?? null, call_vega: call.vega ?? null, put_vega: put.vega ?? null,
      call_oi_band: oiBand(chain.options, 'call', expiryMs, call.strike), put_oi_band: oiBand(chain.options, 'put', expiryMs, put.strike),
      fee: fees.get(call.symbol) ?? DEFAULT_OPTION_FEES, missing: null,
      call_sl_at: null, put_sl_at: null, net_pnl: null,
    };
    const snap = buildSnapshot(cohort, chain.options, perp, {}, snapshotGridMs(now), now);
    for (const [name, o] of [['call', call], ['put', put]] as const) {
      const leg = snap.legs[name];
      console.log(`${name}: ${o.symbol} strike=${o.strike} delta=${f(o.delta)} bid=${f(o.bid, 2)} ask=${f(o.ask, 2)} net_pnl=${f(leg.net_pnl)} data_ok=${leg.data_ok}`);
    }
    console.log(`combined_pnl=${f(snap.cohort.combined_pnl)} pnl_pct=${f(snap.cohort.pnl_pct, 2)} data_ok=${snap.cohort.data_ok}`);
  }
  console.log(`\nslots_open=${open}/${SLOTS.length}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('pulse-smoke failed:', e);
    process.exit(1);
  },
);
