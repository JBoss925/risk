// Risk — High-Performance 62-Indicator Quantitative WebAssembly Engine (AssemblyScript)
// Zero runtime dependencies. Flat Struct-of-Arrays Float64 linear memory layout.

let N: i32 = 0;

let bufOpen = new Float64Array(0);
let bufHigh = new Float64Array(0);
let bufLow = new Float64Array(0);
let bufClose = new Float64Array(0);
let bufVolume = new Float64Array(0);

let bufAtrBase = new Float64Array(0);
let bufTmpA = new Float64Array(0);
let bufTmpB = new Float64Array(0);
let bufTmpC = new Float64Array(0);
let bufTmpD = new Float64Array(0);

// Indicator output slots (up to 4 plotted lines + 1 normalized signal strength [-1, +1])
let bufOut0 = new Float64Array(0);
let bufOut1 = new Float64Array(0);
let bufOut2 = new Float64Array(0);
let bufOut3 = new Float64Array(0);
let bufSig = new Float64Array(0);

// Composite strategy accumulator buffers
let bufCompNum = new Float64Array(0);
let bufCompDen = new Float64Array(0);
let bufVetoBull = new Float64Array(0);
let bufVetoBear = new Float64Array(0);
let bufScore = new Float64Array(0);

// Backtest buffers
let bufEquity = new Float64Array(0);
let bufBhEquity = new Float64Array(0);
let bufDrawdown = new Float64Array(0);
// 0..11 = Full-sample, 12..15 = Held-out 30% OOS, 16..19 = 70% Train In-Sample (used for honest ranking!)
let bufMetrics = new Float64Array(20);
const MAX_TRADES: i32 = 4096;
const TRADE_STRIDE: i32 = 8;
let bufTrades = new Float64Array(MAX_TRADES * TRADE_STRIDE);
let lastTradeCount: i32 = 0;

// Sweep buffer: up to 32x32 grid * 4 metrics [sharpe, totalReturnPct, maxDDPct, numTrades]
let bufSweep = new Float64Array(32 * 32 * 4);

// Monte Carlo buffer
let bufMc = new Float64Array(512 * 5 + 8);
let lastMcSteps: i32 = 0;

// Forecast buffers
let bufForecast = new Float64Array(64 * 5);
let bufForecastMeta = new Float64Array(24);
let bufFrozenPUp = new Float64Array(0);

// ---- Math helpers ----
@inline
function clamp(v: f64, lo: f64, hi: f64): f64 {
  return v < lo ? lo : v > hi ? hi : v;
}

@inline
function safeTanh(x: f64): f64 {
  if (x > 18.0) return 1.0;
  if (x < -18.0) return -1.0;
  const e2 = Math.exp(2.0 * x);
  return (e2 - 1.0) / (e2 + 1.0);
}

@inline
function sigmoid(x: f64): f64 {
  if (x > 20.0) return 1.0;
  if (x < -20.0) return 0.0;
  return 1.0 / (1.0 + Math.exp(-x));
}

function clearOutputs(): void {
  for (let i = 0; i < N; i++) {
    unchecked((bufOut0[i] = NaN));
    unchecked((bufOut1[i] = NaN));
    unchecked((bufOut2[i] = NaN));
    unchecked((bufOut3[i] = NaN));
    unchecked((bufSig[i] = 0.0));
  }
}

// ---- Lifecycle & Memory Pointers ----
export function initBars(n: i32): i32 {
  N = n > 0 ? n : 0;
  bufOpen = new Float64Array(N);
  bufHigh = new Float64Array(N);
  bufLow = new Float64Array(N);
  bufClose = new Float64Array(N);
  bufVolume = new Float64Array(N);
  bufAtrBase = new Float64Array(N);
  bufTmpA = new Float64Array(N);
  bufTmpB = new Float64Array(N);
  bufTmpC = new Float64Array(N);
  bufTmpD = new Float64Array(N);
  bufOut0 = new Float64Array(N);
  bufOut1 = new Float64Array(N);
  bufOut2 = new Float64Array(N);
  bufOut3 = new Float64Array(N);
  bufSig = new Float64Array(N);
  bufCompNum = new Float64Array(N);
  bufCompDen = new Float64Array(N);
  bufVetoBull = new Float64Array(N);
  bufVetoBear = new Float64Array(N);
  bufScore = new Float64Array(N);
  bufEquity = new Float64Array(N);
  bufBhEquity = new Float64Array(N);
  bufDrawdown = new Float64Array(N);
  bufFrozenPUp = new Float64Array(N);
  return N;
}

export function getOpenPtr(): usize { return bufOpen.dataStart; }
export function getHighPtr(): usize { return bufHigh.dataStart; }
export function getLowPtr(): usize { return bufLow.dataStart; }
export function getClosePtr(): usize { return bufClose.dataStart; }
export function getVolumePtr(): usize { return bufVolume.dataStart; }

export function getOut0Ptr(): usize { return bufOut0.dataStart; }
export function getOut1Ptr(): usize { return bufOut1.dataStart; }
export function getOut2Ptr(): usize { return bufOut2.dataStart; }
export function getOut3Ptr(): usize { return bufOut3.dataStart; }
export function getSigPtr(): usize { return bufSig.dataStart; }
export function getScorePtr(): usize { return bufScore.dataStart; }

export function getEquityPtr(): usize { return bufEquity.dataStart; }
export function getBhEquityPtr(): usize { return bufBhEquity.dataStart; }
export function getDrawdownPtr(): usize { return bufDrawdown.dataStart; }
export function getMetricsPtr(): usize { return bufMetrics.dataStart; }
export function getTradesPtr(): usize { return bufTrades.dataStart; }
export function getTradeCount(): i32 { return lastTradeCount; }

export function getSweepPtr(): usize { return bufSweep.dataStart; }
export function getMcPtr(): usize { return bufMc.dataStart; }
export function getMcSteps(): i32 { return lastMcSteps; }
export function getForecastPtr(): usize { return bufForecast.dataStart; }
export function getForecastMetaPtr(): usize { return bufForecastMeta.dataStart; }
export function getFrozenPUpPtr(): usize { return bufFrozenPUp.dataStart; }

// ---- Core Series Primitives ----
function computeATRInto(period: i32, dst: Float64Array): void {
  const p = period < 1 ? 1 : period;
  if (N == 0) return;
  let trSum: f64 = 0.0;
  let prevAtr: f64 = 0.0;
  for (let i = 0; i < N; i++) {
    const h = unchecked(bufHigh[i]);
    const l = unchecked(bufLow[i]);
    let tr = h - l;
    if (i > 0) {
      const pc = unchecked(bufClose[i - 1]);
      const d1 = Math.abs(h - pc);
      const d2 = Math.abs(l - pc);
      if (d1 > tr) tr = d1;
      if (d2 > tr) tr = d2;
    }
    if (i < p) {
      trSum += tr;
      prevAtr = trSum / <f64>(i + 1);
      unchecked((dst[i] = prevAtr));
    } else {
      prevAtr = (prevAtr * <f64>(p - 1) + tr) / <f64>p;
      unchecked((dst[i] = prevAtr));
    }
  }
}

export function prepareBaseSeries(): void {
  computeATRInto(14, bufAtrBase);
}

function computeSMAInto(src: Float64Array, period: i32, dst: Float64Array): void {
  const p = period < 1 ? 1 : period;
  let sum: f64 = 0.0;
  let validCount: i32 = 0;
  for (let i = 0; i < N; i++) {
    const v = unchecked(src[i]);
    if (isNaN(v)) {
      sum = 0.0;
      validCount = 0;
      unchecked((dst[i] = NaN));
      continue;
    }
    sum += v;
    validCount++;
    if (validCount > p) {
      sum -= unchecked(src[i - p]);
      validCount = p;
    }
    unchecked((dst[i] = validCount == p ? sum / <f64>p : NaN));
  }
}

function computeEMAInto(src: Float64Array, period: i32, dst: Float64Array): void {
  const p = period < 1 ? 1 : period;
  const k = 2.0 / (<f64>p + 1.0);
  let sum: f64 = 0.0;
  let ema: f64 = 0.0;
  let cnt: i32 = 0;
  for (let i = 0; i < N; i++) {
    const v = unchecked(src[i]);
    if (isNaN(v)) {
      unchecked((dst[i] = NaN));
      continue;
    }
    cnt++;
    if (cnt < p) {
      sum += v;
      unchecked((dst[i] = NaN));
    } else if (cnt == p) {
      sum += v;
      ema = sum / <f64>p;
      unchecked((dst[i] = ema));
    } else {
      ema = (v - ema) * k + ema;
      unchecked((dst[i] = ema));
    }
  }
}

function computeWMAInto(src: Float64Array, period: i32, dst: Float64Array): void {
  const p = period < 1 ? 1 : period;
  const denom = <f64>(p * (p + 1)) * 0.5;
  for (let i = 0; i < N; i++) {
    if (i < p - 1) {
      unchecked((dst[i] = NaN));
    } else {
      let acc: f64 = 0.0;
      let valid = true;
      for (let j = 0; j < p; j++) {
        const val = unchecked(src[i - p + 1 + j]);
        if (isNaN(val)) {
          valid = false;
          break;
        }
        acc += val * <f64>(j + 1);
      }
      unchecked((dst[i] = valid ? acc / denom : NaN));
    }
  }
}

function computeRSIInto(period: i32, dst: Float64Array): void {
  const p = max<i32>(2, period);
  let avgGain: f64 = 0.0;
  let avgLoss: f64 = 0.0;
  unchecked((dst[0] = NaN));
  for (let i = 1; i < N; i++) {
    const ch = unchecked(bufClose[i]) - unchecked(bufClose[i - 1]);
    const gain = ch > 0.0 ? ch : 0.0;
    const loss = ch < 0.0 ? -ch : 0.0;
    if (i <= p) {
      avgGain += gain;
      avgLoss += loss;
      if (i == p) {
        avgGain /= <f64>p;
        avgLoss /= <f64>p;
        unchecked((dst[i] = avgLoss == 0.0 ? 100.0 : 100.0 - 100.0 / (1.0 + avgGain / avgLoss)));
      } else {
        unchecked((dst[i] = NaN));
      }
    } else {
      avgGain = (avgGain * <f64>(p - 1) + gain) / <f64>p;
      avgLoss = (avgLoss * <f64>(p - 1) + loss) / <f64>p;
      unchecked((dst[i] = avgLoss == 0.0 ? 100.0 : 100.0 - 100.0 / (1.0 + avgGain / avgLoss)));
    }
  }
}

@inline
function atrScale(i: i32): f64 {
  const a = unchecked(bufAtrBase[i]);
  const c = unchecked(bufClose[i]);
  const floor = Math.abs(c) * 0.002 + 1e-8;
  return a > floor ? a : floor;
}

@inline
function maSignal(i: i32, ma: f64, prevMa: f64, distMult: f64, slopeMult: f64): f64 {
  if (isNaN(ma) || isNaN(prevMa)) return 0.0;
  const a = atrScale(i);
  const dist = (unchecked(bufClose[i]) - ma) / (a * distMult);
  const slope = (ma - prevMa) / (a * slopeMult);
  return safeTanh(dist * 0.65 + slope * 0.35);
}

