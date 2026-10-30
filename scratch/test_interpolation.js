// Test linear interpolation for continuous crosshair
function interpolatePoint(ticks, x, Wd, Ht, L, R, T, B, lo, hi, t0, spanT) {
  const plotW = Wd - L - R;
  const clampedX = Math.max(L, Math.min(Wd - R, x));
  const tFrac = (clampedX - L) / plotW;
  const targetT = t0 + tFrac * spanT;

  if (ticks.length === 1) {
    return {
      t: ticks[0].t,
      pnl: ticks[0].pnl,
      spot: ticks[0].spot,
      ptX: clampedX,
      ptY: T + (1 - (ticks[0].pnl - lo) / (hi - lo)) * (Ht - T - B)
    };
  }

  // Find bounding segment [i, i+1]
  let idx = 0;
  for (let i = 0; i < ticks.length - 1; i++) {
    if (targetT >= ticks[i].t && targetT <= ticks[i + 1].t) {
      idx = i;
      break;
    }
    if (targetT > ticks[i + 1].t) {
      idx = i + 1;
    }
  }

  if (idx >= ticks.length - 1) {
    const last = ticks[ticks.length - 1];
    return {
      t: last.t,
      pnl: last.pnl,
      spot: last.spot,
      ptX: clampedX,
      ptY: T + (1 - (last.pnl - lo) / (hi - lo)) * (Ht - T - B)
    };
  }

  const tA = ticks[idx], tB = ticks[idx + 1];
  const segSpan = Math.max(1, tB.t - tA.t);
  const segFrac = Math.max(0, Math.min(1, (targetT - tA.t) / segSpan));

  const interpPnl = tA.pnl + segFrac * (tB.pnl - tA.pnl);
  const interpSpot = (tA.spot != null && tB.spot != null) ? (tA.spot + segFrac * (tB.spot - tA.spot)) : (tA.spot || tB.spot);
  const ptY = T + (1 - (interpPnl - lo) / (hi - lo)) * (Ht - T - B);

  return {
    t: targetT,
    pnl: interpPnl,
    spot: interpSpot,
    ptX: clampedX,
    ptY: ptY
  };
}

const mockTicks = [
  { t: 1000, pnl: 0, spot: 80000 },
  { t: 2000, pnl: 5, spot: 80500 },
  { t: 3000, pnl: -2, spot: 79800 }
];

console.log('At x=55 (start):', interpolatePoint(mockTicks, 55, 880, 180, 55, 20, 16, 28, -5, 10, 1000, 2000));
console.log('At x=455 (middle):', interpolatePoint(mockTicks, 455, 880, 180, 55, 20, 16, 28, -5, 10, 1000, 2000));
console.log('At x=860 (end):', interpolatePoint(mockTicks, 860, 880, 180, 55, 20, 16, 28, -5, 10, 1000, 2000));

