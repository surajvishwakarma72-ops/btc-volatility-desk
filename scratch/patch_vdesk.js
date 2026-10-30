const fs = require('fs');

let html = fs.readFileSync('Volatility Desk.html', 'utf8');

// Replace CSS
const oldCss = `#vLivePnlTick .v-chart-wrap {
  position: relative;
  width: 100%;
  height: 190px;
  background: rgba(0,0,0,0.22);
  border-radius: 8px;
  overflow: hidden;
  user-select: none;
}
#vLivePnlTick .v-chart-svg {
  width: 100%;
  height: 100%;
  display: block;
}
#vLivePnlTick .v-chart-wrap .v-tooltip {
  position: absolute;
  pointer-events: none;
  background: #181d27;
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 11px;
  font-family: var(--mono, monospace);
  color: #fff;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  transform: translate(-50%, -115%);
  white-space: nowrap;
  display: none;
  z-index: 25;
}`;

const newCss = `#vLivePnlTick .v-chart-wrap {
  position: relative;
  width: 100%;
  height: 190px;
  background: rgba(0,0,0,0.22);
  border-radius: 8px;
  overflow: hidden;
  user-select: none;
  touch-action: none !important;
  cursor: crosshair !important;
}
#vLivePnlTick .v-chart-svg {
  width: 100%;
  height: 100%;
  display: block;
}
#vLivePnlTick .v-chart-wrap .v-tooltip {
  position: absolute;
  pointer-events: none;
  background: #181d27;
  border: 1px solid rgba(255,255,255,0.25);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 11.5px;
  font-family: var(--mono, monospace);
  color: #fff;
  box-shadow: 0 6px 20px rgba(0,0,0,0.6);
  transform: translate(-50%, -115%);
  white-space: nowrap;
  display: none;
  z-index: 25;
}

/* Bottom bar & page isolation fixes: ensure #tabbar and #moreSheet are always clickable */
html body #tabbar,
html body .tabbar {
  z-index: 9998 !important;
  pointer-events: auto !important;
}
html body #tabbar button,
html body .tabbar button {
  pointer-events: auto !important;
  cursor: pointer !important;
}
html body #moreSheet,
html body .more-sheet {
  z-index: 10000 !important;
  pointer-events: auto !important;
}
#pgPnl {
  padding-bottom: calc(var(--tab-h, 60px) + 50px) !important;
  box-sizing: border-box;
}
@media (max-width: 760px) {
  #askFab {
    bottom: calc(var(--tab-h, 60px) + 16px + env(safe-area-inset-bottom)) !important;
  }
  #vUniversalFloatingPnl {
    bottom: calc(var(--tab-h, 60px) + 16px + env(safe-area-inset-bottom)) !important;
  }
  #daChip {
    bottom: calc(var(--tab-h, 60px) + 16px + env(safe-area-inset-bottom)) !important;
  }
}`;

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

// 3. parseSym
const oldParseSym = `  function parseSym(s) {
    const m = /^([CP])-BTC-(d+(?:.d+)?)-(d{2})(d{2})(d{2})$/i.exec(String(s || ''));
    return m ? { type: m[1].toUpperCase(), K: +m[2], exp: '20' + m[5] + '-' + m[4] + '-' + m[3], rawExp: m[3] + m[4] + m[5] } : null;
  }`;

const newParseSym = `  function parseSym(s) {
    const str = String(s || '').trim();
    const m = /^([CP])-BTC-(\\d+(?:\\.\\d+)?)-(\\d{2})(\\d{2})(\\d{2})$/i.exec(str);
    if (m) {
      return { type: m[1].toUpperCase(), K: +m[2], exp: '20' + m[5] + '-' + m[4] + '-' + m[3], rawExp: m[3] + m[4] + m[5] };
    }
    const m2 = /^(?:([CP])-)?BTC-(?:(\\d{2}[A-Za-z]{3}\\d{2})-)?(\\d+)(?:-([CP]))?$/i.exec(str);
    if (m2) {
      return { type: (m2[1] || m2[4] || '').toUpperCase(), K: +m2[3], exp: m2[2] || 'unknown', rawExp: m2[2] || 'unknown' };
    }
    return null;
  }`;

// 4. getJwt
const oldGetJwt = `  function getJwt() {
    try {
      const v = localStorage.getItem('desk_jwt');
      return v ? (typeof v === 'string' && v.startsWith('"') ? JSON.parse(v) : v) : null;
    } catch {
      return null;
    }
  }`;

const newGetJwt = `  function getJwt() {
    try {
      const v = localStorage.getItem('desk_jwt') || localStorage.getItem('jwt') || localStorage.getItem('token');
      if (!v) return null;
      if (typeof v === 'string' && (v.startsWith('"') || v.startsWith('{'))) {
        try { return JSON.parse(v); } catch { return v; }
      }
      return v;
    } catch {
      return null;
    }
  }`;

// 5. Fallback trade
const oldFallbackTrade = `    // Oct 28 Strangle Real Delta fills
    return {
      id: 'oct28-strangle-dex',
      source: 'delta-fills',
      mode: 'readtrade',
      exp: '2026-10-30',
      pnl: -0.01,
      callPnl: -0.002,
      putPnl: -0.006,
      fee: 0.002,
      Kc: 84000,
      Kp: 78500,
      openedAt: new Date('2026-10-28T05:03:37Z').getTime(),
      closedAt: new Date('2026-10-28T05:06:49Z').getTime(),
      lots: 1
    };`;

const newFallbackTrade = `    // Oct 28-29 Strangle Real Delta fills (User Real Live Trade)
    return {
      id: 'oct28-strangle-dex',
      source: 'delta-fills',
      mode: 'readtrade',
      exp: '2026-10-31',
      pnl: 0.25,
      callPnl: 0.14,
      putPnl: 0.11,
      fee: 0.10,
      Kc: 83600,
      Kp: 78400,
      openedAt: new Date('2026-10-28T19:00:08Z').getTime(),
      closedAt: new Date('2026-10-29T01:30:09Z').getTime(),
      lots: 5
    };`;

function replaceExact(source, oldStr, newStr, label) {
  const srcLf = source.replace(/\\r\\n/g, '\\n');
  const oldLf = oldStr.replace(/\\r\\n/g, '\\n');
  const newLf = newStr.replace(/\\r\\n/g, '\\n');
  if (!srcLf.includes(oldLf)) {
    console.error('FAILED to find match in Volatility Desk.html for: ' + label);
    return source;
  }
  console.log('Successfully replaced in Volatility Desk.html: ' + label);
  return srcLf.replace(oldLf, newLf);
}

html = replaceExact(html, oldCss, newCss, 'CSS');
html = replaceExact(html, oldHairA, newHairA, 'Hairline Case A');
html = replaceExact(html, oldHairB, newHairB, 'Hairline Case B');
html = replaceExact(html, oldParseSym, newParseSym, 'parseSym');
html = replaceExact(html, oldGetJwt, newGetJwt, 'getJwt');
html = replaceExact(html, oldFallbackTrade, newFallbackTrade, 'Fallback Trade');

fs.writeFileSync('Volatility Desk.html', html, 'utf8');
console.log('Volatility Desk.html successfully updated!');

