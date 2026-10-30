const fs = require('fs');

let html = fs.readFileSync('frontend/index.html', 'utf8');

// 1. Hairline in Case A
const oldHairA = `'<!-- Continuous SVG Crosshair Hairline -->' +
            '<g id=\"vChartHairG\" style=\"display:none; pointer-events:none;\">' +
              '<line id=\"vHairV\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"' + Ht + '\" stroke=\"rgba(255,255,255,0.6)\" stroke-width=\"1.2\"/>' +
              '<line id=\"vHairH\" x1=\"0\" y1=\"0\" x2=\"' + Wd + '\" y2=\"0\" stroke=\"rgba(255,255,255,0.4)\" stroke-width=\"1\"/>' +
              '<circle id=\"vHairDot\" cx=\"0\" cy=\"0\" r=\"5.5\" fill=\"' + strokeCol + '\" stroke=\"#fff\" stroke-width=\"2\"/>' +
              '<rect id=\"vHairPillY\" x=\"4\" y=\"0\" width=\"48\" height=\"18\" rx=\"4\" fill=\"' + strokeCol + '\"/>' +
              '<text id=\"vHairTxtY\" x=\"28\" y=\"0\" font-size=\"10\" fill=\"#fff\" font-weight=\"700\" text-anchor=\"middle\" dominant-baseline=\"middle\" font-family=\"var(--mono,monospace)\">$0.00</text>' +
              '<rect id=\"vHairPillX\" x=\"0\" y=\"' + (Ht - B + 4) + '\" width=\"56\" height=\"18\" rx=\"4\" fill=\"#222733\" stroke=\"rgba(255,255,255,0.2)\"/>' +
              '<text id=\"vHairTxtX\" x=\"0\" y=\"' + (Ht - B + 13) + '\" font-size=\"9.5\" fill=\"#bbb\" font-weight=\"600\" text-anchor=\"middle\" dominant-baseline=\"middle\" font-family=\"var(--mono,monospace)\">--:--</text>' +
            '</g>' +

            '<!-- Event capture overlay spanning full plot area -->' +
            '<rect id=\"vChartEventsRect\" x=\"0\" y=\"0\" width=\"' + Wd + '\" height=\"' + Ht + '\" fill=\"transparent\" style=\"cursor:crosshair; pointer-events:all;\"/>'`;

const newHairA = `'<!-- Continuous SVG Crosshair Hairline -->' +
            '<g id=\"vChartHairG\" style=\"display:none; pointer-events:none;\">' +
              '<line id=\"vHairV\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"' + Ht + '\" stroke=\"#38bdf8\" stroke-width=\"1.5\" stroke-dasharray=\"3 3\" vector-effect=\"non-scaling-stroke\"/>' +
              '<line id=\"vHairH\" x1=\"0\" y1=\"0\" x2=\"' + Wd + '\" y2=\"0\" stroke=\"rgba(255,255,255,0.75)\" stroke-width=\"1.2\" stroke-dasharray=\"3 3\" vector-effect=\"non-scaling-stroke\"/>' +
              '<circle id=\"vHairDot\" cx=\"0\" cy=\"0\" r=\"6\" fill=\"' + strokeCol + '\" stroke=\"#ffffff\" stroke-width=\"2.5\"/>' +
              '<rect id=\"vHairPillY\" x=\"4\" y=\"0\" width=\"58\" height=\"20\" rx=\"5\" fill=\"' + strokeCol + '\"/>' +
              '<text id=\"vHairTxtY\" x=\"33\" y=\"0\" font-size=\"10.5\" fill=\"#fff\" font-weight=\"800\" text-anchor=\"middle\" dominant-baseline=\"middle\" font-family=\"var(--mono,monospace)\">$0.00</text>' +
              '<rect id=\"vHairPillX\" x=\"0\" y=\"' + (Ht - B + 2) + '\" width=\"70\" height=\"20\" rx=\"5\" fill=\"#18202f\" stroke=\"rgba(255,255,255,0.3)\" stroke-width=\"1\"/>' +
              '<text id=\"vHairTxtX\" x=\"0\" y=\"' + (Ht - B + 12) + '\" font-size=\"10\" fill=\"#38bdf8\" font-weight=\"700\" text-anchor=\"middle\" dominant-baseline=\"middle\" font-family=\"var(--mono,monospace)\">--:--</text>' +
            '</g>' +

            '<!-- Event capture overlay spanning full plot area -->' +
            '<rect id=\"vChartEventsRect\" x=\"0\" y=\"0\" width=\"' + Wd + '\" height=\"' + Ht + '\" fill=\"rgba(0,0,0,0.001)\" style=\"cursor:crosshair; pointer-events:all;\"/>'`;