// ============================================================================
// 62 TECHNICAL INDICATORS + NORMALIZED SIGNAL STRENGTH [-1.0 .. +1.0]
// ============================================================================
export function computeIndicator(
  id: i32,
  p1: f64,
  p2: f64,
  p3: f64,
  p4: f64,
  invert: i32
): i32 {
  clearOutputs();
  if (N == 0) return 0;

  let lines: i32 = 1;

  // ===================== TREND (0..15) =====================

  // 0: SMA
  if (id == 0) {
    const period = max<i32>(2, <i32>Math.round(p1));
    computeSMAInto(bufClose, period, bufOut0);
    for (let i = period; i < N; i++) {
      unchecked((bufSig[i] = maSignal(i, unchecked(bufOut0[i]), unchecked(bufOut0[i - 1]), 2.0, 0.35)));
    }
    lines = 1;
  }

  // 1: EMA Cross (Fast / Slow)
  else if (id == 1) {
    const fast = max<i32>(2, <i32>Math.round(p1));
    const slow = max<i32>(fast + 1, <i32>Math.round(p2));
    computeEMAInto(bufClose, fast, bufOut0);
    computeEMAInto(bufClose, slow, bufOut1);
    for (let i = slow; i < N; i++) {
      const ef = unchecked(bufOut0[i]);
      const es = unchecked(bufOut1[i]);
      const pef = unchecked(bufOut0[i - 1]);
      const pes = unchecked(bufOut1[i - 1]);
      if (isNaN(ef) || isNaN(es) || isNaN(pef) || isNaN(pes)) continue;
      const a = atrScale(i);
      const spread = (ef - es) / (a * 1.4);
      const delta = ((ef - es) - (pef - pes)) / (a * 0.45);
      unchecked((bufSig[i] = safeTanh(spread * 0.78 + delta * 0.22)));
    }
    lines = 2;
  }

  // 2: WMA
  else if (id == 2) {
    const period = max<i32>(2, <i32>Math.round(p1));
    computeWMAInto(bufClose, period, bufOut0);
    for (let i = period; i < N; i++) {
      unchecked((bufSig[i] = maSignal(i, unchecked(bufOut0[i]), unchecked(bufOut0[i - 1]), 1.8, 0.35)));
    }
    lines = 1;
  }

  // 3: HMA (Hull Moving Average)
  else if (id == 3) {
    const period = max<i32>(4, <i32>Math.round(p1));
    const half = max<i32>(2, period >> 1);
    const sq = max<i32>(2, <i32>Math.round(Math.sqrt(<f64>period)));
    computeWMAInto(bufClose, half, bufTmpA);
    computeWMAInto(bufClose, period, bufTmpB);
    for (let i = 0; i < N; i++) {
      const a = unchecked(bufTmpA[i]);
      const b = unchecked(bufTmpB[i]);
      unchecked((bufTmpA[i] = isNaN(a) || isNaN(b) ? NaN : 2.0 * a - b));
    }
    computeWMAInto(bufTmpA, sq, bufOut0);
    for (let i = period; i < N; i++) {
      const hma = unchecked(bufOut0[i]);
      const phma = unchecked(bufOut0[i - 1]);
      if (isNaN(hma) || isNaN(phma)) continue;
      const a = atrScale(i);
      const slope = (hma - phma) / (a * 0.45);
      const dist = (unchecked(bufClose[i]) - hma) / (a * 1.8);
      unchecked((bufSig[i] = safeTanh(slope * 0.65 + dist * 0.35)));
    }
    lines = 1;
  }

  // 4: Supertrend
  else if (id == 4) {
    const period = max<i32>(3, <i32>Math.round(p1));
    const mult = p2 > 0.2 ? p2 : 3.0;
    computeATRInto(period, bufTmpA);
    let upperBand: f64 = 0.0;
    let lowerBand: f64 = 0.0;
    let dir: f64 = 1.0;
    for (let i = 0; i < N; i++) {
      const hl2 = (unchecked(bufHigh[i]) + unchecked(bufLow[i])) * 0.5;
      const atr = unchecked(bufTmpA[i]);
      const c = unchecked(bufClose[i]);
      const basicUpper = hl2 + mult * atr;
      const basicLower = hl2 - mult * atr;
      if (i == 0) {
        upperBand = basicUpper;
        lowerBand = basicLower;
      } else {
        const prevC = unchecked(bufClose[i - 1]);
        upperBand = basicUpper < upperBand || prevC > upperBand ? basicUpper : upperBand;
        lowerBand = basicLower > lowerBand || prevC < lowerBand ? basicLower : lowerBand;
        if (dir > 0.0 && c < lowerBand) dir = -1.0;
        else if (dir < 0.0 && c > upperBand) dir = 1.0;
      }
      const st = dir > 0.0 ? lowerBand : upperBand;
      if (i >= period - 1) {
        unchecked((bufOut0[i] = st));
        unchecked((bufOut1[i] = dir));
        const dist = Math.abs(c - st) / (atrScale(i) * 2.5);
        unchecked((bufSig[i] = dir * (0.55 + 0.45 * safeTanh(dist))));
      }
    }
    lines = 2;
  }

  // 5: ADX / +DI / -DI
  else if (id == 5) {
    const p = max<i32>(3, <i32>Math.round(p1));
    const trendMin = p2 > 1.0 ? p2 : 20.0;
    let smTR: f64 = 0.0;
    let smPlus: f64 = 0.0;
    let smMinus: f64 = 0.0;
    let adx: f64 = 0.0;
    let dxSum: f64 = 0.0;
    for (let i = 1; i < N; i++) {
      const h = unchecked(bufHigh[i]);
      const l = unchecked(bufLow[i]);
      const ph = unchecked(bufHigh[i - 1]);
      const pl = unchecked(bufLow[i - 1]);
      const pc = unchecked(bufClose[i - 1]);
      const upMove = h - ph;
      const dnMove = pl - l;
      const plusDM = upMove > dnMove && upMove > 0.0 ? upMove : 0.0;
      const minusDM = dnMove > upMove && dnMove > 0.0 ? dnMove : 0.0;
      let tr = h - l;
      const d1 = Math.abs(h - pc);
      const d2 = Math.abs(l - pc);
      if (d1 > tr) tr = d1;
      if (d2 > tr) tr = d2;

      if (i <= p) {
        smTR += tr; smPlus += plusDM; smMinus += minusDM;
        if (i == p) {
          const pdi = smTR > 0.0 ? 100.0 * smPlus / smTR : 0.0;
          const mdi = smTR > 0.0 ? 100.0 * smMinus / smTR : 0.0;
          dxSum = pdi + mdi > 0.0 ? 100.0 * Math.abs(pdi - mdi) / (pdi + mdi) : 0.0;
          unchecked((bufOut1[i] = pdi));
          unchecked((bufOut2[i] = mdi));
        }
      } else {
        smTR = smTR - smTR / <f64>p + tr;
        smPlus = smPlus - smPlus / <f64>p + plusDM;
        smMinus = smMinus - smMinus / <f64>p + minusDM;
        const pdi = smTR > 0.0 ? 100.0 * smPlus / smTR : 0.0;
        const mdi = smTR > 0.0 ? 100.0 * smMinus / smTR : 0.0;
        const dx = pdi + mdi > 0.0 ? 100.0 * Math.abs(pdi - mdi) / (pdi + mdi) : 0.0;
        unchecked((bufOut1[i] = pdi));
        unchecked((bufOut2[i] = mdi));
        if (i < 2 * p) {
          dxSum += dx;
          if (i == 2 * p - 1) {
            adx = dxSum / <f64>p;
            unchecked((bufOut0[i] = adx));
          }
        } else {
          adx = (adx * <f64>(p - 1) + dx) / <f64>p;
          unchecked((bufOut0[i] = adx));
          const dirBias = pdi + mdi > 0.0 ? (pdi - mdi) / (pdi + mdi) : 0.0;
          const strength = clamp((adx - trendMin * 0.4) / (trendMin * 1.4), 0.1, 1.0);
          unchecked((bufSig[i] = clamp(dirBias * strength * 1.5, -1.0, 1.0)));
        }
      }
    }
    lines = 3;
  }

  // 6: Parabolic SAR
  else if (id == 6) {
    const step = p1 > 0.001 ? p1 : 0.02;
    const maxStep = p2 > step ? p2 : 0.2;
    if (N >= 2) {
      let bull = unchecked(bufClose[1]) >= unchecked(bufClose[0]);
      let sar = bull ? unchecked(bufLow[0]) : unchecked(bufHigh[0]);
      let ep = bull ? unchecked(bufHigh[1]) : unchecked(bufLow[1]);
      let af = step;
      unchecked((bufOut0[0] = sar));
      unchecked((bufOut1[0] = bull ? 1.0 : -1.0));
      for (let i = 1; i < N; i++) {
        const h = unchecked(bufHigh[i]);
        const l = unchecked(bufLow[i]);
        const c = unchecked(bufClose[i]);
        sar = sar + af * (ep - sar);
        if (bull) {
          if (i >= 2) {
            const minL = Math.min(unchecked(bufLow[i - 1]), unchecked(bufLow[i - 2]));
            if (sar > minL) sar = minL;
          }
          if (l < sar) { bull = false; sar = ep; ep = l; af = step; }
          else if (h > ep) { ep = h; af = Math.min(maxStep, af + step); }
        } else {
          if (i >= 2) {
            const maxH = Math.max(unchecked(bufHigh[i - 1]), unchecked(bufHigh[i - 2]));
            if (sar < maxH) sar = maxH;
          }
          if (h > sar) { bull = true; sar = ep; ep = h; af = step; }
          else if (l < ep) { ep = l; af = Math.min(maxStep, af + step); }
        }
        unchecked((bufOut0[i] = sar));
        const d: f64 = bull ? 1.0 : -1.0;
        unchecked((bufOut1[i] = d));
        const dist = Math.abs(c - sar) / (atrScale(i) * 2.2);
        unchecked((bufSig[i] = d * (0.5 + 0.5 * safeTanh(dist))));
      }
    }
    lines = 2;
  }

  // 7: Ichimoku Cloud
  else if (id == 7) {
    const tP = max<i32>(3, <i32>Math.round(p1));
    const kP = max<i32>(tP + 1, <i32>Math.round(p2));
    const bP = max<i32>(kP + 1, <i32>Math.round(p3));
    for (let i = 0; i < N; i++) {
      if (i >= tP - 1) {
        let hh = unchecked(bufHigh[i]); let ll = unchecked(bufLow[i]);
        for (let j = i - tP + 1; j <= i; j++) {
          if (unchecked(bufHigh[j]) > hh) hh = unchecked(bufHigh[j]);
          if (unchecked(bufLow[j]) < ll) ll = unchecked(bufLow[j]);
        }
        unchecked((bufOut0[i] = (hh + ll) * 0.5));
      }
      if (i >= kP - 1) {
        let hh = unchecked(bufHigh[i]); let ll = unchecked(bufLow[i]);
        for (let j = i - kP + 1; j <= i; j++) {
          if (unchecked(bufHigh[j]) > hh) hh = unchecked(bufHigh[j]);
          if (unchecked(bufLow[j]) < ll) ll = unchecked(bufLow[j]);
        }
        unchecked((bufOut1[i] = (hh + ll) * 0.5));
        unchecked((bufOut2[i] = (unchecked(bufOut0[i]) + unchecked(bufOut1[i])) * 0.5));
      }
      if (i >= bP - 1) {
        let hh = unchecked(bufHigh[i]); let ll = unchecked(bufLow[i]);
        for (let j = i - bP + 1; j <= i; j++) {
          if (unchecked(bufHigh[j]) > hh) hh = unchecked(bufHigh[j]);
          if (unchecked(bufLow[j]) < ll) ll = unchecked(bufLow[j]);
        }
        unchecked((bufOut3[i] = (hh + ll) * 0.5));
        const tenkan = unchecked(bufOut0[i]);
        const kijun = unchecked(bufOut1[i]);
        const spanA = unchecked(bufOut2[i]);
        const spanB = unchecked(bufOut3[i]);
        const c = unchecked(bufClose[i]);
        const cloudTop = Math.max(spanA, spanB);
        const cloudBot = Math.min(spanA, spanB);
        const a = atrScale(i);
        let cloudScore: f64 = 0.0;
        if (c > cloudTop) cloudScore = 0.45 + 0.15 * safeTanh((c - cloudTop) / (a * 2.0));
        else if (c < cloudBot) cloudScore = -0.45 - 0.15 * safeTanh((cloudBot - c) / (a * 2.0));
        const tkScore = 0.25 * safeTanh((tenkan - kijun) / (a * 1.2));
        const twistScore = 0.15 * safeTanh((spanA - spanB) / (a * 1.5));
        unchecked((bufSig[i] = clamp(cloudScore + tkScore + twistScore, -1.0, 1.0)));
      }
    }
    lines = 4;
  }

  // 8: DEMA (Double Exponential Moving Average)
  else if (id == 8) {
    const period = max<i32>(3, <i32>Math.round(p1));
    computeEMAInto(bufClose, period, bufTmpA);
    computeEMAInto(bufTmpA, period, bufTmpB);
    for (let i = 0; i < N; i++) {
      const e1 = unchecked(bufTmpA[i]);
      const e2 = unchecked(bufTmpB[i]);
      unchecked((bufOut0[i] = isNaN(e1) || isNaN(e2) ? NaN : 2.0 * e1 - e2));
      if (i > 0) unchecked((bufSig[i] = maSignal(i, unchecked(bufOut0[i]), unchecked(bufOut0[i - 1]), 1.7, 0.35)));
    }
    lines = 1;
  }

  // 9: TEMA (Triple Exponential Moving Average)
  else if (id == 9) {
    const period = max<i32>(3, <i32>Math.round(p1));
    computeEMAInto(bufClose, period, bufTmpA);
    computeEMAInto(bufTmpA, period, bufTmpB);
    computeEMAInto(bufTmpB, period, bufTmpC);
    for (let i = 0; i < N; i++) {
      const e1 = unchecked(bufTmpA[i]);
      const e2 = unchecked(bufTmpB[i]);
      const e3 = unchecked(bufTmpC[i]);
      unchecked((bufOut0[i] = isNaN(e1) || isNaN(e2) || isNaN(e3) ? NaN : 3.0 * e1 - 3.0 * e2 + e3));
      if (i > 0) unchecked((bufSig[i] = maSignal(i, unchecked(bufOut0[i]), unchecked(bufOut0[i - 1]), 1.6, 0.35)));
    }
    lines = 1;
  }

  // 10: KAMA (Kaufman Adaptive Moving Average) (p1=erPeriod 10, p2=fast 2, p3=slow 30)
  else if (id == 10) {
    const erP = max<i32>(3, <i32>Math.round(p1));
    const fastSc = 2.0 / (Math.max(2.0, p2) + 1.0);
    const slowSc = 2.0 / (Math.max(5.0, p3) + 1.0);
    if (N > erP) {
      let kama = unchecked(bufClose[erP - 1]);
      unchecked((bufOut0[erP - 1] = kama));
      for (let i = erP; i < N; i++) {
        const change = Math.abs(unchecked(bufClose[i]) - unchecked(bufClose[i - erP]));
        let vol: f64 = 0.0;
        for (let j = i - erP + 1; j <= i; j++) {
          vol += Math.abs(unchecked(bufClose[j]) - unchecked(bufClose[j - 1]));
        }
        const er = vol > 1e-12 ? change / vol : 0.0;
        const sc = er * (fastSc - slowSc) + slowSc;
        const prev = kama;
        kama = kama + sc * sc * (unchecked(bufClose[i]) - kama);
        unchecked((bufOut0[i] = kama));
        unchecked((bufSig[i] = maSignal(i, kama, prev, 1.8, 0.3)));
      }
    }
    lines = 1;
  }

  // 11: ZLEMA (Zero-Lag Exponential Moving Average)
  else if (id == 11) {
    const period = max<i32>(4, <i32>Math.round(p1));
    const lag = max<i32>(1, (period - 1) >> 1);
    for (let i = 0; i < N; i++) {
      unchecked((bufTmpA[i] = i >= lag ? 2.0 * unchecked(bufClose[i]) - unchecked(bufClose[i - lag]) : unchecked(bufClose[i])));
    }
    computeEMAInto(bufTmpA, period, bufOut0);
    for (let i = period; i < N; i++) {
      unchecked((bufSig[i] = maSignal(i, unchecked(bufOut0[i]), unchecked(bufOut0[i - 1]), 1.6, 0.35)));
    }
    lines = 1;
  }

  // 12: ALMA (Arnaud Legoux Moving Average) (p1=window 20, p2=offset 0.85, p3=sigma 6)
  else if (id == 12) {
    const win = max<i32>(4, <i32>Math.round(p1));
    const offset = clamp(p2 > 0.0 ? p2 : 0.85, 0.1, 0.99);
    const sigma = p3 > 0.5 ? p3 : 6.0;
    const m = offset * <f64>(win - 1);
    const s = <f64>win / sigma;
    const wArr = new Float64Array(win);
    let wSum: f64 = 0.0;
    for (let j = 0; j < win; j++) {
      const d = <f64>j - m;
      const w = Math.exp(-(d * d) / (2.0 * s * s));
      unchecked((wArr[j] = w));
      wSum += w;
    }
    for (let i = win - 1; i < N; i++) {
      let acc: f64 = 0.0;
      for (let j = 0; j < win; j++) {
        acc += unchecked(bufClose[i - win + 1 + j]) * unchecked(wArr[j]);
      }
      const val = acc / wSum;
      unchecked((bufOut0[i] = val));
      if (i > win - 1) unchecked((bufSig[i] = maSignal(i, val, unchecked(bufOut0[i - 1]), 1.7, 0.35)));
    }
    lines = 1;
  }

  // 13: Aroon Oscillator (p1=period 25)
  else if (id == 13) {
    const p = max<i32>(3, <i32>Math.round(p1));
    for (let i = p; i < N; i++) {
      let hiIdx = i; let loIdx = i;
      let hh = unchecked(bufHigh[i]); let ll = unchecked(bufLow[i]);
      for (let j = i - p; j <= i; j++) {
        if (unchecked(bufHigh[j]) >= hh) { hh = unchecked(bufHigh[j]); hiIdx = j; }
        if (unchecked(bufLow[j]) <= ll) { ll = unchecked(bufLow[j]); loIdx = j; }
      }
      const aUp = 100.0 * <f64>(p - (i - hiIdx)) / <f64>p;
      const aDn = 100.0 * <f64>(p - (i - loIdx)) / <f64>p;
      const osc = aUp - aDn;
      unchecked((bufOut0[i] = osc));
      unchecked((bufOut1[i] = aUp));
      unchecked((bufOut2[i] = aDn));
      unchecked((bufSig[i] = clamp(osc / 100.0, -1.0, 1.0)));
    }
    lines = 3;
  }

  // 14: Vortex Indicator (VI+ / VI-) (p1=period 14)
  else if (id == 14) {
    const p = max<i32>(3, <i32>Math.round(p1));
    for (let i = p; i < N; i++) {
      let vmPlus: f64 = 0.0; let vmMinus: f64 = 0.0; let trSum: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) {
        const h = unchecked(bufHigh[j]); const l = unchecked(bufLow[j]);
        const ph = unchecked(bufHigh[j - 1]); const pl = unchecked(bufLow[j - 1]);
        const pc = unchecked(bufClose[j - 1]);
        vmPlus += Math.abs(h - pl);
        vmMinus += Math.abs(l - ph);
        let tr = h - l;
        const d1 = Math.abs(h - pc); const d2 = Math.abs(l - pc);
        if (d1 > tr) tr = d1;
        if (d2 > tr) tr = d2;
        trSum += tr;
      }
      const vip = trSum > 1e-12 ? vmPlus / trSum : 1.0;
      const vim = trSum > 1e-12 ? vmMinus / trSum : 1.0;
      unchecked((bufOut0[i] = vip));
      unchecked((bufOut1[i] = vim));
      unchecked((bufSig[i] = safeTanh((vip - vim) * 3.5)));
    }
    lines = 2;
  }

  // 15: Linear Regression Channel & Slope R² (p1=period 20)
  else if (id == 15) {
    const p = max<i32>(5, <i32>Math.round(p1));
    const pf = <f64>p;
    const xMean = (pf - 1.0) * 0.5;
    let xVar: f64 = 0.0;
    for (let j = 0; j < p; j++) {
      const dx = <f64>j - xMean;
      xVar += dx * dx;
    }
    for (let i = p - 1; i < N; i++) {
      let ySum: f64 = 0.0;
      for (let j = 0; j < p; j++) ySum += unchecked(bufClose[i - p + 1 + j]);
      const yMean = ySum / pf;
      let cov: f64 = 0.0;
      let yVar: f64 = 0.0;
      for (let j = 0; j < p; j++) {
        const dx = <f64>j - xMean;
        const dy = unchecked(bufClose[i - p + 1 + j]) - yMean;
        cov += dx * dy;
        yVar += dy * dy;
      }
      const slope = cov / xVar;
      const regVal = yMean + slope * (pf - 1.0 - xMean);
      const r2 = yVar > 1e-12 ? clamp((cov * cov) / (xVar * yVar), 0.0, 1.0) : 0.0;
      unchecked((bufOut0[i] = regVal));
      unchecked((bufOut1[i] = slope));
      unchecked((bufOut2[i] = r2));
      const a = atrScale(i);
      const slopeNorm = (slope / (a * 0.25)) * (0.35 + 0.65 * r2);
      unchecked((bufSig[i] = safeTanh(slopeNorm)));
    }
    lines = 3;
  }

  // ===================== MOMENTUM & OSCILLATORS (16..33) =====================

  // 16: RSI (Wilder's)
  else if (id == 16) {
    const p = max<i32>(2, <i32>Math.round(p1));
    const os = p2 > 5.0 && p2 < 49.0 ? p2 : 30.0;
    const ob = p3 > 51.0 && p3 < 95.0 ? p3 : 70.0;
    computeRSIInto(p, bufOut0);
    const mid = (os + ob) * 0.5;
    const halfSpan = Math.max(10.0, (ob - os) * 0.5);
    for (let i = p; i < N; i++) {
      unchecked((bufSig[i] = safeTanh(((mid - unchecked(bufOut0[i])) / halfSpan) * 1.15)));
    }
    lines = 1;
  }

  // 17: Stochastic RSI (p1=rsiPeriod 14, p2=stochPeriod 14, p3=kSmooth 3)
  else if (id == 17) {
    const rP = max<i32>(3, <i32>Math.round(p1));
    const sP = max<i32>(3, <i32>Math.round(p2));
    const kP = max<i32>(1, <i32>Math.round(p3));
    computeRSIInto(rP, bufTmpA);
    for (let i = rP + sP - 1; i < N; i++) {
      let hi = unchecked(bufTmpA[i]); let lo = hi;
      for (let j = i - sP + 1; j <= i; j++) {
        const v = unchecked(bufTmpA[j]);
        if (v > hi) hi = v;
        if (v < lo) lo = v;
      }
      unchecked((bufTmpB[i] = hi - lo > 1e-9 ? 100.0 * (unchecked(bufTmpA[i]) - lo) / (hi - lo) : 50.0));
    }
    computeSMAInto(bufTmpB, kP, bufOut0);
    computeSMAInto(bufOut0, 3, bufOut1);
    for (let i = rP + sP; i < N; i++) {
      const k = unchecked(bufOut0[i]);
      const d = unchecked(bufOut1[i]);
      if (isNaN(k)) continue;
      const cross = isNaN(d) ? 0.0 : (k - d) / 22.0;
      unchecked((bufSig[i] = safeTanh(((50.0 - k) / 30.0) * 0.85 + cross * 0.35)));
    }
    lines = 2;
  }

  // 18: MACD
  else if (id == 18) {
    const fast = max<i32>(2, <i32>Math.round(p1));
    const slow = max<i32>(fast + 1, <i32>Math.round(p2));
    const sigP = max<i32>(2, <i32>Math.round(p3));
    computeEMAInto(bufClose, fast, bufTmpA);
    computeEMAInto(bufClose, slow, bufTmpB);
    for (let i = 0; i < N; i++) {
      const a = unchecked(bufTmpA[i]); const b = unchecked(bufTmpB[i]);
      unchecked((bufOut0[i] = isNaN(a) || isNaN(b) ? NaN : a - b));
    }
    computeEMAInto(bufOut0, sigP, bufOut1);
    for (let i = slow + sigP - 1; i < N; i++) {
      const m = unchecked(bufOut0[i]); const s = unchecked(bufOut1[i]);
      if (isNaN(m) || isNaN(s)) continue;
      const hist = m - s;
      unchecked((bufOut2[i] = hist));
      const prevH = !isNaN(unchecked(bufOut2[i - 1])) ? unchecked(bufOut2[i - 1]) : hist;
      const a = atrScale(i);
      unchecked((bufSig[i] = safeTanh((hist / (a * 0.45)) * 0.55 + (m / (a * 1.4)) * 0.25 + ((hist - prevH) / (a * 0.2)) * 0.2)));
    }
    lines = 3;
  }

  // 19: PPO (Percentage Price Oscillator) (p1=fast 12, p2=slow 26, p3=sig 9)
  else if (id == 19) {
    const fast = max<i32>(2, <i32>Math.round(p1));
    const slow = max<i32>(fast + 1, <i32>Math.round(p2));
    const sigP = max<i32>(2, <i32>Math.round(p3));
    computeEMAInto(bufClose, fast, bufTmpA);
    computeEMAInto(bufClose, slow, bufTmpB);
    for (let i = 0; i < N; i++) {
      const a = unchecked(bufTmpA[i]); const b = unchecked(bufTmpB[i]);
      unchecked((bufOut0[i] = isNaN(a) || isNaN(b) || Math.abs(b) < 1e-9 ? NaN : 100.0 * (a - b) / b));
    }
    computeEMAInto(bufOut0, sigP, bufOut1);
    for (let i = slow + sigP - 1; i < N; i++) {
      const ppo = unchecked(bufOut0[i]); const sigL = unchecked(bufOut1[i]);
      if (isNaN(ppo) || isNaN(sigL)) continue;
      const h = ppo - sigL;
      unchecked((bufOut2[i] = h));
      unchecked((bufSig[i] = safeTanh(h * 1.3 + ppo * 0.25)));
    }
    lines = 3;
  }

  // 20: Stochastic Oscillator (%K, %D)
  else if (id == 20) {
    const kp = max<i32>(3, <i32>Math.round(p1));
    const dp = max<i32>(2, <i32>Math.round(p2));
    const os = p3 > 2.0 && p3 < 49.0 ? p3 : 20.0;
    const ob = p4 > 51.0 && p4 < 98.0 ? p4 : 80.0;
    for (let i = kp - 1; i < N; i++) {
      let hh = unchecked(bufHigh[i]); let ll = unchecked(bufLow[i]);
      for (let j = i - kp + 1; j <= i; j++) {
        if (unchecked(bufHigh[j]) > hh) hh = unchecked(bufHigh[j]);
        if (unchecked(bufLow[j]) < ll) ll = unchecked(bufLow[j]);
      }
      unchecked((bufOut0[i] = hh - ll > 1e-12 ? 100.0 * (unchecked(bufClose[i]) - ll) / (hh - ll) : 50.0));
    }
    computeSMAInto(bufOut0, dp, bufOut1);
    const mid = (os + ob) * 0.5;
    const halfSpan = Math.max(15.0, (ob - os) * 0.5);
    for (let i = kp + dp - 2; i < N; i++) {
      const k = unchecked(bufOut0[i]); const d = unchecked(bufOut1[i]);
      if (isNaN(d)) continue;
      unchecked((bufSig[i] = safeTanh(((mid - k) / halfSpan) * 0.8 + ((k - d) / 18.0) * 0.35)));
    }
    lines = 2;
  }

  // 21: CCI
  else if (id == 21) {
    const p = max<i32>(3, <i32>Math.round(p1));
    const lvl = p2 > 20.0 ? p2 : 100.0;
    for (let i = 0; i < N; i++) {
      unchecked((bufTmpA[i] = (unchecked(bufHigh[i]) + unchecked(bufLow[i]) + unchecked(bufClose[i])) / 3.0));
    }
    for (let i = p - 1; i < N; i++) {
      let sum: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) sum += unchecked(bufTmpA[j]);
      const mean = sum / <f64>p;
      let mdSum: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) mdSum += Math.abs(unchecked(bufTmpA[j]) - mean);
      const md = mdSum / <f64>p;
      const cci = md > 1e-12 ? (unchecked(bufTmpA[i]) - mean) / (0.015 * md) : 0.0;
      unchecked((bufOut0[i] = cci));
      unchecked((bufSig[i] = safeTanh(-cci / (lvl * 1.45))));
    }
    lines = 1;
  }

  // 22: Williams %R
  else if (id == 22) {
    const p = max<i32>(3, <i32>Math.round(p1));
    const os = p2 < -50.0 ? p2 : -80.0;
    const ob = p3 > -50.0 ? p3 : -20.0;
    const mid = (os + ob) * 0.5;
    const halfSpan = Math.max(15.0, (ob - os) * 0.5);
    for (let i = p - 1; i < N; i++) {
      let hh = unchecked(bufHigh[i]); let ll = unchecked(bufLow[i]);
      for (let j = i - p + 1; j <= i; j++) {
        if (unchecked(bufHigh[j]) > hh) hh = unchecked(bufHigh[j]);
        if (unchecked(bufLow[j]) < ll) ll = unchecked(bufLow[j]);
      }
      const wr = hh - ll > 1e-12 ? -100.0 * (hh - unchecked(bufClose[i])) / (hh - ll) : -50.0;
      unchecked((bufOut0[i] = wr));
      unchecked((bufSig[i] = safeTanh(((mid - wr) / halfSpan) * 1.1)));
    }
    lines = 1;
  }

  // 23: ROC
  else if (id == 23) {
    const p = max<i32>(1, <i32>Math.round(p1));
    const scale = p2 > 0.2 ? p2 : 5.0;
    for (let i = p; i < N; i++) {
      const prev = unchecked(bufClose[i - p]);
      const roc = prev > 1e-12 ? 100.0 * (unchecked(bufClose[i]) - prev) / prev : 0.0;
      unchecked((bufOut0[i] = roc));
      unchecked((bufSig[i] = safeTanh(roc / scale)));
    }
    lines = 1;
  }

  // 24: MFI
  else if (id == 24) {
    const p = max<i32>(2, <i32>Math.round(p1));
    const os = p2 > 5.0 && p2 < 49.0 ? p2 : 20.0;
    const ob = p3 > 51.0 && p3 < 95.0 ? p3 : 80.0;
    const mid = (os + ob) * 0.5;
    const halfSpan = Math.max(15.0, (ob - os) * 0.5);
    for (let i = 0; i < N; i++) {
      unchecked((bufTmpA[i] = (unchecked(bufHigh[i]) + unchecked(bufLow[i]) + unchecked(bufClose[i])) / 3.0));
    }
    for (let i = p; i < N; i++) {
      let posMF: f64 = 0.0; let negMF: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) {
        const tp = unchecked(bufTmpA[j]); const ptp = unchecked(bufTmpA[j - 1]);
        const rmf = tp * unchecked(bufVolume[j]);
        if (tp > ptp) posMF += rmf;
        else if (tp < ptp) negMF += rmf;
      }
      const mfi = negMF <= 1e-12 ? (posMF > 0.0 ? 100.0 : 50.0) : 100.0 - 100.0 / (1.0 + posMF / negMF);
      unchecked((bufOut0[i] = mfi));
      unchecked((bufSig[i] = safeTanh(((mid - mfi) / halfSpan) * 1.15)));
    }
    lines = 1;
  }

  // 25: Awesome Oscillator
  else if (id == 25) {
    const fast = max<i32>(2, <i32>Math.round(p1));
    const slow = max<i32>(fast + 1, <i32>Math.round(p2));
    for (let i = 0; i < N; i++) unchecked((bufTmpA[i] = (unchecked(bufHigh[i]) + unchecked(bufLow[i])) * 0.5));
    computeSMAInto(bufTmpA, fast, bufTmpB);
    computeSMAInto(bufTmpA, slow, bufTmpC);
    for (let i = slow - 1; i < N; i++) {
      const ao = unchecked(bufTmpB[i]) - unchecked(bufTmpC[i]);
      unchecked((bufOut0[i] = ao));
      const prevAo = i > slow - 1 ? unchecked(bufOut0[i - 1]) : ao;
      const a = atrScale(i);
      unchecked((bufSig[i] = safeTanh((ao / (a * 1.5)) * 0.7 + ((ao - prevAo) / (a * 0.4)) * 0.3)));
    }
    lines = 1;
  }

  // 26: TRIX (Triple Smoothed EMA Rate of Change %) (p1=period 15, p2=signal 9)
  else if (id == 26) {
    const p = max<i32>(3, <i32>Math.round(p1));
    const sp = max<i32>(2, <i32>Math.round(p2));
    computeEMAInto(bufClose, p, bufTmpA);
    computeEMAInto(bufTmpA, p, bufTmpB);
    computeEMAInto(bufTmpB, p, bufTmpC);
    for (let i = 1; i < N; i++) {
      const cur = unchecked(bufTmpC[i]); const prev = unchecked(bufTmpC[i - 1]);
      unchecked((bufOut0[i] = isNaN(cur) || isNaN(prev) || Math.abs(prev) < 1e-12 ? NaN : 100.0 * (cur - prev) / prev));
    }
    computeEMAInto(bufOut0, sp, bufOut1);
    for (let i = 1; i < N; i++) {
      const t = unchecked(bufOut0[i]); const s = unchecked(bufOut1[i]);
      if (isNaN(t)) continue;
      const diff = isNaN(s) ? 0.0 : t - s;
      unchecked((bufSig[i] = safeTanh(t * 4.5 + diff * 8.0)));
    }
    lines = 2;
  }

  // 27: Ultimate Oscillator (p1=7, p2=14, p3=28)
  else if (id == 27) {
    const a1 = max<i32>(2, <i32>Math.round(p1));
    const a2 = max<i32>(a1 + 1, <i32>Math.round(p2));
    const a3 = max<i32>(a2 + 1, <i32>Math.round(p3));
    for (let i = 1; i < N; i++) {
      const pc = unchecked(bufClose[i - 1]);
      const tl = Math.min(unchecked(bufLow[i]), pc);
      const th = Math.max(unchecked(bufHigh[i]), pc);
      unchecked((bufTmpA[i] = unchecked(bufClose[i]) - tl)); // BP
      unchecked((bufTmpB[i] = th - tl));                     // TR
    }
    for (let i = a3; i < N; i++) {
      let bp1: f64 = 0.0; let tr1: f64 = 0.0;
      let bp2: f64 = 0.0; let tr2: f64 = 0.0;
      let bp3: f64 = 0.0; let tr3: f64 = 0.0;
      for (let j = i - a1 + 1; j <= i; j++) { bp1 += unchecked(bufTmpA[j]); tr1 += unchecked(bufTmpB[j]); }
      for (let j = i - a2 + 1; j <= i; j++) { bp2 += unchecked(bufTmpA[j]); tr2 += unchecked(bufTmpB[j]); }
      for (let j = i - a3 + 1; j <= i; j++) { bp3 += unchecked(bufTmpA[j]); tr3 += unchecked(bufTmpB[j]); }
      const avg1 = tr1 > 1e-12 ? bp1 / tr1 : 0.5;
      const avg2 = tr2 > 1e-12 ? bp2 / tr2 : 0.5;
      const avg3 = tr3 > 1e-12 ? bp3 / tr3 : 0.5;
      const uo = 100.0 * (4.0 * avg1 + 2.0 * avg2 + avg3) / 7.0;
      unchecked((bufOut0[i] = uo));
      unchecked((bufSig[i] = safeTanh((50.0 - uo) / 22.0)));
    }
    lines = 1;
  }

  // 28: CMO (Chande Momentum Oscillator) (p1=period 14)
  else if (id == 28) {
    const p = max<i32>(3, <i32>Math.round(p1));
    for (let i = p; i < N; i++) {
      let up: f64 = 0.0; let dn: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) {
        const d = unchecked(bufClose[j]) - unchecked(bufClose[j - 1]);
        if (d > 0.0) up += d; else dn -= d;
      }
      const cmo = up + dn > 1e-12 ? 100.0 * (up - dn) / (up + dn) : 0.0;
      unchecked((bufOut0[i] = cmo));
      unchecked((bufSig[i] = safeTanh(cmo / 45.0)));
    }
    lines = 1;
  }

  // 29: TSI (True Strength Index) (p1=long 25, p2=short 13, p3=sig 7)
  else if (id == 29) {
    const lP = max<i32>(4, <i32>Math.round(p1));
    const sP = max<i32>(2, <i32>Math.round(p2));
    const sigP = max<i32>(2, <i32>Math.round(p3));
    unchecked((bufTmpA[0] = 0.0)); unchecked((bufTmpB[0] = 0.0));
    for (let i = 1; i < N; i++) {
      const m = unchecked(bufClose[i]) - unchecked(bufClose[i - 1]);
      unchecked((bufTmpA[i] = m));
      unchecked((bufTmpB[i] = Math.abs(m)));
    }
    computeEMAInto(bufTmpA, lP, bufTmpC);
    computeEMAInto(bufTmpC, sP, bufTmpA); // double smoothed momentum
    computeEMAInto(bufTmpB, lP, bufTmpD);
    computeEMAInto(bufTmpD, sP, bufTmpB); // double smoothed |momentum|
    for (let i = 0; i < N; i++) {
      const num = unchecked(bufTmpA[i]); const den = unchecked(bufTmpB[i]);
      unchecked((bufOut0[i] = isNaN(num) || isNaN(den) || den < 1e-12 ? NaN : 100.0 * num / den));
    }
    computeEMAInto(bufOut0, sigP, bufOut1);
    for (let i = 0; i < N; i++) {
      const t = unchecked(bufOut0[i]); const s = unchecked(bufOut1[i]);
      if (isNaN(t)) continue;
      const cross = isNaN(s) ? 0.0 : (t - s) / 14.0;
      unchecked((bufSig[i] = safeTanh(t / 28.0 + cross * 0.5)));
    }
    lines = 2;
  }

  // 30: KST (Know Sure Thing — Pring Multi-Horizon ROC)
  else if (id == 30) {
    const sigP = max<i32>(3, <i32>Math.round(p1 > 0.0 ? p1 : 9.0));
    for (let i = 30; i < N; i++) {
      const c = unchecked(bufClose[i]);
      const r1 = 100.0 * (c - unchecked(bufClose[i - 10])) / Math.max(1e-9, unchecked(bufClose[i - 10]));
      const r2 = 100.0 * (c - unchecked(bufClose[i - 15])) / Math.max(1e-9, unchecked(bufClose[i - 15]));
      const r3 = 100.0 * (c - unchecked(bufClose[i - 20])) / Math.max(1e-9, unchecked(bufClose[i - 20]));
      const r4 = 100.0 * (c - unchecked(bufClose[i - 30])) / Math.max(1e-9, unchecked(bufClose[i - 30]));
      unchecked((bufTmpA[i] = r1 + 2.0 * r2 + 3.0 * r3 + 4.0 * r4));
    }
    computeSMAInto(bufTmpA, 10, bufOut0);
    computeSMAInto(bufOut0, sigP, bufOut1);
    for (let i = 40; i < N; i++) {
      const k = unchecked(bufOut0[i]); const s = unchecked(bufOut1[i]);
      if (isNaN(k)) continue;
      const cross = isNaN(s) ? 0.0 : (k - s) / 18.0;
      unchecked((bufSig[i] = safeTanh(k / 60.0 + cross * 0.55)));
    }
    lines = 2;
  }

  // 31: Coppock Curve (p1=wma 10, p2=roc1 14, p3=roc2 11)
  else if (id == 31) {
    const wp = max<i32>(3, <i32>Math.round(p1));
    const r1 = max<i32>(3, <i32>Math.round(p2));
    const r2 = max<i32>(3, <i32>Math.round(p3));
    const start = max<i32>(r1, r2);
    for (let i = 0; i < N; i++) {
      if (i < start) { unchecked((bufTmpA[i] = NaN)); continue; }
      const c = unchecked(bufClose[i]);
      const v1 = 100.0 * (c - unchecked(bufClose[i - r1])) / Math.max(1e-9, unchecked(bufClose[i - r1]));
      const v2 = 100.0 * (c - unchecked(bufClose[i - r2])) / Math.max(1e-9, unchecked(bufClose[i - r2]));
      unchecked((bufTmpA[i] = v1 + v2));
    }
    computeWMAInto(bufTmpA, wp, bufOut0);
    for (let i = start + wp; i < N; i++) {
      const v = unchecked(bufOut0[i]); const pv = unchecked(bufOut0[i - 1]);
      if (isNaN(v) || isNaN(pv)) continue;
      unchecked((bufSig[i] = safeTanh(v / 14.0 + (v - pv) * 0.45)));
    }
    lines = 1;
  }

  // 32: DPO (Detrended Price Oscillator) (p1=period 20)
  else if (id == 32) {
    const p = max<i32>(4, <i32>Math.round(p1));
    const shift = (p >> 1) + 1;
    computeSMAInto(bufClose, p, bufTmpA);
    for (let i = p + shift; i < N; i++) {
      const ma = unchecked(bufTmpA[i - shift]);
      if (isNaN(ma)) continue;
      const dpo = unchecked(bufClose[i]) - ma;
      unchecked((bufOut0[i] = dpo));
      unchecked((bufSig[i] = safeTanh(-dpo / (atrScale(i) * 2.4))));
    }
    lines = 1;
  }

  // 33: Elder Ray (Bull Power & Bear Power) (p1=emaPeriod 13)
  else if (id == 33) {
    const p = max<i32>(3, <i32>Math.round(p1));
    computeEMAInto(bufClose, p, bufTmpA);
    for (let i = p; i < N; i++) {
      const ema = unchecked(bufTmpA[i]);
      if (isNaN(ema)) continue;
      const bull = unchecked(bufHigh[i]) - ema;
      const bear = unchecked(bufLow[i]) - ema;
      unchecked((bufOut0[i] = bull));
      unchecked((bufOut1[i] = bear));
      const net = bull + bear;
      const a = atrScale(i);
      unchecked((bufSig[i] = safeTanh(net / (a * 1.8))));
    }
    lines = 2;
  }

  // ===================== VOLATILITY & CHANNELS (34..45) =====================

  // 34: Bollinger Bands (%B)
  else if (id == 34) {
    const p = max<i32>(3, <i32>Math.round(p1));
    const mult = p2 > 0.2 ? p2 : 2.0;
    for (let i = p - 1; i < N; i++) {
      let sum: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) sum += unchecked(bufClose[j]);
      const mid = sum / <f64>p;
      let vSum: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) { const d = unchecked(bufClose[j]) - mid; vSum += d * d; }
      const sd = Math.sqrt(vSum / <f64>p);
      const upper = mid + mult * sd;
      const lower = mid - mult * sd;
      const pctB = upper - lower > 1e-12 ? (unchecked(bufClose[i]) - lower) / (upper - lower) : 0.5;
      unchecked((bufOut0[i] = mid));
      unchecked((bufOut1[i] = upper));
      unchecked((bufOut2[i] = lower));
      unchecked((bufOut3[i] = pctB));
      unchecked((bufSig[i] = safeTanh((0.5 - pctB) * 2.1)));
    }
    lines = 4;
  }

  // 35: Bollinger BandWidth Squeeze (p1=period 20, p2=stdMult 2.0)
  else if (id == 35) {
    const p = max<i32>(4, <i32>Math.round(p1));
    const mult = p2 > 0.2 ? p2 : 2.0;
    for (let i = p - 1; i < N; i++) {
      let sum: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) sum += unchecked(bufClose[j]);
      const mid = sum / <f64>p;
      let vSum: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) { const d = unchecked(bufClose[j]) - mid; vSum += d * d; }
      const sd = Math.sqrt(vSum / <f64>p);
      const bw = mid > 1e-9 ? (2.0 * mult * sd / mid) * 100.0 : 0.0;
      unchecked((bufOut0[i] = bw));
    }
    computeSMAInto(bufOut0, p * 2, bufOut1);
    for (let i = p * 2; i < N; i++) {
      const bw = unchecked(bufOut0[i]); const avgBw = unchecked(bufOut1[i]);
      if (isNaN(avgBw) || avgBw < 1e-9) continue;
      // Expanding out of a tight squeeze in price direction yields strong breakout signal
      const expansion = (bw - avgBw) / avgBw;
      const dir = unchecked(bufClose[i]) >= unchecked(bufClose[i - 3]) ? 1.0 : -1.0;
      unchecked((bufSig[i] = dir * clamp(safeTanh((0.6 - bw / avgBw) * -1.4 + expansion), 0.0, 1.0)));
    }
    lines = 2;
  }

  // 36: ATR Volatility Regime
  else if (id == 36) {
    const p = max<i32>(2, <i32>Math.round(p1));
    const maP = max<i32>(5, <i32>Math.round(p2));
    computeATRInto(p, bufOut0);
    computeSMAInto(bufOut0, maP, bufTmpA);
    for (let i = 0; i < N; i++) {
      const atr = unchecked(bufOut0[i]); const c = unchecked(bufClose[i]);
      const atrPct = c > 1e-12 ? 100.0 * atr / c : 0.0;
      const base = unchecked(bufTmpA[i]);
      const ratio = !isNaN(base) && base > 1e-12 ? atr / base : 1.0;
      unchecked((bufOut1[i] = atrPct));
      unchecked((bufOut2[i] = ratio));
      unchecked((bufSig[i] = safeTanh((1.15 - ratio) * 1.8)));
    }
    lines = 3;
  }

  // 37: Keltner Channels
  else if (id == 37) {
    const p = max<i32>(3, <i32>Math.round(p1));
    const mult = p2 > 0.2 ? p2 : 2.0;
    computeEMAInto(bufClose, p, bufOut0);
    computeATRInto(p, bufTmpA);
    for (let i = p - 1; i < N; i++) {
      const mid = unchecked(bufOut0[i]);
      if (isNaN(mid)) continue;
      const half = mult * unchecked(bufTmpA[i]);
      unchecked((bufOut1[i] = mid + half));
      unchecked((bufOut2[i] = mid - half));
      const pos = half > 1e-12 ? (unchecked(bufClose[i]) - mid) / half : 0.0;
      unchecked((bufSig[i] = safeTanh(pos * 1.1)));
    }
    lines = 3;
  }

  // 38: Donchian Channels
  else if (id == 38) {
    const p = max<i32>(3, <i32>Math.round(p1));
    for (let i = p - 1; i < N; i++) {
      let hh = unchecked(bufHigh[i]); let ll = unchecked(bufLow[i]);
      for (let j = i - p + 1; j <= i; j++) {
        if (unchecked(bufHigh[j]) > hh) hh = unchecked(bufHigh[j]);
        if (unchecked(bufLow[j]) < ll) ll = unchecked(bufLow[j]);
      }
      const mid = (hh + ll) * 0.5; const half = (hh - ll) * 0.5;
      unchecked((bufOut0[i] = hh));
      unchecked((bufOut1[i] = ll));
      unchecked((bufOut2[i] = mid));
      unchecked((bufSig[i] = safeTanh((half > 1e-12 ? (unchecked(bufClose[i]) - mid) / half : 0.0) * 1.35)));
    }
    lines = 3;
  }

  // 39: Chaikin Volatility (p1=emaPeriod 10, p2=rocPeriod 10)
  else if (id == 39) {
    const ep = max<i32>(3, <i32>Math.round(p1));
    const rp = max<i32>(2, <i32>Math.round(p2));
    for (let i = 0; i < N; i++) unchecked((bufTmpA[i] = unchecked(bufHigh[i]) - unchecked(bufLow[i])));
    computeEMAInto(bufTmpA, ep, bufTmpB);
    for (let i = ep + rp; i < N; i++) {
      const cur = unchecked(bufTmpB[i]); const prev = unchecked(bufTmpB[i - rp]);
      if (isNaN(cur) || isNaN(prev) || prev < 1e-12) continue;
      const cv = 100.0 * (cur - prev) / prev;
      unchecked((bufOut0[i] = cv));
      unchecked((bufSig[i] = safeTanh(-cv / 45.0)));
    }
    lines = 1;
  }

  // 40: Ulcer Index (Downside Drawdown Volatility) (p1=period 14)
  else if (id == 40) {
    const p = max<i32>(4, <i32>Math.round(p1));
    for (let i = p - 1; i < N; i++) {
      let maxC = unchecked(bufClose[i - p + 1]);
      let sqSum: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) {
        const c = unchecked(bufClose[j]);
        if (c > maxC) maxC = c;
        const dd = maxC > 1e-12 ? 100.0 * (c - maxC) / maxC : 0.0;
        sqSum += dd * dd;
      }
      const ui = Math.sqrt(sqSum / <f64>p);
      unchecked((bufOut0[i] = ui));
      // Low ulcer = clean uptrend (+1), high ulcer = painful drawdown stress (-1)
      unchecked((bufSig[i] = safeTanh((2.5 - ui) / 3.0)));
    }
    lines = 1;
  }

  // 41: Historical Realized Volatility Regime (p1=window 20)
  else if (id == 41) {
    const p = max<i32>(5, <i32>Math.round(p1));
    for (let i = 1; i < N; i++) {
      unchecked((bufTmpA[i] = Math.log(Math.max(1e-8, unchecked(bufClose[i])) / Math.max(1e-8, unchecked(bufClose[i - 1])))));
    }
    for (let i = p; i < N; i++) {
      let sum: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) sum += unchecked(bufTmpA[j]);
      const mean = sum / <f64>p;
      let vs: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) { const d = unchecked(bufTmpA[j]) - mean; vs += d * d; }
      const hv = Math.sqrt(vs / <f64>p) * Math.sqrt(252.0) * 100.0;
      unchecked((bufOut0[i] = hv));
    }
    computeSMAInto(bufOut0, p * 2, bufOut1);
    for (let i = p * 2; i < N; i++) {
      const hv = unchecked(bufOut0[i]); const base = unchecked(bufOut1[i]);
      if (isNaN(base) || base < 1e-6) continue;
      unchecked((bufSig[i] = safeTanh((1.1 - hv / base) * 2.0)));
    }
    lines = 2;
  }

  // 42: Mass Index (Reversal Bulge) (p1=ema 9, p2=sum 25)
  else if (id == 42) {
    const ep = max<i32>(3, <i32>Math.round(p1));
    const sp = max<i32>(5, <i32>Math.round(p2));
    for (let i = 0; i < N; i++) unchecked((bufTmpA[i] = Math.max(1e-9, unchecked(bufHigh[i]) - unchecked(bufLow[i]))));
    computeEMAInto(bufTmpA, ep, bufTmpB);
    computeEMAInto(bufTmpB, ep, bufTmpC);
    for (let i = 0; i < N; i++) {
      const a = unchecked(bufTmpB[i]); const b = unchecked(bufTmpC[i]);
      unchecked((bufTmpD[i] = isNaN(a) || isNaN(b) || b < 1e-12 ? NaN : a / b));
    }
    for (let i = ep * 2 + sp; i < N; i++) {
      let sum: f64 = 0.0;
      for (let j = i - sp + 1; j <= i; j++) sum += unchecked(bufTmpD[j]);
      unchecked((bufOut0[i] = sum));
      // Bulge above 27 signals impending reversal against prior 10-bar move
      if (sum > 26.2) {
        const trend = unchecked(bufClose[i]) - unchecked(bufClose[i - 10]);
        unchecked((bufSig[i] = safeTanh((sum - 26.0) * (trend > 0.0 ? -0.7 : 0.7))));
      } else {
        unchecked((bufSig[i] = 0.0));
      }
    }
    lines = 1;
  }

  // 43: Chandelier Exit (p1=period 22, p2=mult 3.0)
  else if (id == 43) {
    const p = max<i32>(5, <i32>Math.round(p1));
    const mult = p2 > 0.5 ? p2 : 3.0;
    computeATRInto(p, bufTmpA);
    let dir: f64 = 1.0;
    for (let i = p - 1; i < N; i++) {
      let hh = unchecked(bufHigh[i]); let ll = unchecked(bufLow[i]);
      for (let j = i - p + 1; j <= i; j++) {
        if (unchecked(bufHigh[j]) > hh) hh = unchecked(bufHigh[j]);
        if (unchecked(bufLow[j]) < ll) ll = unchecked(bufLow[j]);
      }
      const atr = unchecked(bufTmpA[i]);
      const longStop = hh - mult * atr;
      const shortStop = ll + mult * atr;
      const c = unchecked(bufClose[i]);
      if (dir > 0.0 && c < longStop) dir = -1.0;
      else if (dir < 0.0 && c > shortStop) dir = 1.0;
      const line = dir > 0.0 ? longStop : shortStop;
      unchecked((bufOut0[i] = line));
      unchecked((bufOut1[i] = dir));
      unchecked((bufSig[i] = dir * (0.55 + 0.45 * safeTanh(Math.abs(c - line) / (atrScale(i) * 2.4)))));
    }
    lines = 2;
  }

  // 44: ATR Trailing Stop (p1=period 14, p2=mult 2.5)
  else if (id == 44) {
    const p = max<i32>(3, <i32>Math.round(p1));
    const mult = p2 > 0.5 ? p2 : 2.5;
    computeATRInto(p, bufTmpA);
    let stop: f64 = unchecked(bufClose[0]);
    let dir: f64 = 1.0;
    for (let i = 1; i < N; i++) {
      const c = unchecked(bufClose[i]);
      const nLoss = mult * unchecked(bufTmpA[i]);
      if (dir > 0.0) {
        if (c < stop) { dir = -1.0; stop = c + nLoss; }
        else { stop = Math.max(stop, c - nLoss); }
      } else {
        if (c > stop) { dir = 1.0; stop = c - nLoss; }
        else { stop = Math.min(stop, c + nLoss); }
      }
      if (i >= p) {
        unchecked((bufOut0[i] = stop));
        unchecked((bufOut1[i] = dir));
        unchecked((bufSig[i] = dir * (0.55 + 0.45 * safeTanh(Math.abs(c - stop) / (atrScale(i) * 2.2)))));
      }
    }
    lines = 2;
  }

  // 45: Standard Error Bands (Linear Regression ± k * StdErr) (p1=period 21, p2=mult 2.0)
  else if (id == 45) {
    const p = max<i32>(5, <i32>Math.round(p1));
    const mult = p2 > 0.2 ? p2 : 2.0;
    const pf = <f64>p;
    const xMean = (pf - 1.0) * 0.5;
    let xVar: f64 = 0.0;
    for (let j = 0; j < p; j++) { const dx = <f64>j - xMean; xVar += dx * dx; }
    for (let i = p - 1; i < N; i++) {
      let ySum: f64 = 0.0;
      for (let j = 0; j < p; j++) ySum += unchecked(bufClose[i - p + 1 + j]);
      const yMean = ySum / pf;
      let cov: f64 = 0.0;
      for (let j = 0; j < p; j++) cov += (<f64>j - xMean) * (unchecked(bufClose[i - p + 1 + j]) - yMean);
      const slope = cov / xVar;
      const intercept = yMean - slope * xMean;
      let sse: f64 = 0.0;
      for (let j = 0; j < p; j++) {
        const err = unchecked(bufClose[i - p + 1 + j]) - (intercept + slope * <f64>j);
        sse += err * err;
      }
      const se = Math.sqrt(sse / Math.max(1.0, pf - 2.0));
      const mid = intercept + slope * (pf - 1.0);
      const up = mid + mult * se;
      const lo = mid - mult * se;
      unchecked((bufOut0[i] = mid));
      unchecked((bufOut1[i] = up));
      unchecked((bufOut2[i] = lo));
      const pos = se > 1e-9 ? (mid - unchecked(bufClose[i])) / (mult * se) : 0.0;
      unchecked((bufSig[i] = safeTanh(pos * 1.15)));
    }
    lines = 3;
  }

  // ===================== VOLUME & MICROSTRUCTURE (46..55) =====================

  // 46: Rolling VWAP (±1σ)
  else if (id == 46) {
    const p = max<i32>(2, <i32>Math.round(p1));
    for (let i = 0; i < N; i++) {
      const start = i - p + 1 > 0 ? i - p + 1 : 0;
      let pv: f64 = 0.0; let vSum: f64 = 0.0;
      for (let j = start; j <= i; j++) {
        const tp = (unchecked(bufHigh[j]) + unchecked(bufLow[j]) + unchecked(bufClose[j])) / 3.0;
        const vol = unchecked(bufVolume[j]) > 0.0 ? unchecked(bufVolume[j]) : 1.0;
        pv += tp * vol; vSum += vol;
      }
      const vwap = vSum > 0.0 ? pv / vSum : unchecked(bufClose[i]);
      let varAcc: f64 = 0.0;
      for (let j = start; j <= i; j++) {
        const tp = (unchecked(bufHigh[j]) + unchecked(bufLow[j]) + unchecked(bufClose[j])) / 3.0;
        const vol = unchecked(bufVolume[j]) > 0.0 ? unchecked(bufVolume[j]) : 1.0;
        const d = tp - vwap;
        varAcc += d * d * vol;
      }
      const sd = Math.sqrt(varAcc / (vSum > 0.0 ? vSum : 1.0));
      unchecked((bufOut0[i] = vwap));
      unchecked((bufOut1[i] = vwap + sd));
      unchecked((bufOut2[i] = vwap - sd));
      if (i >= p - 1) {
        const denom = sd > 1e-8 ? sd * 1.6 : atrScale(i) * 1.6;
        unchecked((bufSig[i] = safeTanh((unchecked(bufClose[i]) - vwap) / denom)));
      }
    }
    lines = 3;
  }

  // 47: OBV Trend
  else if (id == 47) {
    const fast = max<i32>(2, <i32>Math.round(p1));
    const slow = max<i32>(fast + 1, <i32>Math.round(p2));
    let obv: f64 = 0.0;
    unchecked((bufOut0[0] = 0.0));
    for (let i = 1; i < N; i++) {
      if (unchecked(bufClose[i]) > unchecked(bufClose[i - 1])) obv += unchecked(bufVolume[i]);
      else if (unchecked(bufClose[i]) < unchecked(bufClose[i - 1])) obv -= unchecked(bufVolume[i]);
      unchecked((bufOut0[i] = obv));
    }
    computeEMAInto(bufOut0, fast, bufOut1);
    computeEMAInto(bufOut0, slow, bufOut2);
    for (let i = slow; i < N; i++) {
      let vSum: f64 = 0.0;
      for (let j = i - slow + 1; j <= i; j++) vSum += unchecked(bufVolume[j]);
      const avgV = vSum / <f64>slow;
      unchecked((bufSig[i] = safeTanh((unchecked(bufOut1[i]) - unchecked(bufOut2[i])) / (avgV * 2.5 + 1.0))));
    }
    lines = 3;
  }

  // 48: Chaikin Money Flow (CMF)
  else if (id == 48) {
    const p = max<i32>(2, <i32>Math.round(p1));
    for (let i = p - 1; i < N; i++) {
      let mfvSum: f64 = 0.0; let vSum: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) {
        const h = unchecked(bufHigh[j]); const l = unchecked(bufLow[j]); const c = unchecked(bufClose[j]);
        const vol = unchecked(bufVolume[j]); const range = h - l;
        const mfm = range > 1e-12 ? ((c - l) - (h - c)) / range : 0.0;
        mfvSum += mfm * vol; vSum += vol;
      }
      const cmf = vSum > 1e-12 ? mfvSum / vSum : 0.0;
      unchecked((bufOut0[i] = cmf));
      unchecked((bufSig[i] = safeTanh(cmf * 4.5)));
    }
    lines = 1;
  }

  // 49: Accumulation/Distribution Line (ADL Trend) (p1=fast 10, p2=slow 30)
  else if (id == 49) {
    const fast = max<i32>(2, <i32>Math.round(p1));
    const slow = max<i32>(fast + 1, <i32>Math.round(p2));
    let adl: f64 = 0.0;
    for (let i = 0; i < N; i++) {
      const h = unchecked(bufHigh[i]); const l = unchecked(bufLow[i]); const c = unchecked(bufClose[i]);
      const mfm = h - l > 1e-12 ? ((c - l) - (h - c)) / (h - l) : 0.0;
      adl += mfm * unchecked(bufVolume[i]);
      unchecked((bufOut0[i] = adl));
    }
    computeEMAInto(bufOut0, fast, bufOut1);
    computeEMAInto(bufOut0, slow, bufOut2);
    for (let i = slow; i < N; i++) {
      let vSum: f64 = 0.0;
      for (let j = i - slow + 1; j <= i; j++) vSum += unchecked(bufVolume[j]);
      const avgV = vSum / <f64>slow;
      unchecked((bufSig[i] = safeTanh((unchecked(bufOut1[i]) - unchecked(bufOut2[i])) / (avgV * 2.0 + 1.0))));
    }
    lines = 3;
  }

  // 50: Chaikin Oscillator (ADL EMA3 - EMA10) (p1=fast 3, p2=slow 10)
  else if (id == 50) {
    const fast = max<i32>(2, <i32>Math.round(p1));
    const slow = max<i32>(fast + 1, <i32>Math.round(p2));
    let adl: f64 = 0.0;
    for (let i = 0; i < N; i++) {
      const h = unchecked(bufHigh[i]); const l = unchecked(bufLow[i]); const c = unchecked(bufClose[i]);
      const mfm = h - l > 1e-12 ? ((c - l) - (h - c)) / (h - l) : 0.0;
      adl += mfm * unchecked(bufVolume[i]);
      unchecked((bufTmpA[i] = adl));
    }
    computeEMAInto(bufTmpA, fast, bufTmpB);
    computeEMAInto(bufTmpA, slow, bufTmpC);
    for (let i = slow; i < N; i++) {
      const co = unchecked(bufTmpB[i]) - unchecked(bufTmpC[i]);
      unchecked((bufOut0[i] = co));
      let vSum: f64 = 0.0;
      for (let j = i - slow + 1; j <= i; j++) vSum += unchecked(bufVolume[j]);
      const avgV = vSum / <f64>slow;
      unchecked((bufSig[i] = safeTanh(co / (avgV * 1.1 + 1.0))));
    }
    lines = 1;
  }

  // 51: Elder Force Index (p1=emaPeriod 13)
  else if (id == 51) {
    const p = max<i32>(2, <i32>Math.round(p1));
    unchecked((bufTmpA[0] = 0.0));
    for (let i = 1; i < N; i++) {
      unchecked((bufTmpA[i] = (unchecked(bufClose[i]) - unchecked(bufClose[i - 1])) * unchecked(bufVolume[i])));
    }
    computeEMAInto(bufTmpA, p, bufOut0);
    for (let i = p; i < N; i++) {
      const fi = unchecked(bufOut0[i]);
      if (isNaN(fi)) continue;
      let vSum: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) vSum += unchecked(bufVolume[j]);
      const scale = atrScale(i) * (vSum / <f64>p) * 0.45 + 1.0;
      unchecked((bufSig[i] = safeTanh(fi / scale)));
    }
    lines = 1;
  }

  // 52: Ease of Movement (EMV) (p1=period 14)
  else if (id == 52) {
    const p = max<i32>(2, <i32>Math.round(p1));
    unchecked((bufTmpA[0] = 0.0));
    for (let i = 1; i < N; i++) {
      const dm = (unchecked(bufHigh[i]) + unchecked(bufLow[i])) * 0.5 - (unchecked(bufHigh[i - 1]) + unchecked(bufLow[i - 1])) * 0.5;
      const hl = Math.max(1e-9, unchecked(bufHigh[i]) - unchecked(bufLow[i]));
      const vol = Math.max(1.0, unchecked(bufVolume[i]));
      const boxRatio = (vol / 1e7) / hl;
      unchecked((bufTmpA[i] = boxRatio > 1e-12 ? dm / boxRatio : 0.0));
    }
    computeSMAInto(bufTmpA, p, bufOut0);
    for (let i = p; i < N; i++) {
      const emv = unchecked(bufOut0[i]);
      if (isNaN(emv)) continue;
      // Scale by rolling MAD
      let mad: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) mad += Math.abs(unchecked(bufTmpA[j]));
      const norm = mad / <f64>p + 1e-9;
      unchecked((bufSig[i] = safeTanh(emv / (norm * 0.65))));
    }
    lines = 1;
  }

  // 53: Volume Price Trend (VPT) (p1=fast 8, p2=slow 21)
  else if (id == 53) {
    const fast = max<i32>(2, <i32>Math.round(p1));
    const slow = max<i32>(fast + 1, <i32>Math.round(p2));
    let vpt: f64 = 0.0;
    unchecked((bufOut0[0] = 0.0));
    for (let i = 1; i < N; i++) {
      const pc = Math.max(1e-9, unchecked(bufClose[i - 1]));
      vpt += unchecked(bufVolume[i]) * ((unchecked(bufClose[i]) - pc) / pc);
      unchecked((bufOut0[i] = vpt));
    }
    computeEMAInto(bufOut0, fast, bufOut1);
    computeEMAInto(bufOut0, slow, bufOut2);
    for (let i = slow; i < N; i++) {
      let vSum: f64 = 0.0;
      for (let j = i - slow + 1; j <= i; j++) vSum += unchecked(bufVolume[j]);
      const scale = (vSum / <f64>slow) * 0.06 + 1.0;
      unchecked((bufSig[i] = safeTanh((unchecked(bufOut1[i]) - unchecked(bufOut2[i])) / scale)));
    }
    lines = 3;
  }

  // 54: Klinger Volume Oscillator (KVO) (p1=fast 34, p2=slow 55, p3=sig 13)
  else if (id == 54) {
    const fast = max<i32>(5, <i32>Math.round(p1));
    const slow = max<i32>(fast + 2, <i32>Math.round(p2));
    const sigP = max<i32>(2, <i32>Math.round(p3));
    let prevTrend: f64 = 1.0;
    let cm: f64 = 0.0;
    unchecked((bufTmpA[0] = 0.0));
    for (let i = 1; i < N; i++) {
      const hlc = unchecked(bufHigh[i]) + unchecked(bufLow[i]) + unchecked(bufClose[i]);
      const phlc = unchecked(bufHigh[i - 1]) + unchecked(bufLow[i - 1]) + unchecked(bufClose[i - 1]);
      const trend: f64 = hlc > phlc ? 1.0 : -1.0;
      const dm = Math.max(1e-9, unchecked(bufHigh[i]) - unchecked(bufLow[i]));
      const pdm = Math.max(1e-9, unchecked(bufHigh[i - 1]) - unchecked(bufLow[i - 1]));
      cm = trend == prevTrend ? cm + dm : pdm + dm;
      prevTrend = trend;
      const vf = unchecked(bufVolume[i]) * Math.abs(2.0 * (dm / Math.max(1e-9, cm) - 1.0)) * trend * 100.0;
      unchecked((bufTmpA[i] = vf));
    }
    computeEMAInto(bufTmpA, fast, bufTmpB);
    computeEMAInto(bufTmpA, slow, bufTmpC);
    for (let i = 0; i < N; i++) {
      const a = unchecked(bufTmpB[i]); const b = unchecked(bufTmpC[i]);
      unchecked((bufOut0[i] = isNaN(a) || isNaN(b) ? NaN : a - b));
    }
    computeEMAInto(bufOut0, sigP, bufOut1);
    for (let i = slow; i < N; i++) {
      const kvo = unchecked(bufOut0[i]); const sigL = unchecked(bufOut1[i]);
      if (isNaN(kvo)) continue;
      let vSum: f64 = 0.0;
      for (let j = i - 20; j <= i; j++) if (j >= 0) vSum += unchecked(bufVolume[j]);
      const scale = (vSum / 21.0) * 18.0 + 1.0;
      const cross = isNaN(sigL) ? 0.0 : (kvo - sigL) / (scale * 0.4);
      unchecked((bufSig[i] = safeTanh((kvo / scale) * 0.65 + cross * 0.35)));
    }
    lines = 2;
  }

  // 55: Relative Volume Surge (Vol Z-Score x Direction) (p1=window 20)
  else if (id == 55) {
    const p = max<i32>(5, <i32>Math.round(p1));
    for (let i = p - 1; i < N; i++) {
      let sum: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) sum += unchecked(bufVolume[j]);
      const mean = sum / <f64>p;
      let vs: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) { const d = unchecked(bufVolume[j]) - mean; vs += d * d; }
      const sd = Math.sqrt(vs / <f64>p);
      const z = sd > 1e-6 ? clamp((unchecked(bufVolume[i]) - mean) / sd, -3.0, 4.0) : 0.0;
      unchecked((bufOut0[i] = z));
      const barDir = unchecked(bufClose[i]) >= unchecked(bufOpen[i]) ? 1.0 : -1.0;
      const intensity = clamp((z + 0.5) / 2.2, 0.0, 1.0);
      unchecked((bufSig[i] = barDir * intensity));
    }
    lines = 1;
  }

  // ===================== STATISTICAL & MARKET STRUCTURE (56..61) =====================

  // 56: Price Z-Score Mean Reversion (p1=window 20, p2=zBand 2.0)
  else if (id == 56) {
    const p = max<i32>(5, <i32>Math.round(p1));
    const zBand = p2 > 0.5 ? p2 : 2.0;
    for (let i = p - 1; i < N; i++) {
      let sum: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) sum += unchecked(bufClose[j]);
      const mean = sum / <f64>p;
      let vs: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) { const d = unchecked(bufClose[j]) - mean; vs += d * d; }
      const sd = Math.sqrt(vs / <f64>p);
      const z = sd > 1e-12 ? (unchecked(bufClose[i]) - mean) / sd : 0.0;
      unchecked((bufOut0[i] = z));
      unchecked((bufSig[i] = safeTanh(-z / zBand)));
    }
    lines = 1;
  }

  // 57: Kaufman Efficiency Ratio (ER — Trend Purity vs Chop) (p1=period 14)
  else if (id == 57) {
    const p = max<i32>(3, <i32>Math.round(p1));
    for (let i = p; i < N; i++) {
      const net = unchecked(bufClose[i]) - unchecked(bufClose[i - p]);
      let pathLen: f64 = 0.0;
      for (let j = i - p + 1; j <= i; j++) pathLen += Math.abs(unchecked(bufClose[j]) - unchecked(bufClose[j - 1]));
      const er = pathLen > 1e-12 ? Math.abs(net) / pathLen : 0.0;
      unchecked((bufOut0[i] = er * 100.0));
      const dir: f64 = net >= 0.0 ? 1.0 : -1.0;
      unchecked((bufSig[i] = dir * safeTanh(er * 2.2)));
    }
    lines = 1;
  }

  // 58: Rolling Percentile Rank (p1=window 50)
  else if (id == 58) {
    const p = max<i32>(5, <i32>Math.round(p1));
    for (let i = p - 1; i < N; i++) {
      const cur = unchecked(bufClose[i]);
      let below: i32 = 0;
      for (let j = i - p + 1; j <= i; j++) if (unchecked(bufClose[j]) <= cur) below++;
      const pct = (100.0 * <f64>below) / <f64>p;
      unchecked((bufOut0[i] = pct));
      // Default: trend strength near highs (+1) / lows (-1); invert for mean reversion!
      unchecked((bufSig[i] = clamp((pct - 50.0) / 45.0, -1.0, 1.0)));
    }
    lines = 1;
  }

  // 59: Rolling Pivot Point S/R Structure (p1=window 20)
  else if (id == 59) {
    const p = max<i32>(5, <i32>Math.round(p1));
    for (let i = p; i < N; i++) {
      let hh = unchecked(bufHigh[i - p]); let ll = unchecked(bufLow[i - p]);
      for (let j = i - p; j < i; j++) {
        if (unchecked(bufHigh[j]) > hh) hh = unchecked(bufHigh[j]);
        if (unchecked(bufLow[j]) < ll) ll = unchecked(bufLow[j]);
      }
      const pc = unchecked(bufClose[i - 1]);
      const pp = (hh + ll + pc) / 3.0;
      const r1 = 2.0 * pp - ll;
      const s1 = 2.0 * pp - hh;
      unchecked((bufOut0[i] = pp));
      unchecked((bufOut1[i] = r1));
      unchecked((bufOut2[i] = s1));
      const half = Math.max(atrScale(i), (r1 - s1) * 0.5);
      unchecked((bufSig[i] = safeTanh((unchecked(bufClose[i]) - pp) / half)));
    }
    lines = 3;
  }

  // 60: Heikin-Ashi Streak Momentum (p1=streakScale 5)
  else if (id == 60) {
    const sc = p1 > 1.0 ? p1 : 5.0;
    let haO = (unchecked(bufOpen[0]) + unchecked(bufClose[0])) * 0.5;
    let streak: f64 = 0.0;
    for (let i = 0; i < N; i++) {
      const haC = (unchecked(bufOpen[i]) + unchecked(bufHigh[i]) + unchecked(bufLow[i]) + unchecked(bufClose[i])) * 0.25;
      if (i > 0) haO = (haO + unchecked(bufTmpA[i - 1])) * 0.5;
      unchecked((bufTmpA[i] = haC));
      if (haC > haO) streak = streak > 0.0 ? streak + 1.0 : 1.0;
      else if (haC < haO) streak = streak < 0.0 ? streak - 1.0 : -1.0;
      unchecked((bufOut0[i] = streak));
      unchecked((bufSig[i] = safeTanh(streak / sc)));
    }
    lines = 1;
  }

  // 61: Candle Body / Wick Imbalance Pressure (p1=emaSmooth 5)
  else if (id == 61) {
    const p = max<i32>(2, <i32>Math.round(p1));
    for (let i = 0; i < N; i++) {
      const h = unchecked(bufHigh[i]); const l = unchecked(bufLow[i]);
      const o = unchecked(bufOpen[i]); const c = unchecked(bufClose[i]);
      const rng = h - l;
      if (rng > 1e-12) {
        const body = (c - o) / rng; // -1..+1
        const lowerWick = (Math.min(o, c) - l) / rng; // buying rejection
        const upperWick = (h - Math.max(o, c)) / rng; // selling rejection
        unchecked((bufTmpA[i] = clamp(body * 0.7 + (lowerWick - upperWick) * 0.5, -1.0, 1.0)));
      } else {
        unchecked((bufTmpA[i] = 0.0));
      }
    }
    computeEMAInto(bufTmpA, p, bufOut0);
    for (let i = p; i < N; i++) {
      const v = unchecked(bufOut0[i]);
      if (!isNaN(v)) unchecked((bufSig[i] = safeTanh(v * 2.2)));
    }
    lines = 1;
  }

  // Apply optional Invert flag
  if (invert != 0) {
    for (let i = 0; i < N; i++) {
      unchecked((bufSig[i] = -unchecked(bufSig[i])));
    }
  }

  return lines;
}

