// Shared formatting, nice-tick generator, and single-source-of-truth consensus rounding

export function cleanZero(v, decimals = 2) {
  if (!Number.isFinite(v)) return 0;
  const eps = 0.5 * Math.pow(10, -decimals);
  return Math.abs(v) < eps ? 0 : v;
}

export function fmtFixed(v, decimals = 2, signed = false) {
  if (!Number.isFinite(v)) return "—";
  const c = cleanZero(v, decimals);
  return `${signed && c > 0 ? "+" : ""}${c.toFixed(decimals)}`;
}

export function fmtPct(v, decimals = 2, signed = true) {
  if (!Number.isFinite(v)) return "—";
  const c = cleanZero(v, decimals);
  return `${signed && c > 0 ? "+" : ""}${c.toFixed(decimals)}%`;
}

export function fmtMoney(v) {
  if (!Number.isFinite(v)) return "—";
  const c = cleanZero(v, 2);
  return `${c < 0 ? "-$" : "$"}${Math.abs(c).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function smartTruncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || "";
  const cut = str.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace >= Math.floor(maxLen * 0.45) ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

export function niceTicks(minVal, maxVal, targetCount = 5) {
  const span = maxVal - minVal;
  if (!Number.isFinite(span) || span <= 0) return [minVal];
  const rawStep = span / targetCount;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / pow;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = niceNorm * pow;
  const first = Math.ceil(minVal / step) * step;
  const ticks = [];
  for (let v = first; v <= maxVal + step * 0.001; v += step) {
    ticks.push(Number(v.toFixed(6)));
    if (ticks.length > 10) break;
  }
  return ticks.length ? ticks : [minVal, maxVal];
}

// Single source of truth for cross-strategy vote counts & integer percentages summing to 100%
export function computeConsensusSummary(strategies, barIdx) {
  const total = strategies?.length || 0;
  if (!total) return { total: 0, bulls: 0, holds: 0, bears: 0, bullPct: 0, holdPct: 100, bearPct: 0, agreePct: 0 };
  let bulls = 0; let bears = 0; let holds = 0;
  for (const s of strategies) {
    const sc = barIdx >= 0 && s.score ? (s.score[barIdx] ?? 0) : (s.lastScore ?? 0);
    if (sc >= (s.thresholds?.buy ?? 18)) bulls++;
    else if (sc <= (s.thresholds?.sell ?? -18)) bears++;
    else holds++;
  }
  // Largest-remainder rounding guarantees bullPct + holdPct + bearPct === 100 everywhere!
  const raw = [
    { key: "bull", val: (bulls / total) * 100 },
    { key: "hold", val: (holds / total) * 100 },
    { key: "bear", val: (bears / total) * 100 },
  ];
  const floored = raw.map((x) => ({ ...x, int: Math.floor(x.val), rem: x.val - Math.floor(x.val) }));
  let remSum = 100 - floored.reduce((a, x) => a + x.int, 0);
  floored
    .slice()
    .sort((a, b) => b.rem - a.rem)
    .forEach((x) => {
      if (remSum > 0) { x.int++; remSum--; }
    });
  const bullPct = floored.find((x) => x.key === "bull").int;
  const holdPct = floored.find((x) => x.key === "hold").int;
  const bearPct = floored.find((x) => x.key === "bear").int;
  const agreePct = Math.max(bullPct, holdPct, bearPct);
  return { total, bulls, holds, bears, bullPct, holdPct, bearPct, agreePct };
}