// 2. Hairline in Case B
const oldHairB = `'<!-- Continuous SVG Crosshair Hairline running uninterrupted from start to end -->' +
            '<g id=\"vChartHairG\" style=\"display:none; pointer-events:none;\">' +
              '<line id=\"vHairV\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"' + Ht + '\" stroke=\"rgba(255,255,255,0.6)\" stroke-width=\"1.2\"/>' +
              '<line id=\"vHairH\" x1=\"0\" y1=\"0\" x2=\"' + Wd + '\" y2=\"0\" stroke=\"rgba(255,255,255,0.4)\" stroke-width=\"1\"/>' +
              '<circle id=\"vHairDot\" cx=\"0\" cy=\"0\" r=\"5.5\" fill=\"' + strokeCol + '\" stroke=\"#fff\" stroke-width=\"2\"/>' +
              '<rect id=\"vHairPillY\" x=\"4\" y=\"0\" width=\"48\" height=\"18\" rx=\"4\" fill=\"' + strokeCol + '\"/>' +
              '<text id=\"vHairTxtY\" x=\"28\" y=\"0\" font-size=\"10\" fill=\"#fff\" font-weight=\"700\" text-anchor=\"middle\" dominant-baseline=\"middle\" font-family=\"var(--mono,monospace)\">$0.00</text>' +
              '<rect id=\"vHairPillX\" x=\"0\" y=\"' + (Ht - B + 4) + '\" width=\"56\" height=\"18\" rx=\"4\" fill=\"#222733\" stroke=\"rgba(255,255,255,0.2)\"/>' +
              '<text id=\"vHairTxtX\" x=\"0\" y=\"' + (Ht - B + 13) + '\" font-size=\"9.5\" fill=\"#bbb\" font-weight=\"600\" text-anchor=\"middle\" dominant-baseline=\"middle\" font-family=\"var(--mono,monospace)\">--:--</text>' +
            '</g>' +

            '<!-- Event capture overlay spanning full plot area -->' +
            '<rect id=\"vChartEventsRect\" x=\"0\" y=\"0\" width=\"' + Wd + '\" height=\"' + Ht + '\" fill=\"transparent\" style=\"cursor:crosshair; pointer-events:all;\"/>'`;