// ============================================================================
// COMPOSITE STRATEGY ENGINE
// ============================================================================
export function resetComposite(): void {
  for (let i = 0; i < N; i++) {
    unchecked((bufCompNum[i] = 0.0));
    unchecked((bufCompDen[i] = 0.0));
    unchecked((bufVetoBull[i] = 1.0));
    unchecked((bufVetoBear[i] = 1.0));
    unchecked((bufScore[i] = 0.0));
  }
}

export function accumulateRule(
  weight: f64,
  mode: i32,
  triggerThresh: f64,
  vetoThresh: f64
): void {
  if (weight <= 0.0) return;
  const tTh = clamp(triggerThresh, 0.05, 0.95);
  const vTh = clamp(vetoThresh, 0.0, 0.9);

  if (mode == 2) {
    for (let i = 0; i < N; i++) {
      const s = unchecked(bufSig[i]);
      if (s < -vTh) {
        const factor = clamp(1.0 - Math.abs(s) * Math.min(1.0, weight * 0.45), 0.15, 1.0);
        unchecked((bufVetoBull[i] = unchecked(bufVetoBull[i]) * factor));
      } else if (s > vTh) {
        const factor = clamp(1.0 - Math.abs(s) * Math.min(1.0, weight * 0.45), 0.15, 1.0);
        unchecked((bufVetoBear[i] = unchecked(bufVetoBear[i]) * factor));
      }
    }
    return;
  }

  for (let i = 0; i < N; i++) {
    let s = unchecked(bufSig[i]);
    if (mode == 1) {
      if (s >= tTh) s = 1.0;
      else if (s <= -tTh) s = -1.0;
      else s = 0.0;
    }
    unchecked((bufCompNum[i] = unchecked(bufCompNum[i]) + s * weight));
    unchecked((bufCompDen[i] = unchecked(bufCompDen[i]) + weight));
  }
}

