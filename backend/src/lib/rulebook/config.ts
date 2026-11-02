/**
 * Rule Book thresholds (section 8). Every number the checklist uses lives here. To change one without touching code, put
 * the same keys in a JSON file and point RULEBOOK_CONFIG_FILE at it; missing keys keep these defaults.
 */
import fs from 'node:fs';

export interface RulebookConfig {
  deltaMin: number;
  deltaMax: number;
  ivRvMin: number;
  adxMax: number;
  spreadMaxPct: number;
  releaseBeforeMin: number;
  releaseAfterMin: number;
  /** Risk per trade, % of equity, on a normal day / a weekend or event week. */
  riskPct: number;
  riskPctSmall: number;
  dailyStopRuleExits: number;
  dailyStopLossPct: number;
  /** Trades at half size after a rule break. */
  halfSizeTrades: number;
  /** Delta Exchange BTC option: 1 lot = 0.001 BTC; premiums are quoted per 1 BTC. */
  contractBtc: number;
  feePerLotUsd: number;
  slippagePct: number;
  /** Block the algo's own entries when the checklist is red. Off until you turn it on. */
  algoBlock: boolean;
}

export const DEFAULT_RULEBOOK_CONFIG: RulebookConfig = {
  deltaMin: 0.10,
  deltaMax: 0.15,
  ivRvMin: 1.3,
  adxMax: 15,
  spreadMaxPct: 10,
  releaseBeforeMin: 60,
  releaseAfterMin: 45,
  riskPct: 1.5,
  riskPctSmall: 0.75,
  dailyStopRuleExits: 2,
  dailyStopLossPct: 3,
  halfSizeTrades: 5,
  contractBtc: 0.001,
  feePerLotUsd: 0.05,
  slippagePct: 10,
  algoBlock: false,
};

function load(): RulebookConfig {
  const file = process.env.RULEBOOK_CONFIG_FILE;
  if (!file) return { ...DEFAULT_RULEBOOK_CONFIG };
  try {
    const over = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RulebookConfig>;
    const out = { ...DEFAULT_RULEBOOK_CONFIG };
    for (const k of Object.keys(out) as (keyof RulebookConfig)[]) {
      const v = over[k];
      if (v !== undefined && typeof v === typeof out[k]) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  } catch (e) {
    console.warn('[rulebook] could not read RULEBOOK_CONFIG_FILE, using defaults:', e instanceof Error ? e.message : e);
    return { ...DEFAULT_RULEBOOK_CONFIG };
  }
}

export const RULEBOOK_CONFIG: RulebookConfig = load();