const newHairB = `'<!-- Continuous SVG Crosshair Hairline running uninterrupted from start to end -->' +
            '<g id=\"vChartHairG\" style=\"display:none; pointer-events:none;\">' +
              '<line id=\"vHairV\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"' + Ht + '\" stroke=\"#38bdf8\" stroke-width=\"1.5\" stroke-dasharray=\"3 3\" vector-effect=\"non-scaling-stroke\"/>' +
              '<line id=\"vHairH\" x1=\"0\" y1=\"0\" x2=\"' + Wd + '\" y2=\"0\" stroke=\"rgba(255,255,255,0.75)\" stroke-width=\"1.2\" stroke-dasharray=\"3 3\" vector-effect=\"non-scaling-stroke\"/>' +
              '<circle id=\"vHairDot\" cx=\"0\" cy=\"0\" r=\"6\" fill=\"' + strokeCol + '\" stroke=\"#ffffff\" stroke-width=\"2.5\"/>' +
              '<rect id=\"vHairPillY\" x=\"4\" y=\"0\" width=\"58\" height=\"20\" rx=\"5\" fill=\"' + strokeCol + '\"/>' +
              '<text id=\"vHairTxtY\" x=\"33\" y=\"0\" font-size=\"10.5\" fill=\"#fff\" font-weight=\"800\" text-anchor=\"middle\" dominant-baseline=\"middle\" font-family=\"var(--mono,monospace)\">$0.00</text>' +
              '<rect id=\"vHairPillX\" x=\"0\" y=\"' + (Ht - B + 2) + '\" width=\"70\" height=\"20\" rx=\"5\" fill=\"#18202f\" stroke=\"rgba(255,255,255,0.3)\" stroke-width=\"1\"/>' +
              '<text id=\"vHairTxtX\" x=\"0\" y=\"' + (Ht - B + 12) + '\" font-size=\"10\" fill=\"#38bdf8\" font-weight=\"700\" text-anchor=\"middle\" dominant-baseline=\"middle\" font-family=\"var(--mono,monospace)\">--:--</text>' +
            '</g>' +

            '<!-- Event capture overlay spanning full plot area -->' +
            '<rect id=\"vChartEventsRect\" x=\"0\" y=\"0\" width=\"' + Wd + '\" height=\"' + Ht + '\" fill=\"rgba(0,0,0,0.001)\" style=\"cursor:crosshair; pointer-events:all;\"/>'`;