export function finalizeComposite(): void {
  for (let i = 0; i < N; i++) {
    const den = unchecked(bufCompDen[i]);
    if (den <= 1e-12) {
      unchecked((bufScore[i] = 0.0));
      continue;
    }
    let raw = unchecked(bufCompNum[i]) / den;
    if (raw > 0.0) raw *= unchecked(bufVetoBull[i]);
    else if (raw < 0.0) raw *= unchecked(bufVetoBear[i]);
    unchecked((bufScore[i] = clamp(raw * 100.0, -100.0, 100.0)));
  }
}

// ============================================================================
// EVENT-DRIVEN BACKTESTER (Next-Bar Open Execution — Zero Look-Ahead Bias)
// Exact fee/slippage accounting + 70/30 In-Sample / Out-of-Sample split metrics
// ============================================================================
function executeBacktestSlice(
  startBar: i32,
  endBar: i32,
  buyThresh: f64,
  sellThresh: f64,
  allowShort: i32,
  initialCapital: f64,
  positionPct: f64,
  stopLossPct: f64,
  takeProfitPct: f64,
  commissionBps: f64,
  slippageBps: f64,
  barsPerYear: f64,
  recordSeries: bool,
  outOffset: i32
): void {
  const s0 = startBar < 0 ? 0 : startBar;
  const e0 = endBar > N ? N : endBar;
  const len = e0 - s0;
  if (len <= 1) {
    for (let k = 0; k < 12 && outOffset + k < 16; k++) unchecked((bufMetrics[outOffset + k] = 0.0));
    if (recordSeries) lastTradeCount = 0;
    return;
  }

  const cap0 = initialCapital > 100.0 ? initialCapital : 100000.0;
  const posFrac = clamp(positionPct / 100.0, 0.05, 1.0);
  const slFrac = stopLossPct > 0.0 ? stopLossPct / 100.0 : 0.0;
  const tpFrac = takeProfitPct > 0.0 ? takeProfitPct / 100.0 : 0.0;
  const feeRate = Math.max(0.0, commissionBps) / 10000.0;
  const slipRate = Math.max(0.0, slippageBps) / 10000.0;
  const ann = barsPerYear > 10.0 ? barsPerYear : 252.0;

  let cash: f64 = cap0;
  let pos: i32 = 0;
  let shares: f64 = 0.0;
  let entryPrice: f64 = 0.0;
  let entryIdx: i32 = s0;
  let entryAlloc: f64 = 0.0;
  let entryNetCap: f64 = 0.0;
  let entryFeePaid: f64 = 0.0;
  let eqAtEntry: f64 = cap0;
  let pendingOrder: i32 = 0;

  let peakEq: f64 = cap0;
  let maxDD: f64 = 0.0;
  let prevEq: f64 = cap0;

  let retSum: f64 = 0.0;
  let retSqSum: f64 = 0.0;
  let negSqSum: f64 = 0.0;
  let retCount: i32 = 0;
  let exposedBars: i32 = 0;

  let trades: i32 = 0;
  let wins: i32 = 0;
  let grossProfit: f64 = 0.0;
  let grossLoss: f64 = 0.0;
  let sumTradeRet: f64 = 0.0;

  const firstClose = unchecked(bufClose[s0]);

  for (let i = s0; i < e0; i++) {
    const o = unchecked(bufOpen[i]);
    const h = unchecked(bufHigh[i]);
    const l = unchecked(bufLow[i]);
    const c = unchecked(bufClose[i]);

    // 1. Execute pending signal at THIS bar's Open
    if (pendingOrder != 0) {
      if (pos != 0 && (pendingOrder == 2 || pendingOrder != pos)) {
        const fillExit = pos > 0 ? o * (1.0 - slipRate) : o * (1.0 + slipRate);
        const exitFee = Math.abs(shares * fillExit) * feeRate;
        const grossPnl = pos > 0 ? (fillExit - entryPrice) * shares : (entryPrice - fillExit) * shares;
        // Exact cash restoration: entryAlloc was deducted on open, entryFeePaid was spent, so remaining locked capital is entryNetCap
        cash += entryNetCap + grossPnl - exitFee;
        const netPnl = grossPnl - entryFeePaid - exitFee;
        const portRetPct = eqAtEntry > 1e-8 ? (netPnl / eqAtEntry) * 100.0 : 0.0;

        if (netPnl > 0.0) { wins++; grossProfit += netPnl; }
        else { grossLoss += Math.abs(netPnl); }
        sumTradeRet += portRetPct;

        if (recordSeries && trades < MAX_TRADES) {
          const base = trades * TRADE_STRIDE;
          unchecked((bufTrades[base] = <f64>entryIdx));
          unchecked((bufTrades[base + 1] = <f64>i));
          unchecked((bufTrades[base + 2] = <f64>pos));
          unchecked((bufTrades[base + 3] = entryPrice));
          unchecked((bufTrades[base + 4] = fillExit));
          unchecked((bufTrades[base + 5] = netPnl));
          unchecked((bufTrades[base + 6] = portRetPct));
          unchecked((bufTrades[base + 7] = 0.0));
        }
        trades++;
        pos = 0; shares = 0.0; entryAlloc = 0.0; entryNetCap = 0.0; entryFeePaid = 0.0;
      }

      if (pos == 0 && (pendingOrder == 1 || (pendingOrder == -1 && allowShort != 0))) {
        const alloc = cash * posFrac;
        if (alloc > 10.0 && o > 1e-8) {
          const fillEntry = pendingOrder > 0 ? o * (1.0 + slipRate) : o * (1.0 - slipRate);
          const entryFee = alloc * feeRate;
          const netCap = alloc - entryFee;
          eqAtEntry = cash;
          shares = netCap / fillEntry;
          entryPrice = fillEntry;
          entryIdx = i;
          entryAlloc = alloc;
          entryNetCap = netCap;
          entryFeePaid = entryFee;
          cash -= alloc;
          pos = pendingOrder;
        }
      }
      pendingOrder = 0;
    }

    // 2. Check intrabar Stop-Loss / Take-Profit
    if (pos != 0 && (slFrac > 0.0 || tpFrac > 0.0)) {
      let triggered: i32 = 0;
      let exitPx: f64 = c;
      if (pos > 0) {
        const slPx = slFrac > 0.0 ? entryPrice * (1.0 - slFrac) : -1.0;
        const tpPx = tpFrac > 0.0 ? entryPrice * (1.0 + tpFrac) : 1e18;
        if (slFrac > 0.0 && l <= slPx) { triggered = 1; exitPx = Math.min(o, slPx) * (1.0 - slipRate); }
        else if (tpFrac > 0.0 && h >= tpPx) { triggered = 2; exitPx = Math.max(o, tpPx) * (1.0 - slipRate); }
      } else {
        const slPx = slFrac > 0.0 ? entryPrice * (1.0 + slFrac) : 1e18;
        const tpPx = tpFrac > 0.0 ? entryPrice * (1.0 - tpFrac) : -1.0;
        if (slFrac > 0.0 && h >= slPx) { triggered = 1; exitPx = Math.max(o, slPx) * (1.0 + slipRate); }
        else if (tpFrac > 0.0 && l <= tpPx) { triggered = 2; exitPx = Math.min(o, tpPx) * (1.0 + slipRate); }
      }

      if (triggered != 0) {
        const exitFee = Math.abs(shares * exitPx) * feeRate;
        const grossPnl = pos > 0 ? (exitPx - entryPrice) * shares : (entryPrice - exitPx) * shares;
        cash += entryNetCap + grossPnl - exitFee;
        const netPnl = grossPnl - entryFeePaid - exitFee;
        const portRetPct = eqAtEntry > 1e-8 ? (netPnl / eqAtEntry) * 100.0 : 0.0;
        if (netPnl > 0.0) { wins++; grossProfit += netPnl; }
        else { grossLoss += Math.abs(netPnl); }
        sumTradeRet += portRetPct;
        if (recordSeries && trades < MAX_TRADES) {
          const base = trades * TRADE_STRIDE;
          unchecked((bufTrades[base] = <f64>entryIdx));
          unchecked((bufTrades[base + 1] = <f64>i));
          unchecked((bufTrades[base + 2] = <f64>pos));
          unchecked((bufTrades[base + 3] = entryPrice));
          unchecked((bufTrades[base + 4] = exitPx));
          unchecked((bufTrades[base + 5] = netPnl));
          unchecked((bufTrades[base + 6] = portRetPct));
          unchecked((bufTrades[base + 7] = <f64>triggered));
        }
        trades++;
        pos = 0; shares = 0.0; entryAlloc = 0.0; entryNetCap = 0.0; entryFeePaid = 0.0;
      }
    }

    // 3. Mark-to-market equity (accurately reflects entryFeePaid from the moment of entry!)
    let eq = cash;
    if (pos != 0) {
      exposedBars++;
      const unreal = pos > 0 ? (c - entryPrice) * shares : (entryPrice - c) * shares;
      eq = cash + entryNetCap + unreal;
    }
    if (eq < 1.0) eq = 1.0;

    if (eq > peakEq) peakEq = eq;
    const dd = peakEq > 0.0 ? ((eq - peakEq) / peakEq) * 100.0 : 0.0;
    if (-dd > maxDD) maxDD = -dd;

    if (i > s0) {
      const r = (eq - prevEq) / prevEq;
      retSum += r;
      retSqSum += r * r;
      if (r < 0.0) negSqSum += r * r;
      retCount++;
    }
    prevEq = eq;

    if (recordSeries) {
      unchecked((bufEquity[i] = eq));
      unchecked((bufBhEquity[i] = cap0 * (c / firstClose)));
      unchecked((bufDrawdown[i] = dd));
    }

    if (i < e0 - 1) {
      const sc = unchecked(bufScore[i]);
      if (sc >= buyThresh) {
        if (pos != 1) pendingOrder = 1;
      } else if (sc <= sellThresh) {
        if (allowShort != 0) { if (pos != -1) pendingOrder = -1; }
        else if (pos == 1) pendingOrder = 2;
      }
    }
  }

  const totalRet = ((prevEq - cap0) / cap0) * 100.0;
  const bhRet = ((unchecked(bufClose[e0 - 1]) - firstClose) / firstClose) * 100.0;
  const years = Math.max(0.05, <f64>len / ann);
  const cagr = (Math.pow(Math.max(0.01, prevEq / cap0), 1.0 / years) - 1.0) * 100.0;

  let sharpe: f64 = 0.0;
  let sortino: f64 = 0.0;
  if (retCount > 2) {
    const mean = retSum / <f64>retCount;
    const sd = Math.sqrt(Math.max(0.0, retSqSum / <f64>retCount - mean * mean));
    if (sd > 1e-10) sharpe = (mean / sd) * Math.sqrt(ann);
    const downSd = Math.sqrt(negSqSum / <f64>retCount);
    if (downSd > 1e-10) sortino = (mean / downSd) * Math.sqrt(ann);
  }

  const winRate = trades > 0 ? (<f64>wins / <f64>trades) * 100.0 : 0.0;
  const profitFactor = grossLoss > 1e-8 ? grossProfit / grossLoss : grossProfit > 0.0 ? 9.99 : 0.0;
  const avgTrade = trades > 0 ? sumTradeRet / <f64>trades : 0.0;
  const exposure = (<f64>exposedBars / <f64>len) * 100.0;

  if (outOffset == 0) {
    unchecked((bufMetrics[0] = totalRet));
    unchecked((bufMetrics[1] = bhRet));
    unchecked((bufMetrics[2] = cagr));
    unchecked((bufMetrics[3] = sharpe));
    unchecked((bufMetrics[4] = sortino));
    unchecked((bufMetrics[5] = maxDD));
    unchecked((bufMetrics[6] = winRate));
    unchecked((bufMetrics[7] = Math.min(99.9, profitFactor)));
    unchecked((bufMetrics[8] = <f64>trades));
    unchecked((bufMetrics[9] = avgTrade));
    unchecked((bufMetrics[10] = exposure));
    unchecked((bufMetrics[11] = prevEq));
    if (recordSeries) lastTradeCount = trades < MAX_TRADES ? trades : MAX_TRADES;
  } else if (outOffset == 12) {
    // Held-out final 30% OOS summary: [oosReturnPct, oosSharpe, oosMaxDDPct, oosTrades]
    unchecked((bufMetrics[12] = totalRet));
    unchecked((bufMetrics[13] = sharpe));
    unchecked((bufMetrics[14] = maxDD));
    unchecked((bufMetrics[15] = <f64>trades));
  } else {
    // 70% Train In-Sample summary: [trainReturnPct, trainSharpe, trainMaxDDPct, trainTrades]
    unchecked((bufMetrics[16] = totalRet));
    unchecked((bufMetrics[17] = sharpe));
    unchecked((bufMetrics[18] = maxDD));
    unchecked((bufMetrics[19] = <f64>trades));
  }
}

