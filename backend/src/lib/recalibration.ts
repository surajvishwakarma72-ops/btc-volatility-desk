import { binomialCdfLowerTail } from './stats.js';

export interface SessionRec {
  date: string;
  dow: number;
  speed: number;
  isStop: boolean;
  sizing: number;
  status: string;
}

export interface SeededBaseline {
  tueWedStopRate: number;
  speedStopRate: number;
  comboStopRate: number;
  comboPValue: number;
  oosStopRate: number;
}

export interface RecalOpts {
  minSample: number;
  bonferroniAlpha: number;
  seeded: SeededBaseline;
}

export interface RecalResult {
  source: 'computed' | 'seeded_baseline';
  totalSessions: number;
  inSampleSessions: number;
  outOfSampleSessions: number;
  bonferroniAlpha: number;
  tueWedStopRate: number;
  speedStopRate: number;
  comboStopRate: number;
  comboPValue: number;
  clearedBonferroni: boolean;
  oosStopRate: number;
  oosStabilityVerdict: 'STABLE' | 'DECAYING';
}

const rate = (recs: SessionRec[]) =>
  recs.length ? (recs.filter((r) => r.isStop).length / recs.length) * 100 : 0;

export function computeRecalibration(sessions: SessionRec[], opts: RecalOpts): RecalResult {
  const total = sessions.length;
  const { seeded, bonferroniAlpha } = opts;

  if (total < opts.minSample) {
    return {
      source: 'seeded_baseline',
      totalSessions: total,
      inSampleSessions: Math.floor(total / 2),
      outOfSampleSessions: total - Math.floor(total / 2),
      bonferroniAlpha,
      tueWedStopRate: seeded.tueWedStopRate,
      speedStopRate: seeded.speedStopRate,
      comboStopRate: seeded.comboStopRate,
      comboPValue: seeded.comboPValue,
      clearedBonferroni: seeded.comboPValue < bonferroniAlpha,
      oosStopRate: seeded.oosStopRate,
      oosStabilityVerdict: seeded.oosStopRate <= 35.0 ? 'STABLE' : 'DECAYING',
    };
  }

  const tueWed = sessions.filter((s) => s.dow === 2 || s.dow === 3);
  const calm = sessions.filter((s) => s.speed < 1.5);
  const combo = sessions.filter((s) => (s.dow === 2 || s.dow === 3) && s.speed < 1.5);

  const overallStopRate = rate(sessions) / 100; // p0 null hypothesis
  const comboStops = combo.filter((s) => s.isStop).length;
  const comboPValue = combo.length
    ? binomialCdfLowerTail(comboStops, combo.length, overallStopRate > 0 ? overallStopRate : 0.5)
    : 1;

  const half = Math.floor(total / 2);
  const oos = sessions.slice(half);
  const oosStopRate = rate(oos);

  return {
    source: 'computed',
    totalSessions: total,
    inSampleSessions: half,
    outOfSampleSessions: total - half,
    bonferroniAlpha,
    tueWedStopRate: rate(tueWed),
    speedStopRate: rate(calm),
    comboStopRate: rate(combo),
    comboPValue,
    clearedBonferroni: comboPValue < bonferroniAlpha,
    oosStopRate,
    oosStabilityVerdict: oosStopRate <= 35.0 ? 'STABLE' : 'DECAYING',
  };
}