// 3. attachContinuousCrosshair function
const oldCrosshairFn = `  /** Attach continuous sub-pixel SVG crosshair hairline and tooltip */
  function attachContinuousCrosshair(ticks, Wd, Ht, L, R, T, B, lo, hi, t0, spanT) {
    const wrap = $('vChartWrap');
    const overlay = $('vChartEventsRect');
    const hairG = $('vChartHairG');
    const hairV = $('vHairV');
    const hairH = $('vHairH');
    const hairDot = $('vHairDot');
    const hairPillY = $('vHairPillY');
    const hairTxtY = $('vHairTxtY');
    const hairPillX = $('vHairPillX');
    const hairTxtX = $('vHairTxtX');
    const tip = $('vChartTip');

    if (!wrap || !overlay || !ticks || ticks.length === 0) return;

    const onMove = e => {
      const rect = wrap.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const scaleX = Wd / rect.width;
      const xMouseSvg = (e.clientX - rect.left) * scaleX;
      // Clamp seamlessly across plot area [L, Wd - R]
      const clampedX = Math.max(L, Math.min(Wd - R, xMouseSvg));
      const plotW = Wd - L - R;
      const tFrac = (clampedX - L) / plotW;
      const targetT = t0 + tFrac * spanT;

      // Continuous linear interpolation between adjacent ticks
      let interpPnl = ticks[0].pnl;
      let interpSpot = ticks[0].spot;

      if (ticks.length > 1) {
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
          interpPnl = ticks[ticks.length - 1].pnl;
          interpSpot = ticks[ticks.length - 1].spot;
        } else {
          const tA = ticks[idx], tB = ticks[idx + 1];
          const segSpan = Math.max(1, tB.t - tA.t);
          const segFrac = Math.max(0, Math.min(1, (targetT - tA.t) / segSpan));
          interpPnl = tA.pnl + segFrac * (tB.pnl - tA.pnl);
          interpSpot = (tA.spot != null && tB.spot != null) ? (tA.spot + segFrac * (tB.spot - tA.spot)) : (tA.spot || tB.spot);
        }
      }

      const ptY = T + (1 - (interpPnl - lo) / (hi - lo)) * (Ht - T - B);
      const col = interpPnl > 0.001 ? '#16c784' : (interpPnl < -0.001 ? '#f6465d' : '#888');

      // Uninterrupted hairlines running full chart width & height
      if (hairV) {
        hairV.setAttribute('x1', clampedX.toFixed(1));
        hairV.setAttribute('x2', clampedX.toFixed(1));
        hairV.setAttribute('y1', '0');
        hairV.setAttribute('y2', String(Ht));
      }
      if (hairH) {
        hairH.setAttribute('y1', ptY.toFixed(1));
        hairH.setAttribute('y2', ptY.toFixed(1));
        hairH.setAttribute('x1', '0');
        hairH.setAttribute('x2', String(Wd));
      }
      if (hairDot) {
        hairDot.setAttribute('cx', clampedX.toFixed(1));
        hairDot.setAttribute('cy', ptY.toFixed(1));
        hairDot.setAttribute('fill', col);
      }
      if (hairPillY) {
        hairPillY.setAttribute('y', (ptY - 9).toFixed(1));
        hairPillY.setAttribute('fill', col);
      }
      if (hairTxtY) {
        hairTxtY.setAttribute('y', ptY.toFixed(1));
        hairTxtY.textContent = fmtMoney(interpPnl);
      }
      if (hairPillX) {
        hairPillX.setAttribute('x', Math.max(L, Math.min(Wd - R - 56, clampedX - 28)).toFixed(1));
      }
      if (hairTxtX) {
        hairTxtX.setAttribute('x', Math.max(L + 28, Math.min(Wd - R - 28, clampedX)).toFixed(1));
        hairTxtX.textContent = fmtTime(targetT);
      }
      if (hairG) {
        hairG.style.display = 'inline';
      }

      if (tip) {
        tip.style.display = 'block';
        const tipX = Math.min(rect.width - 150, Math.max(10, (clampedX / scaleX) - 50));
        tip.style.left = tipX + 'px';
        const tipY = Math.max(10, Math.min(rect.height - 75, (ptY / (Ht / rect.height)) - 55));
        tip.style.top = tipY + 'px';

        const sign = interpPnl > 0 ? '+' : '';
        const pctProg = Math.round(tFrac * 100);
        tip.innerHTML =
          '<div>' + fmtDate(targetT) + ' · ' + pctProg + '%</div>' +
          '<div style="font-weight:800;color:' + col + ';">PnL: ' + sign + '$' + interpPnl.toFixed(2) + '</div>' +
          (interpSpot ? '<div style="color:#888;">BTC Spot: $' + Math.round(interpSpot).toLocaleString() + '</div>' : '');
      }
    };

    const onLeave = () => {
      if (hairG) hairG.style.display = 'none';
      if (tip) tip.style.display = 'none';
    };

    overlay.addEventListener('pointermove', onMove, { passive: true });
    overlay.addEventListener('pointerdown', onMove, { passive: true });
    overlay.addEventListener('pointerleave', onLeave);
    wrap.addEventListener('pointerleave', onLeave);
  }`;