export function runBacktest(
  buyThresh: f64,
  sellThresh: f64,
  allowShort: i32,
  initialCapital: f64,
  positionPct: f64,
  stopLossPct: f64,
  takeProfitPct: f64,
  commissionBps: f64,
  slippageBps: f64,
  barsPerYear: f64
): i32 {
  const splitIdx = <i32>(<f64>N * 0.7);
  executeBacktestSlice(0, N, buyThresh, sellThresh, allowShort, initialCapital, positionPct, stopLossPct, takeProfitPct, commissionBps, slippageBps, barsPerYear, true, 0);
  // Strictly separated 70% Train (16..19) and untouched final 30% Held-Out OOS (12..15)
  executeBacktestSlice(0, splitIdx, buyThresh, sellThresh, allowShort, initialCapital, positionPct, stopLossPct, takeProfitPct, commissionBps, slippageBps, barsPerYear, false, 16);
  executeBacktestSlice(splitIdx, N, buyThresh, sellThresh, allowShort, initialCapital, positionPct, stopLossPct, takeProfitPct, commissionBps, slippageBps, barsPerYear, false, 12);
  return lastTradeCount;
}

export function runBacktestRange(
  startBar: i32,
  endBar: i32,
  buyThresh: f64,
  sellThresh: f64,
  allowShort: i32,
  initialCapital: f64,
  positionPct: f64,
  stopLossPct: f64,
  takeProfitPct: f64,
  commissionBps: f64,
  slippageBps: f64,
  barsPerYear: f64
): f64 {
  executeBacktestSlice(startBar, endBar, buyThresh, sellThresh, allowShort, initialCapital, positionPct, stopLossPct, takeProfitPct, commissionBps, slippageBps, barsPerYear, false, 12);
  return unchecked(bufMetrics[13]);
}

// 2D Threshold Sweep strictly optimizes over the 70% TRAIN window [0..splitIdx) so the final 30% OOS stays 100% untouched!
export function runThresholdSweep(
  buyMin: f64,
  buyMax: f64,
  sellMin: f64,
  sellMax: f64,
  gridSize: i32,
  allowShort: i32,
  initialCapital: f64,
  positionPct: f64,
  stopLossPct: f64,
  takeProfitPct: f64,
  commissionBps: f64,
  slippageBps: f64,
  barsPerYear: f64
): i32 {
  const g = gridSize < 2 ? 2 : gridSize > 24 ? 24 : gridSize;
  const splitIdx = <i32>(<f64>N * 0.7);
  const buyStep = (buyMax - buyMin) / <f64>(g - 1);
  const sellStep = (sellMax - sellMin) / <f64>(g - 1);
  let idx: i32 = 0;
  for (let r = 0; r < g; r++) {
    const bT = buyMin + <f64>r * buyStep;
    for (let c = 0; c < g; c++) {
      const sT = sellMin + <f64>c * sellStep;
      executeBacktestSlice(0, splitIdx, bT, sT, allowShort, initialCapital, positionPct, stopLossPct, takeProfitPct, commissionBps, slippageBps, barsPerYear, false, 16);
      const base = idx * 4;
      unchecked((bufSweep[base] = unchecked(bufMetrics[17])));     // train sharpe
      unchecked((bufSweep[base + 1] = unchecked(bufMetrics[16]))); // train return %
      unchecked((bufSweep[base + 2] = unchecked(bufMetrics[18]))); // train max DD %
      unchecked((bufSweep[base + 3] = unchecked(bufMetrics[19]))); // train trades
      idx++;
    }
  }
  return g;
}