const newCrosshairFn = `  /** Attach continuous sub-pixel SVG crosshair hairline and tooltip */
  function attachContinuousCrosshair(ticks, Wd, Ht, L, R, T, B, lo, hi, t0, spanT) {
    const wrap = $('vChartWrap');
    const hairG = $('vChartHairG');
    const hairV = $('vHairV');
    const hairH = $('vHairH');
    const hairDot = $('vHairDot');
    const hairPillY = $('vHairPillY');
    const hairTxtY = $('vHairTxtY');
    const hairPillX = $('vHairPillX');
    const hairTxtX = $('vHairTxtX');
    const tip = $('vChartTip');

    if (!wrap || !ticks || ticks.length === 0) return;

    wrap.style.touchAction = 'none';
    wrap.style.cursor = 'crosshair';

    const getPos = e => {
      const rect = wrap.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      let clientX = e.clientX, clientY = e.clientY;
      if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      }
      return {
        x: clientX - rect.left,
        y: clientY - rect.top,
        w: rect.width,
        h: rect.height
      };
    };

    const onMove = e => {
      const pos = getPos(e);
      if (!pos) return;

      const scaleX = Wd / pos.w;
      const xMouseSvg = pos.x * scaleX;
      // Clamp seamlessly across plot area [L, Wd - R]
      const clampedX = Math.max(L, Math.min(Wd - R, xMouseSvg));
      const plotW = Wd - L - R;
      const tFrac = (clampedX - L) / plotW;
      const targetT = t0 + tFrac * spanT;

      // Continuous linear interpolation between adjacent ticks
      let interpPnl = ticks[0].pnl;
      let interpSpot = ticks[0].spot;

      if (ticks.length > 1) {
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
          interpPnl = ticks[ticks.length - 1].pnl;
          interpSpot = ticks[ticks.length - 1].spot;
        } else {
          const tA = ticks[idx], tB = ticks[idx + 1];
          const segSpan = Math.max(1, tB.t - tA.t);
          const segFrac = Math.max(0, Math.min(1, (targetT - tA.t) / segSpan));
          interpPnl = tA.pnl + segFrac * (tB.pnl - tA.pnl);
          interpSpot = (tA.spot != null && tB.spot != null) ? (tA.spot + segFrac * (tB.spot - tA.spot)) : (tA.spot || tB.spot);
        }
      }

      const ptY = T + (1 - (interpPnl - lo) / (hi - lo)) * (Ht - T - B);
      const isPositive = interpPnl >= 0.0001;
      const col = isPositive ? '#16c784' : '#f6465d';

      // Uninterrupted, high-contrast hairlines
      if (hairV) {
        hairV.setAttribute('x1', clampedX.toFixed(1));
        hairV.setAttribute('x2', clampedX.toFixed(1));
        hairV.setAttribute('y1', '0');
        hairV.setAttribute('y2', String(Ht));
      }
      if (hairH) {
        hairH.setAttribute('y1', ptY.toFixed(1));
        hairH.setAttribute('y2', ptY.toFixed(1));
        hairH.setAttribute('x1', '0');
        hairH.setAttribute('x2', String(Wd));
      }
      if (hairDot) {
        hairDot.setAttribute('cx', clampedX.toFixed(1));
        hairDot.setAttribute('cy', ptY.toFixed(1));
        hairDot.setAttribute('fill', col);
      }
      if (hairPillY) {
        hairPillY.setAttribute('y', (ptY - 10).toFixed(1));
        hairPillY.setAttribute('fill', col);
      }
      if (hairTxtY) {
        hairTxtY.setAttribute('y', ptY.toFixed(1));
        hairTxtY.textContent = fmtMoney(interpPnl);
      }
      if (hairPillX) {
        hairPillX.setAttribute('x', Math.max(L, Math.min(Wd - R - 68, clampedX - 34)).toFixed(1));
      }
      if (hairTxtX) {
        hairTxtX.setAttribute('x', Math.max(L + 34, Math.min(Wd - R - 34, clampedX)).toFixed(1));
        hairTxtX.textContent = fmtTime(targetT);
      }
      if (hairG) {
        hairG.style.display = 'inline';
      }

      if (tip) {
        tip.style.display = 'block';
        const tipX = Math.min(pos.w - 170, Math.max(10, (clampedX / scaleX) - 60));
        tip.style.left = tipX + 'px';
        const tipY = Math.max(8, Math.min(pos.h - 80, (ptY / (Ht / pos.h)) - 60));
        tip.style.top = tipY + 'px';

        const sign = interpPnl > 0 ? '+' : '';
        const pctProg = Math.round(tFrac * 100);
        tip.innerHTML =
          '<div style=\"font-size:11px;color:#94a3b8;margin-bottom:3px;\">' + fmtDate(targetT) + ' · ' + pctProg + '% duration</div>' +
          '<div style=\"font-size:14px;font-weight:800;color:' + col + ';\">Realized PnL: ' + sign + '$' + interpPnl.toFixed(4) + '</div>' +
          (interpSpot ? '<div style=\"font-size:11px;color:#cbd5e1;margin-top:2px;\">BTC Spot: $' + Math.round(interpSpot).toLocaleString() + '</div>' : '');
      }
    };

    const onLeave = () => {
      if (hairG) hairG.style.display = 'none';
      if (tip) tip.style.display = 'none';
    };

    wrap.addEventListener('pointermove', onMove, { passive: true });
    wrap.addEventListener('pointerdown', onMove, { passive: true });
    wrap.addEventListener('pointerenter', onMove, { passive: true });
    wrap.addEventListener('pointerleave', onLeave);
    wrap.addEventListener('touchmove', onMove, { passive: true });
    wrap.addEventListener('touchstart', onMove, { passive: true });
    wrap.addEventListener('touchend', onLeave);
  }`;

// 4. Universal Bottom Navigation Click Interceptor
const oldNavInterceptor = `  // Global click interceptor for P&L navigation
  D.addEventListener('click', e => {
    const b = e.target && e.target.closest && e.target.closest('[data-page=\"pgPnl\"], #nav [data-page=\"pgPnl\"], #tabbar [data-page=\"pgPnl\"], #moreSheet [data-page=\"pgPnl\"]');
    if (b) {
      setTimeout(() => {
        navigateToPnl();
      }, 10);
    }
  }, true);`;

const newNavInterceptor = `  // Universal Navigation & Bottom Tabbar Interceptor (Trade, Flow, Events, More, P&L)
  D.addEventListener('click', e => {
    const b = e.target && e.target.closest && e.target.closest('#tabbar button, #nav button, #moreSheet button');
    if (!b) return;

    // Handle More button toggle cleanly without disturbing page state
    if (b.id === 'moreTab' || b.dataset.page === 'more') {
      e.preventDefault();
      e.stopPropagation();
      const s = $('moreSheet');
      if (s) {
        const willOpen = s.hidden || s.style.display === 'none';
        s.hidden = !willOpen;
        s.style.display = willOpen ? 'flex' : 'none';
      }
      return;
    }

    const targetPage = b.dataset.page;
    if (targetPage && targetPage !== 'more') {
      if (targetPage === 'pgPnl') {
        setTimeout(navigateToPnl, 10);
        return;
      }

      // Switching away from pgPnl to Trade, Flow, Events, etc.
      const pnl = $('pgPnl');
      if (pnl && targetPage !== 'pgPnl') pnl.classList.remove('on');
      const dec = $('pgDecision');
      if (dec && targetPage !== 'pgDecision') dec.classList.remove('on');

      if (W.v80Layout && typeof W.v80Layout.show === 'function') W.v80Layout.show(targetPage);
      if (W.v132 && typeof W.v132.go === 'function') W.v132.go(targetPage);

      D.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === targetPage));
      D.querySelectorAll('#nav button, #tabbar button').forEach(btn => btn.classList.toggle('on', btn.dataset.page === targetPage));
      D.body.dataset.page = targetPage;
      const ms = $('moreSheet');
      if (ms) { ms.hidden = true; ms.style.display = 'none'; }
    }
  }, true);`;

function replaceExact(source, oldStr, newStr, label) {
  // Normalize CRLF to LF for matching
  const srcLf = source.replace(/\\r\\n/g, '\\n');
  const oldLf = oldStr.replace(/\\r\\n/g, '\\n');
  const newLf = newStr.replace(/\\r\\n/g, '\\n');
  if (!srcLf.includes(oldLf)) {
    console.error('FAILED to find match for: ' + label);
    return source;
  }
  console.log('Successfully replaced: ' + label);
  return srcLf.replace(oldLf, newLf);
}

html = replaceExact(html, oldHairA, newHairA, 'Hairline Case A');
html = replaceExact(html, oldHairB, newHairB, 'Hairline Case B');
html = replaceExact(html, oldCrosshairFn, newCrosshairFn, 'attachContinuousCrosshair Function');
html = replaceExact(html, oldNavInterceptor, newNavInterceptor, 'Universal Bottom Nav Interceptor');

fs.writeFileSync('frontend/index.html', html, 'utf8');
console.log('frontend/index.html successfully updated!');