// ---- Monte Carlo Bootstrapper ----
let rngState: u32 = 0x13579bdf;
@inline
function nextRand(): u32 {
  let x = rngState;
  x ^= x << 13; x ^= x >> 17; x ^= x << 5;
  rngState = x;
  return x;
}

function quickSort(arr: Float64Array, lo: i32, hi: i32): void {
  if (lo >= hi) return;
  const pivot = unchecked(arr[(lo + hi) >> 1]);
  let i = lo; let j = hi;
  while (i <= j) {
    while (unchecked(arr[i]) < pivot) i++;
    while (unchecked(arr[j]) > pivot) j--;
    if (i <= j) {
      const tmp = unchecked(arr[i]);
      unchecked((arr[i] = unchecked(arr[j])));
      unchecked((arr[j] = tmp));
      i++; j--;
    }
  }
  if (lo < j) quickSort(arr, lo, j);
  if (i < hi) quickSort(arr, i, hi);
}

export function runMonteCarlo(iterations: i32, initialCapital: f64, seed: u32): i32 {
  const tCount = lastTradeCount;
  if (tCount < 2) { lastMcSteps = 0; return 0; }
  const iters = iterations < 50 ? 50 : iterations > 2000 ? 2000 : iterations;
  // Support full realized trade count up to 500 trades (bufTrades[base+6] is already portfolio-scaled return!)
  const steps = tCount > 500 ? 500 : tCount;
  rngState = seed == 0 ? 0x9e3779b9 : seed;

  const cap0 = initialCapital > 100.0 ? initialCapital : 100000.0;
  const tradeRets = new Float64Array(tCount);
  for (let i = 0; i < tCount; i++) unchecked((tradeRets[i] = unchecked(bufTrades[i * TRADE_STRIDE + 6]) / 100.0));

  const paths = new Float64Array((steps + 1) * iters);
  const maxDDs = new Float64Array(iters);
  const finals = new Float64Array(iters);
  let ruinCount: i32 = 0;

  for (let it = 0; it < iters; it++) {
    let eq = cap0; let pk = cap0; let mdd: f64 = 0.0;
    unchecked((paths[it] = eq));
    for (let s = 1; s <= steps; s++) {
      const pick = <i32>(nextRand() % <u32>tCount);
      eq = Math.max(1.0, eq * (1.0 + unchecked(tradeRets[pick])));
      if (eq > pk) pk = eq;
      const dd = (pk - eq) / pk;
      if (dd > mdd) mdd = dd;
      unchecked((paths[s * iters + it] = eq));
    }
    unchecked((maxDDs[it] = mdd * 100.0));
    unchecked((finals[it] = eq));
    if (eq < cap0 * 0.8) ruinCount++;
  }

  const col = new Float64Array(iters);
  const p5Idx = <i32>(<f64>(iters - 1) * 0.05);
  const p25Idx = <i32>(<f64>(iters - 1) * 0.25);
  const p50Idx = <i32>(<f64>(iters - 1) * 0.50);
  const p75Idx = <i32>(<f64>(iters - 1) * 0.75);
  const p95Idx = <i32>(<f64>(iters - 1) * 0.95);

  for (let s = 0; s <= steps; s++) {
    const rowBase = s * iters;
    for (let it = 0; it < iters; it++) unchecked((col[it] = unchecked(paths[rowBase + it])));
    quickSort(col, 0, iters - 1);
    const outBase = s * 5;
    unchecked((bufMc[outBase] = unchecked(col[p5Idx])));
    unchecked((bufMc[outBase + 1] = unchecked(col[p25Idx])));
    unchecked((bufMc[outBase + 2] = unchecked(col[p50Idx])));
    unchecked((bufMc[outBase + 3] = unchecked(col[p75Idx])));
    unchecked((bufMc[outBase + 4] = unchecked(col[p95Idx])));
  }

  quickSort(maxDDs, 0, iters - 1);
  quickSort(finals, 0, iters - 1);
  const metaOffset = (steps + 1) * 5;
  unchecked((bufMc[metaOffset] = unchecked(finals[p50Idx])));
  unchecked((bufMc[metaOffset + 1] = unchecked(finals[p5Idx])));
  unchecked((bufMc[metaOffset + 2] = unchecked(maxDDs[p95Idx])));
  unchecked((bufMc[metaOffset + 3] = (<f64>ruinCount / <f64>iters) * 100.0));

  lastMcSteps = steps + 1;
  return lastMcSteps;
}

// ---- Strictly Causal Walk-Forward Kalman + Regularized Logistic/Ridge Forecast Engine ----
// Zero look-ahead bias:
//   1. EWMA volatility is tracked causally at each bar t (never using future returns).
//   2. Predictions pUp[t] are frozen AT origin bar t before any label maturing after t is seen.
//   3. At bar t, we score the frozen prediction made at origin u = t - H, then update weights on u.
export function runWalkForwardForecast(horizon: i32, ridgeLambda: f64): i32 {
  const H = horizon < 1 ? 1 : horizon > 40 ? 40 : horizon;
  if (N < 70) return 0;

  const logC = new Float64Array(N);
  const logR = new Float64Array(N);
  const causalVol = new Float64Array(N);
  const kVel = new Float64Array(N);
  const rsiArr = new Float64Array(N);
  const bbArr = new Float64Array(N);
  const volZ = new Float64Array(N);

  let ewmaVar: f64 = 0.0002;
  for (let i = 0; i < N; i++) {
    const c = Math.max(1e-8, unchecked(bufClose[i]));
    unchecked((logC[i] = Math.log(c)));
    const r = i > 0 ? unchecked(logC[i]) - unchecked(logC[i - 1]) : 0.0;
    unchecked((logR[i] = r));
    if (i > 0) ewmaVar = 0.94 * ewmaVar + 0.06 * r * r;
    unchecked((causalVol[i] = Math.sqrt(Math.max(1e-8, ewmaVar))));
  }

  let x0 = unchecked(logC[0]); let x1: f64 = 0.0;
  let p00: f64 = 0.01; let p01: f64 = 0.0; let p10: f64 = 0.0; let p11: f64 = 0.001;
  for (let i = 0; i < N; i++) {
    const px0 = x0 + x1; const px1 = x1 * 0.96;
    const np00 = p00 + p10 + p01 + p11 + 0.00012;
    const np01 = (p01 + p11) * 0.96;
    const np10 = (p10 + p11) * 0.96;
    const np11 = p11 * 0.9216 + 0.000004;
    const y = unchecked(logC[i]) - px0;
    const s = np00 + 0.0008;
    const k0 = np00 / s; const k1 = np10 / s;
    x0 = px0 + k0 * y; x1 = px1 + k1 * y;
    p00 = (1.0 - k0) * np00; p01 = (1.0 - k0) * np01;
    p10 = np10 - k1 * np00; p11 = np11 - k1 * np01;
    unchecked((kVel[i] = x1));
  }

  computeRSIInto(14, rsiArr);
  for (let i = 0; i < 14 && i < N; i++) unchecked((rsiArr[i] = 50.0));

  for (let i = 20; i < N; i++) {
    let cs: f64 = 0.0; let vs: f64 = 0.0;
    for (let j = i - 19; j <= i; j++) { cs += unchecked(bufClose[j]); vs += unchecked(bufVolume[j]); }
    const cm = cs / 20.0; const vm = vs / 20.0;
    let cv: f64 = 0.0; let vv: f64 = 0.0;
    for (let j = i - 19; j <= i; j++) {
      const dc = unchecked(bufClose[j]) - cm; const dv = unchecked(bufVolume[j]) - vm;
      cv += dc * dc; vv += dv * dv;
    }
    const csd = Math.sqrt(cv / 20.0); const vsd = Math.sqrt(vv / 20.0);
    unchecked((bbArr[i] = csd > 1e-8 ? clamp((unchecked(bufClose[i]) - cm) / (2.0 * csd), -2.5, 2.5) : 0.0));
    unchecked((volZ[i] = vsd > 1e-8 ? clamp((unchecked(bufVolume[i]) - vm) / vsd, -3.0, 3.0) : 0.0));
  }

  const FEAT: i32 = 8;
  const featMat = new Float64Array(N * FEAT);
  for (let i = 0; i < N; i++) unchecked((bufFrozenPUp[i] = NaN));
  const wLog = new Float64Array(FEAT);
  const wReg = new Float64Array(FEAT);
  let bLog: f64 = 0.0; let bReg: f64 = 0.0;

  const lam = clamp(ridgeLambda, 0.0005, 0.5);
  let oosCorrect: i32 = 0; let oosTotal: i32 = 0; let brierSum: f64 = 0.0;
  const startIdx: i32 = 45;
  const evalWarmup: i32 = 65;

  for (let t = startIdx; t < N; t++) {
    // Step 1: Build causal feature vector at bar t using ONLY vol available at bar t
    const vt = unchecked(causalVol[t]);
    const r5 = unchecked(logC[t]) - unchecked(logC[t - 5]);
    const r20 = unchecked(logC[t]) - unchecked(logC[t - 20]);
    const atrNow = unchecked(bufAtrBase[t]); const atrPast = unchecked(bufAtrBase[t - 20]);
    const volRatio = atrPast > 1e-8 ? clamp(atrNow / atrPast - 1.0, -1.5, 1.5) : 0.0;

    const fb = t * FEAT;
    unchecked((featMat[fb] = clamp(r5 / (vt * 2.5 + 1e-6), -3.0, 3.0)));
    unchecked((featMat[fb + 1] = clamp(r20 / (vt * 5.0 + 1e-6), -3.0, 3.0)));
    unchecked((featMat[fb + 2] = (unchecked(rsiArr[t]) - 50.0) / 25.0));
    unchecked((featMat[fb + 3] = volRatio));
    unchecked((featMat[fb + 4] = unchecked(bbArr[t])));
    unchecked((featMat[fb + 5] = unchecked(volZ[t]) * 0.5));
    unchecked((featMat[fb + 6] = clamp(unchecked(kVel[t]) / (vt + 1e-6), -3.0, 3.0)));
    unchecked((featMat[fb + 7] = unchecked(bufScore[t]) / 50.0));

    // Step 2: Mature label for past origin u = t - H is NOW observable at bar t
    if (t >= startIdx + H) {
      const u = t - H;
      const ub = u * FEAT;
      const vu = unchecked(causalVol[u]);
      const futRet = unchecked(logC[t]) - unchecked(logC[u]);
      const yBin: f64 = futRet > 0.0 ? 1.0 : 0.0;

      // Score the FROZEN prediction that was made back at origin bar u (zero future weight leakage!)
      if (u >= evalWarmup) {
        const pFrozen = unchecked(bufFrozenPUp[u]);
        if ((pFrozen >= 0.5 && yBin > 0.5) || (pFrozen < 0.5 && yBin < 0.5)) oosCorrect++;
        const diff = pFrozen - yBin;
        brierSum += diff * diff;
        oosTotal++;
      }

      // Now update weights online using realized sample (u -> t)
      let zLogU = bLog; let zRegU = bReg;
      for (let k = 0; k < FEAT; k++) {
        const fk = unchecked(featMat[ub + k]);
        zLogU += unchecked(wLog[k]) * fk;
        zRegU += unchecked(wReg[k]) * fk;
      }
      const errLog = sigmoid(zLogU) - yBin;
      const targetScaled = clamp(futRet / (vu * Math.sqrt(<f64>H) + 1e-6), -2.5, 2.5);
      const errReg = zRegU - targetScaled;

      bLog -= 0.035 * errLog;
      bReg -= 0.015 * errReg;
      for (let k = 0; k < FEAT; k++) {
        const fk = unchecked(featMat[ub + k]);
        unchecked((wLog[k] = unchecked(wLog[k]) - 0.035 * (errLog * fk + lam * unchecked(wLog[k]))));
        unchecked((wReg[k] = unchecked(wReg[k]) - 0.015 * (errReg * fk + lam * unchecked(wReg[k]))));
      }
    }

    // Step 3: Freeze strictly causal forecast at origin bar t (only sees data <= t)
    let zNow = bLog;
    for (let k = 0; k < FEAT; k++) zNow += unchecked(wLog[k]) * unchecked(featMat[fb + k]);
    unchecked((bufFrozenPUp[t] = sigmoid(zNow)));
  }

  // Final forecast from latest bar (N - 1)
  const lastBase = (N - 1) * FEAT;
  const barVol = unchecked(causalVol[N - 1]);
  let logitNow = bLog; let regNow = bReg;
  for (let k = 0; k < FEAT; k++) {
    const fk = unchecked(featMat[lastBase + k]);
    logitNow += unchecked(wLog[k]) * fk;
    regNow += unchecked(wReg[k]) * fk;
  }
  const pUp = clamp(sigmoid(logitNow), 0.08, 0.92);
  const mlLogRet = clamp(regNow * barVol * Math.sqrt(<f64>H), -0.35, 0.35);
  const kalmanLogRet = clamp(unchecked(kVel[N - 1]) * <f64>H * 0.75, -0.25, 0.25);
  const blendedLogRet = 0.6 * mlLogRet + 0.4 * kalmanLogRet;

  const lastPrice = unchecked(bufClose[N - 1]);
  for (let s = 1; s <= H; s++) {
    const frac = <f64>s / <f64>H;
    const drift = blendedLogRet * frac;
    const sigma = barVol * Math.sqrt(<f64>s);
    const base = (s - 1) * 5;
    unchecked((bufForecast[base] = lastPrice * Math.exp(drift)));
    unchecked((bufForecast[base + 1] = lastPrice * Math.exp(drift + sigma)));
    unchecked((bufForecast[base + 2] = lastPrice * Math.exp(drift - sigma)));
    unchecked((bufForecast[base + 3] = lastPrice * Math.exp(drift + 2.0 * sigma)));
    unchecked((bufForecast[base + 4] = lastPrice * Math.exp(drift - 2.0 * sigma)));
  }

  unchecked((bufForecastMeta[0] = pUp * 100.0));
  unchecked((bufForecastMeta[1] = (Math.exp(blendedLogRet) - 1.0) * 100.0));
  unchecked((bufForecastMeta[2] = barVol * Math.sqrt(252.0) * 100.0));
  unchecked((bufForecastMeta[3] = oosTotal > 0 ? (<f64>oosCorrect / <f64>oosTotal) * 100.0 : 50.0));
  unchecked((bufForecastMeta[4] = oosTotal > 0 ? brierSum / <f64>oosTotal : 0.25));
  unchecked((bufForecastMeta[5] = <f64>oosTotal));
  unchecked((bufForecastMeta[6] = unchecked(kVel[N - 1]) * 100.0));
  unchecked((bufForecastMeta[7] = barVol * 100.0));
  for (let k = 0; k < FEAT; k++) unchecked((bufForecastMeta[8 + k] = unchecked(wLog[k])));

  return H;
}
