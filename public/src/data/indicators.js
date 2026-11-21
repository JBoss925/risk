// Extensible 62-Indicator Catalog for Risk Quant Terminal
// Matches IDs 0..61 compiled inside wasm/engine.ts

export const INDICATOR_CATEGORIES = [
  { id: "all", label: "All (62)" },
  { id: "trend", label: "Trend (16)" },
  { id: "momentum", label: "Momentum (18)" },
  { id: "volatility", label: "Volatility (12)" },
  { id: "volume", label: "Volume (10)" },
  { id: "structure", label: "Structure & Stat (6)" },
];

const fmtUsd = (v) => (Number.isFinite(v[0]) ? `$${v[0].toFixed(2)}` : "—");
const fmtNum = (d = 1) => (v) => (Number.isFinite(v[0]) ? v[0].toFixed(d) : "—");
const fmtSigned = (d = 2, suffix = "") => (v) =>
  Number.isFinite(v[0]) ? `${v[0] >= 0 ? "+" : ""}${v[0].toFixed(d)}${suffix}` : "—";
const fmtCompact = (v) => {
  if (!Number.isFinite(v[0])) return "—";
  const a = Math.abs(v[0]);
  if (a >= 1e9) return `${(v[0] / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v[0] / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v[0] / 1e3).toFixed(1)}K`;
  return v[0].toFixed(0);
};

export const INDICATOR_CATALOG = [
  // ===================== TREND (0..15) =====================
  {
    id: 0, key: "sma", name: "Simple Moving Average", shortName: "SMA", category: "trend", placement: "overlay",
    description: "Price distance and slope relative to an N-bar simple moving average.",
    bullRule: "Price above rising SMA", bearRule: "Price below falling SMA",
    params: [{ key: "p1", label: "Period", min: 5, max: 300, step: 1, default: 50 }],
    lines: [{ name: "SMA", color: "#38bdf8" }], formatValue: fmtUsd,
  },
  {
    id: 1, key: "ema_cross", name: "EMA Crossover", shortName: "EMA Cross", category: "trend", placement: "overlay",
    description: "Fast vs. slow exponential moving average spread & acceleration normalized by ATR.",
    bullRule: "Fast EMA > Slow EMA", bearRule: "Fast EMA < Slow EMA",
    params: [
      { key: "p1", label: "Fast", min: 2, max: 100, step: 1, default: 12 },
      { key: "p2", label: "Slow", min: 5, max: 300, step: 1, default: 26 },
    ],
    lines: [{ name: "Fast EMA", color: "#38bdf8" }, { name: "Slow EMA", color: "#a78bfa" }],
    formatValue: (v) => (Number.isFinite(v[0]) && Number.isFinite(v[1]) ? `${v[0] >= v[1] ? "+" : ""}${(v[0] - v[1]).toFixed(2)}` : "—"),
  },
  {
    id: 2, key: "wma", name: "Weighted Moving Average", shortName: "WMA", category: "trend", placement: "overlay",
    description: "Linearly weights recent closes higher for faster trend tracking than SMA.",
    bullRule: "Price above rising WMA", bearRule: "Price below falling WMA",
    params: [{ key: "p1", label: "Period", min: 5, max: 200, step: 1, default: 20 }],
    lines: [{ name: "WMA", color: "#2dd4bf" }], formatValue: fmtUsd,
  },
  {
    id: 3, key: "hma", name: "Hull Moving Average", shortName: "HMA", category: "trend", placement: "overlay",
    description: "Ultra-low-lag Hull MA combining weighted averages to detect early trend turns.",
    bullRule: "HMA slope positive & price above", bearRule: "HMA slope negative & price below",
    params: [{ key: "p1", label: "Period", min: 6, max: 150, step: 1, default: 21 }],
    lines: [{ name: "HMA", color: "#f472b6" }], formatValue: fmtUsd,
  },
  {
    id: 4, key: "supertrend", name: "Supertrend", shortName: "Supertrend", category: "trend", placement: "overlay",
    description: "ATR-scaled trailing trend regime band that flips direction cleanly on structure breaks.",
    bullRule: "Bullish trailing support active", bearRule: "Bearish trailing resistance active",
    params: [
      { key: "p1", label: "ATR Period", min: 5, max: 50, step: 1, default: 10 },
      { key: "p2", label: "Multiplier", min: 1.0, max: 6.0, step: 0.25, default: 3.0 },
    ],
    lines: [{ name: "Supertrend", color: "#10b981", splitByDir: true }],
    formatValue: (v) => (Number.isFinite(v[0]) ? `${v[1] > 0 ? "UP" : "DN"} $${v[0].toFixed(2)}` : "—"),
  },
  {
    id: 5, key: "adx", name: "ADX / Directional Index", shortName: "ADX / DMI", category: "trend", placement: "oscillator",
    description: "Wilder's trend strength (ADX) scaled by +DI / -DI directional dominance.",
    bullRule: "+DI > -DI with rising ADX", bearRule: "-DI > +DI with rising ADX",
    params: [
      { key: "p1", label: "Period", min: 5, max: 50, step: 1, default: 14 },
      { key: "p2", label: "Trend Min", min: 10, max: 45, step: 1, default: 20 },
    ],
    lines: [{ name: "ADX", color: "#f59e0b" }, { name: "+DI", color: "#10b981" }, { name: "-DI", color: "#f43f5e" }],
    oscRange: [0, 70], formatValue: (v) => (Number.isFinite(v[0]) ? `ADX ${v[0].toFixed(1)}` : "—"),
  },
  {
    id: 6, key: "psar", name: "Parabolic SAR", shortName: "PSAR", category: "trend", placement: "overlay",
    description: "Accelerating stop-and-reverse dots tracking trend exhaustion.",
    bullRule: "SAR dots below price", bearRule: "SAR dots above price",
    params: [
      { key: "p1", label: "Step", min: 0.005, max: 0.1, step: 0.005, default: 0.02 },
      { key: "p2", label: "Max Step", min: 0.05, max: 0.5, step: 0.02, default: 0.2 },
    ],
    lines: [{ name: "SAR", color: "#fbbf24", style: "dots" }],
    formatValue: (v) => (Number.isFinite(v[0]) ? `${v[1] > 0 ? "▲" : "▼"} $${v[0].toFixed(2)}` : "—"),
  },
  {
    id: 7, key: "ichimoku", name: "Ichimoku Cloud", shortName: "Ichimoku", category: "trend", placement: "overlay",
    description: "Tenkan/Kijun momentum cross plus Kumo cloud breakout and twist structure.",
    bullRule: "Price above Kumo & Tenkan > Kijun", bearRule: "Price below Kumo & Tenkan < Kijun",
    params: [
      { key: "p1", label: "Tenkan", min: 4, max: 30, step: 1, default: 9 },
      { key: "p2", label: "Kijun", min: 10, max: 60, step: 1, default: 26 },
      { key: "p3", label: "Senkou B", min: 20, max: 120, step: 1, default: 52 },
    ],
    lines: [
      { name: "Tenkan", color: "#38bdf8" }, { name: "Kijun", color: "#f43f5e" },
      { name: "Span A", color: "#10b981", cloud: true }, { name: "Span B", color: "#f43f5e", cloud: true },
    ],
    formatValue: (v) => (Number.isFinite(v[0]) && Number.isFinite(v[1]) ? `TK ${(v[0] - v[1]).toFixed(2)}` : "—"),
  },
  {
    id: 8, key: "dema", name: "Double EMA (DEMA)", shortName: "DEMA", category: "trend", placement: "overlay",
    description: "Patrick Mulloy's 2·EMA - EMA(EMA) cutting standard moving average lag in half.",
    bullRule: "Price above rising DEMA", bearRule: "Price below falling DEMA",
    params: [{ key: "p1", label: "Period", min: 4, max: 200, step: 1, default: 20 }],
    lines: [{ name: "DEMA", color: "#60a5fa" }], formatValue: fmtUsd,
  },
  {
    id: 9, key: "tema", name: "Triple EMA (TEMA)", shortName: "TEMA", category: "trend", placement: "overlay",
    description: "Triple-smoothed zero-lag moving average responsive to rapid momentum inflections.",
    bullRule: "Price above rising TEMA", bearRule: "Price below falling TEMA",
    params: [{ key: "p1", label: "Period", min: 4, max: 200, step: 1, default: 21 }],
    lines: [{ name: "TEMA", color: "#c084fc" }], formatValue: fmtUsd,
  },
  {
    id: 10, key: "kama", name: "Kaufman Adaptive MA (KAMA)", shortName: "KAMA", category: "trend", placement: "overlay",
    description: "Dynamically adjusts smoothing speed via Efficiency Ratio — fast in trends, flat in chop.",
    bullRule: "Price breaking above accelerating KAMA", bearRule: "Price falling below KAMA",
    params: [
      { key: "p1", label: "ER Period", min: 4, max: 50, step: 1, default: 10 },
      { key: "p2", label: "Fast SC", min: 2, max: 10, step: 1, default: 2 },
      { key: "p3", label: "Slow SC", min: 15, max: 60, step: 1, default: 30 },
    ],
    lines: [{ name: "KAMA", color: "#fbbf24" }], formatValue: fmtUsd,
  },
  {
    id: 11, key: "zlema", name: "Zero-Lag EMA (ZLEMA)", shortName: "ZLEMA", category: "trend", placement: "overlay",
    description: "De-lags price data before EMA smoothing to capture early breakout entries.",
    bullRule: "Price above rising ZLEMA", bearRule: "Price below falling ZLEMA",
    params: [{ key: "p1", label: "Period", min: 4, max: 150, step: 1, default: 18 }],
    lines: [{ name: "ZLEMA", color: "#34d399" }], formatValue: fmtUsd,
  },
  {
    id: 12, key: "alma", name: "Arnaud Legoux MA (ALMA)", shortName: "ALMA", category: "trend", placement: "overlay",
    description: "Gaussian-weighted moving average eliminating phase lag and whipsaw noise.",
    bullRule: "Price above smooth rising ALMA", bearRule: "Price below falling ALMA",
    params: [
      { key: "p1", label: "Window", min: 5, max: 120, step: 1, default: 20 },
      { key: "p2", label: "Offset", min: 0.2, max: 0.95, step: 0.05, default: 0.85 },
      { key: "p3", label: "Sigma", min: 2, max: 12, step: 1, default: 6 },
    ],
    lines: [{ name: "ALMA", color: "#e879f9" }], formatValue: fmtUsd,
  },
  {
    id: 13, key: "aroon", name: "Aroon Oscillator", shortName: "Aroon", category: "trend", placement: "oscillator",
    description: "Measures time elapsed since N-bar highs vs. lows to identify fresh trend births.",
    bullRule: "Aroon Up near 100 / Oscillator > 0", bearRule: "Aroon Down near 100 / Oscillator < 0",
    params: [{ key: "p1", label: "Period", min: 5, max: 80, step: 1, default: 25 }],
    lines: [{ name: "Aroon Osc", color: "#38bdf8", style: "histogram" }],
    oscRange: [-100, 100], refLines: [-50, 0, 50], formatValue: fmtSigned(0),
  },
  {
    id: 14, key: "vortex", name: "Vortex Indicator (VI+/VI-)", shortName: "Vortex", category: "trend", placement: "oscillator",
    description: "Captures positive and negative vortex trend currents from true range overlaps.",
    bullRule: "VI+ crosses above VI-", bearRule: "VI- crosses above VI+",
    params: [{ key: "p1", label: "Period", min: 5, max: 50, step: 1, default: 14 }],
    lines: [{ name: "VI+", color: "#10b981" }, { name: "VI-", color: "#f43f5e" }],
    refLines: [1.0],
    formatValue: (v) => (Number.isFinite(v[0]) && Number.isFinite(v[1]) ? `${(v[0] - v[1]) >= 0 ? "+" : ""}${(v[0] - v[1]).toFixed(3)}` : "—"),
  },
  {
    id: 15, key: "linreg", name: "Linear Regression Slope & R²", shortName: "LinReg R²", category: "trend", placement: "overlay",
    description: "Least-squares regression endpoint scaled by R² goodness-of-fit to filter noisy drift.",
    bullRule: "Positive slope with high R² trend clarity", bearRule: "Negative slope with high R²",
    params: [{ key: "p1", label: "Period", min: 6, max: 100, step: 1, default: 20 }],
    lines: [{ name: "LinReg", color: "#818cf8" }],
    formatValue: (v) => (Number.isFinite(v[2]) ? `R² ${(v[2] * 100).toFixed(0)}%` : "—"),
  },

  // ===================== MOMENTUM & OSCILLATORS (16..33) =====================
  {
    id: 16, key: "rsi", name: "Relative Strength Index", shortName: "RSI", category: "momentum", placement: "oscillator",
    description: "Wilder's momentum oscillator measuring oversold bounce vs. overbought stretch.",
    bullRule: "Oversold (RSI toward lower band)", bearRule: "Overbought (RSI toward upper band)",
    params: [
      { key: "p1", label: "Period", min: 3, max: 50, step: 1, default: 14 },
      { key: "p2", label: "Oversold", min: 10, max: 45, step: 1, default: 30 },
      { key: "p3", label: "Overbought", min: 55, max: 90, step: 1, default: 70 },
    ],
    lines: [{ name: "RSI", color: "#a78bfa" }], oscRange: [0, 100], refLines: [30, 50, 70], formatValue: fmtNum(1),
  },
  {
    id: 17, key: "stoch_rsi", name: "Stochastic RSI", shortName: "Stoch RSI", category: "momentum", placement: "oscillator",
    description: "High-sensitivity oscillator applying Stochastic normalization to RSI values.",
    bullRule: "Stoch RSI < 20 & %K crossing up", bearRule: "Stoch RSI > 80 & %K crossing down",
    params: [
      { key: "p1", label: "RSI Period", min: 5, max: 40, step: 1, default: 14 },
      { key: "p2", label: "Stoch Len", min: 5, max: 40, step: 1, default: 14 },
      { key: "p3", label: "Smooth K", min: 1, max: 10, step: 1, default: 3 },
    ],
    lines: [{ name: "%K", color: "#38bdf8" }, { name: "%D", color: "#f59e0b" }],
    oscRange: [0, 100], refLines: [20, 80], formatValue: fmtNum(1),
  },
  {
    id: 18, key: "macd", name: "MACD", shortName: "MACD", category: "momentum", placement: "oscillator",
    description: "EMA convergence/divergence histogram + slope acceleration normalized by ATR.",
    bullRule: "MACD > Signal & rising histogram", bearRule: "MACD < Signal & falling histogram",
    params: [
      { key: "p1", label: "Fast", min: 4, max: 40, step: 1, default: 12 },
      { key: "p2", label: "Slow", min: 10, max: 80, step: 1, default: 26 },
      { key: "p3", label: "Signal", min: 2, max: 30, step: 1, default: 9 },
    ],
    lines: [{ name: "MACD", color: "#38bdf8" }, { name: "Signal", color: "#f59e0b" }, { name: "Hist", color: "#10b981", style: "histogram" }],
    formatValue: (v) => (Number.isFinite(v[2]) ? `H ${v[2] >= 0 ? "+" : ""}${v[2].toFixed(2)}` : "—"),
  },
  {
    id: 19, key: "ppo", name: "Percentage Price Oscillator (PPO)", shortName: "PPO", category: "momentum", placement: "oscillator",
    description: "Scale-invariant percentage version of MACD ideal for comparing across tickers.",
    bullRule: "PPO above signal & positive", bearRule: "PPO below signal & negative",
    params: [
      { key: "p1", label: "Fast", min: 4, max: 40, step: 1, default: 12 },
      { key: "p2", label: "Slow", min: 10, max: 80, step: 1, default: 26 },
      { key: "p3", label: "Signal", min: 2, max: 30, step: 1, default: 9 },
    ],
    lines: [{ name: "PPO", color: "#38bdf8" }, { name: "Sig", color: "#fb7185" }, { name: "Hist", color: "#10b981", style: "histogram" }],
    refLines: [0], formatValue: fmtSigned(2, "%"),
  },
  {
    id: 20, key: "stoch", name: "Stochastic Oscillator", shortName: "Stoch %K/%D", category: "momentum", placement: "oscillator",
    description: "Close location inside rolling high-low range with %K / %D crossover momentum.",
    bullRule: "Oversold & %K crossing above %D", bearRule: "Overbought & %K crossing below %D",
    params: [
      { key: "p1", label: "%K Period", min: 3, max: 50, step: 1, default: 14 },
      { key: "p2", label: "%D Smooth", min: 2, max: 15, step: 1, default: 3 },
      { key: "p3", label: "Oversold", min: 5, max: 40, step: 1, default: 20 },
      { key: "p4", label: "Overbought", min: 60, max: 95, step: 1, default: 80 },
    ],
    lines: [{ name: "%K", color: "#38bdf8" }, { name: "%D", color: "#fb7185" }],
    oscRange: [0, 100], refLines: [20, 80], formatValue: fmtNum(1),
  },
  {
    id: 21, key: "cci", name: "Commodity Channel Index", shortName: "CCI", category: "momentum", placement: "oscillator",
    description: "Typical price deviation from its mean scaled by mean absolute deviation.",
    bullRule: "CCI deeply negative (mean reversion)", bearRule: "CCI deeply positive (overextended)",
    params: [
      { key: "p1", label: "Period", min: 5, max: 60, step: 1, default: 20 },
      { key: "p2", label: "Band", min: 50, max: 250, step: 10, default: 100 },
    ],
    lines: [{ name: "CCI", color: "#22d3ee" }], refLines: [-100, 0, 100], formatValue: fmtNum(0),
  },
  {
    id: 22, key: "willr", name: "Williams %R", shortName: "Williams %R", category: "momentum", placement: "oscillator",
    description: "Fast momentum oscillator (-100 to 0) spotlighting short-term extremes.",
    bullRule: "%R below -80 (oversold)", bearRule: "%R above -20 (overbought)",
    params: [
      { key: "p1", label: "Period", min: 4, max: 50, step: 1, default: 14 },
      { key: "p2", label: "Oversold", min: -95, max: -60, step: 5, default: -80 },
      { key: "p3", label: "Overbought", min: -40, max: -5, step: 5, default: -20 },
    ],
    lines: [{ name: "%R", color: "#c084fc" }], oscRange: [-100, 0], refLines: [-80, -20], formatValue: fmtNum(1),
  },
  {
    id: 23, key: "roc", name: "Rate of Change", shortName: "ROC", category: "momentum", placement: "oscillator",
    description: "Percentage velocity of price change over an N-bar lookback window.",
    bullRule: "Positive price velocity", bearRule: "Negative price velocity",
    params: [
      { key: "p1", label: "Lookback", min: 2, max: 60, step: 1, default: 12 },
      { key: "p2", label: "Scale %", min: 1, max: 25, step: 0.5, default: 5.0 },
    ],
    lines: [{ name: "ROC %", color: "#34d399" }], refLines: [0], formatValue: fmtSigned(2, "%"),
  },
  {
    id: 24, key: "mfi", name: "Money Flow Index", shortName: "MFI", category: "momentum", placement: "oscillator",
    description: "Volume-weighted RSI measuring buying vs. selling dollar flow exhaustion.",
    bullRule: "Low MFI (<20) accumulation zone", bearRule: "High MFI (>80) distribution zone",
    params: [
      { key: "p1", label: "Period", min: 4, max: 50, step: 1, default: 14 },
      { key: "p2", label: "Oversold", min: 10, max: 40, step: 1, default: 20 },
      { key: "p3", label: "Overbought", min: 60, max: 90, step: 1, default: 80 },
    ],
    lines: [{ name: "MFI", color: "#f59e0b" }], oscRange: [0, 100], refLines: [20, 80], formatValue: fmtNum(1),
  },
  {
    id: 25, key: "ao", name: "Awesome Oscillator", shortName: "Awesome Osc", category: "momentum", placement: "oscillator",
    description: "Bill Williams 5/34 midpoint SMA difference capturing momentum shifts.",
    bullRule: "AO positive & accelerating", bearRule: "AO negative & decelerating",
    params: [
      { key: "p1", label: "Fast", min: 2, max: 20, step: 1, default: 5 },
      { key: "p2", label: "Slow", min: 10, max: 80, step: 1, default: 34 },
    ],
    lines: [{ name: "AO", color: "#10b981", style: "histogram" }], refLines: [0], formatValue: fmtSigned(2),
  },
  {
    id: 26, key: "trix", name: "TRIX (Triple Smoothed ROC)", shortName: "TRIX", category: "momentum", placement: "oscillator",
    description: "Rate of change of a triple-smoothed EMA filtering out minor cycle noise.",
    bullRule: "TRIX positive & above signal", bearRule: "TRIX negative & below signal",
    params: [
      { key: "p1", label: "Period", min: 4, max: 40, step: 1, default: 15 },
      { key: "p2", label: "Signal", min: 2, max: 20, step: 1, default: 9 },
    ],
    lines: [{ name: "TRIX", color: "#38bdf8" }, { name: "Signal", color: "#f59e0b" }],
    refLines: [0], formatValue: fmtSigned(3, "%"),
  },
  {
    id: 27, key: "uo", name: "Ultimate Oscillator", shortName: "Ultimate Osc", category: "momentum", placement: "oscillator",
    description: "Larry Williams multi-timeframe (7/14/28) buying pressure oscillator reducing false divergences.",
    bullRule: "UO oversold (<35) buying pressure", bearRule: "UO overbought (>65) exhaustion",
    params: [
      { key: "p1", label: "Short", min: 3, max: 14, step: 1, default: 7 },
      { key: "p2", label: "Medium", min: 8, max: 30, step: 1, default: 14 },
      { key: "p3", label: "Long", min: 15, max: 60, step: 1, default: 28 },
    ],
    lines: [{ name: "UO", color: "#818cf8" }], oscRange: [0, 100], refLines: [30, 50, 70], formatValue: fmtNum(1),
  },
  {
    id: 28, key: "cmo", name: "Chande Momentum Oscillator", shortName: "CMO", category: "momentum", placement: "oscillator",
    description: "Symmetric -100 to +100 pure momentum ratio of up-bar gains to down-bar losses.",
    bullRule: "Strong positive CMO surge", bearRule: "Strong negative CMO slide",
    params: [{ key: "p1", label: "Period", min: 4, max: 50, step: 1, default: 14 }],
    lines: [{ name: "CMO", color: "#2dd4bf" }], oscRange: [-100, 100], refLines: [-50, 0, 50], formatValue: fmtSigned(1),
  },
  {
    id: 29, key: "tsi", name: "True Strength Index (TSI)", shortName: "TSI", category: "momentum", placement: "oscillator",
    description: "Double-smoothed momentum ratio capturing both trend persistence and crossover timing.",
    bullRule: "TSI above signal & rising", bearRule: "TSI below signal & falling",
    params: [
      { key: "p1", label: "Long", min: 10, max: 50, step: 1, default: 25 },
      { key: "p2", label: "Short", min: 4, max: 25, step: 1, default: 13 },
      { key: "p3", label: "Signal", min: 2, max: 20, step: 1, default: 7 },
    ],
    lines: [{ name: "TSI", color: "#38bdf8" }, { name: "Signal", color: "#fb7185" }],
    refLines: [0], formatValue: fmtSigned(1),
  },
  {
    id: 30, key: "kst", name: "Know Sure Thing (KST)", shortName: "KST", category: "momentum", placement: "oscillator",
    description: "Martin Pring's weighted four-horizon ROC cycle oscillator for major swing turns.",
    bullRule: "KST above signal line", bearRule: "KST below signal line",
    params: [{ key: "p1", label: "Signal", min: 3, max: 25, step: 1, default: 9 }],
    lines: [{ name: "KST", color: "#34d399" }, { name: "Signal", color: "#f59e0b" }],
    refLines: [0], formatValue: fmtSigned(1),
  },
  {
    id: 31, key: "coppock", name: "Coppock Curve", shortName: "Coppock", category: "momentum", placement: "oscillator",
    description: "Weighted moving average of dual-horizon ROC originally built to catch major market bottoms.",
    bullRule: "Coppock turning upward / positive", bearRule: "Coppock rolling over / negative",
    params: [
      { key: "p1", label: "WMA", min: 4, max: 25, step: 1, default: 10 },
      { key: "p2", label: "ROC Long", min: 6, max: 30, step: 1, default: 14 },
      { key: "p3", label: "ROC Short", min: 4, max: 25, step: 1, default: 11 },
    ],
    lines: [{ name: "Coppock", color: "#10b981", style: "histogram" }], refLines: [0], formatValue: fmtSigned(2),
  },
  {
    id: 32, key: "dpo", name: "Detrended Price Oscillator", shortName: "DPO", category: "momentum", placement: "oscillator",
    description: "Strips long-term trend to isolate short-term cyclic peaks and troughs.",
    bullRule: "Deep negative cyclic trough", bearRule: "Stretched positive cyclic peak",
    params: [{ key: "p1", label: "Period", min: 6, max: 60, step: 1, default: 20 }],
    lines: [{ name: "DPO", color: "#f472b6" }], refLines: [0], formatValue: fmtSigned(2),
  },
  {
    id: 33, key: "elder_ray", name: "Elder Ray (Bull / Bear Power)", shortName: "Elder Ray", category: "momentum", placement: "oscillator",
    description: "Alexander Elder's High-EMA vs. Low-EMA measurement of buyer vs. seller force.",
    bullRule: "Bull power expanding over Bear power", bearRule: "Bear power dominating below EMA",
    params: [{ key: "p1", label: "EMA Period", min: 5, max: 40, step: 1, default: 13 }],
    lines: [{ name: "Bull", color: "#10b981", style: "histogram" }, { name: "Bear", color: "#f43f5e" }],
    refLines: [0],
    formatValue: (v) => (Number.isFinite(v[0]) && Number.isFinite(v[1]) ? `${(v[0] + v[1]) >= 0 ? "+" : ""}${(v[0] + v[1]).toFixed(2)}` : "—"),
  },

  // ===================== VOLATILITY & CHANNELS (34..45) =====================
  {
    id: 34, key: "bbands", name: "Bollinger Bands (%B)", shortName: "Bollinger", category: "volatility", placement: "overlay",
    description: "Volatility envelope (SMA ± k·σ). Defaults to mean-reversion; toggle Invert for breakouts.",
    bullRule: "Price near Lower Band (%B < 20%)", bearRule: "Price near Upper Band (%B > 80%)",
    params: [
      { key: "p1", label: "Period", min: 5, max: 100, step: 1, default: 20 },
      { key: "p2", label: "Std Dev", min: 1.0, max: 4.0, step: 0.25, default: 2.0 },
    ],
    lines: [
      { name: "Mid", color: "#818cf8" },
      { name: "Upper", color: "rgba(129, 140, 248, 0.7)", band: true },
      { name: "Lower", color: "rgba(129, 140, 248, 0.7)", band: true },
    ],
    formatValue: (v) => (Number.isFinite(v[3]) ? `%B ${(v[3] * 100).toFixed(0)}%` : "—"),
  },
  {
    id: 35, key: "bb_squeeze", name: "Bollinger BandWidth Squeeze", shortName: "BB Squeeze", category: "volatility", placement: "oscillator",
    description: "Detects volatility compression squeezes firing into directional expansion.",
    bullRule: "Squeeze firing upward", bearRule: "Squeeze firing downward",
    params: [
      { key: "p1", label: "Period", min: 8, max: 60, step: 1, default: 20 },
      { key: "p2", label: "Std Dev", min: 1.0, max: 4.0, step: 0.25, default: 2.0 },
    ],
    lines: [{ name: "BandWidth %", color: "#f59e0b" }, { name: "Avg BW", color: "#64748b" }],
    formatValue: (v) => (Number.isFinite(v[0]) ? `${v[0].toFixed(1)}%` : "—"),
  },
  {
    id: 36, key: "atr", name: "ATR Volatility Regime", shortName: "ATR Regime", category: "volatility", placement: "oscillator",
    description: "Average True Range vs. baseline average. Great as a Regime Veto Filter during stress spikes.",
    bullRule: "Calm / normal volatility regime", bearRule: "Elevated volatility stress spike",
    params: [
      { key: "p1", label: "ATR Period", min: 5, max: 50, step: 1, default: 14 },
      { key: "p2", label: "Baseline MA", min: 15, max: 150, step: 5, default: 50 },
    ],
    lines: [{ name: "ATR %", color: "#fb923c", slot: 1 }],
    formatValue: (v) => (Number.isFinite(v[1]) ? `${v[1].toFixed(2)}% (${v[2]?.toFixed(2) ?? "1.0"}x)` : "—"),
  },
  {
    id: 37, key: "keltner", name: "Keltner Channels", shortName: "Keltner", category: "volatility", placement: "overlay",
    description: "EMA ± ATR volatility breakout channel identifying directional expansion.",
    bullRule: "Price pressing upper Keltner channel", bearRule: "Price pressing lower Keltner channel",
    params: [
      { key: "p1", label: "EMA Period", min: 5, max: 80, step: 1, default: 20 },
      { key: "p2", label: "ATR Mult", min: 0.5, max: 4.5, step: 0.25, default: 2.0 },
    ],
    lines: [
      { name: "Mid", color: "#06b6d4" },
      { name: "Upper", color: "rgba(6, 182, 212, 0.65)", band: true },
      { name: "Lower", color: "rgba(6, 182, 212, 0.65)", band: true },
    ],
    formatValue: fmtUsd,
  },
  {
    id: 38, key: "donchian", name: "Donchian Channels", shortName: "Donchian", category: "volatility", placement: "overlay",
    description: "Classic turtle-trading N-bar high/low breakout channel.",
    bullRule: "Price breaking toward N-bar high", bearRule: "Price breaking toward N-bar low",
    params: [{ key: "p1", label: "Period", min: 5, max: 120, step: 1, default: 20 }],
    lines: [
      { name: "High", color: "rgba(52, 211, 153, 0.7)", band: true },
      { name: "Low", color: "rgba(244, 63, 94, 0.7)", band: true },
      { name: "Mid", color: "rgba(148, 163, 184, 0.5)" },
    ],
    formatValue: (v) => (Number.isFinite(v[2]) ? `$${v[2].toFixed(2)}` : "—"),
  },
  {
    id: 39, key: "chaikin_vol", name: "Chaikin Volatility", shortName: "Chaikin Vol", category: "volatility", placement: "oscillator",
    description: "Rate of change of EMA high-low spread flagging volatility spikes and calm bottoms.",
    bullRule: "Volatility contracting / stabilizing", bearRule: "Sharp range expansion shock",
    params: [
      { key: "p1", label: "EMA", min: 4, max: 30, step: 1, default: 10 },
      { key: "p2", label: "ROC", min: 4, max: 30, step: 1, default: 10 },
    ],
    lines: [{ name: "ChVol %", color: "#fb923c" }], refLines: [0], formatValue: fmtSigned(1, "%"),
  },
  {
    id: 40, key: "ulcer", name: "Ulcer Index (Downside Stress)", shortName: "Ulcer Index", category: "volatility", placement: "oscillator",
    description: "Peter Martin's root-mean-square drawdown gauge measuring downside pain only.",
    bullRule: "Low Ulcer (<2.5) smooth uptrend", bearRule: "High Ulcer drawdown stress",
    params: [{ key: "p1", label: "Period", min: 5, max: 50, step: 1, default: 14 }],
    lines: [{ name: "Ulcer", color: "#fb7185" }], formatValue: fmtNum(2),
  },
  {
    id: 41, key: "hist_vol", name: "Historical Realized Volatility", shortName: "Realized Vol", category: "volatility", placement: "oscillator",
    description: "Annualized rolling log-return standard deviation vs. long-run baseline regime.",
    bullRule: "Below-average realized vol regime", bearRule: "Elevated realized vol shock",
    params: [{ key: "p1", label: "Window", min: 5, max: 60, step: 1, default: 20 }],
    lines: [{ name: "HV %", color: "#f59e0b" }, { name: "Baseline", color: "#64748b" }],
    formatValue: (v) => (Number.isFinite(v[0]) ? `${v[0].toFixed(1)}%` : "—"),
  },
  {
    id: 42, key: "mass_index", name: "Mass Index (Reversal Bulge)", shortName: "Mass Index", category: "volatility", placement: "oscillator",
    description: "Donald Dorsey's double-EMA range ratio sum identifying high-probability reversal bulges >27.",
    bullRule: "Reversal bulge after selloff", bearRule: "Reversal bulge after rally",
    params: [
      { key: "p1", label: "EMA", min: 4, max: 20, step: 1, default: 9 },
      { key: "p2", label: "Sum Len", min: 10, max: 40, step: 1, default: 25 },
    ],
    lines: [{ name: "Mass", color: "#e879f9" }], refLines: [26.5, 27], formatValue: fmtNum(2),
  },
  {
    id: 43, key: "chandelier", name: "Chandelier Exit", shortName: "Chandelier", category: "volatility", placement: "overlay",
    description: "Chuck LeBeau's ATR stop anchored to rolling extremes protecting trending profits.",
    bullRule: "Long Chandelier support holding", bearRule: "Short Chandelier cap active",
    params: [
      { key: "p1", label: "Period", min: 5, max: 60, step: 1, default: 22 },
      { key: "p2", label: "ATR Mult", min: 1.0, max: 5.5, step: 0.25, default: 3.0 },
    ],
    lines: [{ name: "Chandelier", color: "#34d399", splitByDir: true }],
    formatValue: (v) => (Number.isFinite(v[0]) ? `${v[1] > 0 ? "UP" : "DN"} $${v[0].toFixed(2)}` : "—"),
  },
  {
    id: 44, key: "atr_stop", name: "ATR Trailing Stop", shortName: "ATR Stop", category: "volatility", placement: "overlay",
    description: "Ratcheting volatility trailing stop that locks in gains and flips cleanly on breaks.",
    bullRule: "Price above ratcheting ATR stop", bearRule: "Price below descending ATR stop",
    params: [
      { key: "p1", label: "ATR Period", min: 4, max: 40, step: 1, default: 14 },
      { key: "p2", label: "Multiplier", min: 1.0, max: 5.0, step: 0.25, default: 2.5 },
    ],
    lines: [{ name: "ATR Stop", color: "#10b981", splitByDir: true }],
    formatValue: (v) => (Number.isFinite(v[0]) ? `${v[1] > 0 ? "UP" : "DN"} $${v[0].toFixed(2)}` : "—"),
  },
  {
    id: 45, key: "stderr_bands", name: "Standard Error Bands", shortName: "StdErr Bands", category: "volatility", placement: "overlay",
    description: "Linear regression midline ± k standard errors for statistical trend mean-reversion.",
    bullRule: "Price near lower regression error band", bearRule: "Price near upper regression error band",
    params: [
      { key: "p1", label: "Period", min: 8, max: 80, step: 1, default: 21 },
      { key: "p2", label: "Mult", min: 1.0, max: 4.0, step: 0.25, default: 2.0 },
    ],
    lines: [
      { name: "Reg Mid", color: "#c084fc" },
      { name: "Upper SE", color: "rgba(192, 132, 252, 0.65)", band: true },
      { name: "Lower SE", color: "rgba(192, 132, 252, 0.65)", band: true },
    ],
    formatValue: fmtUsd,
  },

  // ===================== VOLUME & MICROSTRUCTURE (46..55) =====================
  {
    id: 46, key: "vwap", name: "Rolling VWAP (±1σ)", shortName: "VWAP", category: "volume", placement: "overlay",
    description: "Volume-weighted institutional fair value line with ±1σ deviation bands.",
    bullRule: "Price trading above VWAP", bearRule: "Price trading below VWAP",
    params: [{ key: "p1", label: "Window", min: 5, max: 120, step: 1, default: 20 }],
    lines: [
      { name: "VWAP", color: "#fbbf24" },
      { name: "+1σ", color: "rgba(251, 191, 36, 0.35)", band: true },
      { name: "-1σ", color: "rgba(251, 191, 36, 0.35)", band: true },
    ],
    formatValue: fmtUsd,
  },
  {
    id: 47, key: "obv", name: "On-Balance Volume Trend", shortName: "OBV Trend", category: "volume", placement: "oscillator",
    description: "Cumulative signed volume flow EMA spread detecting hidden accumulation.",
    bullRule: "OBV fast EMA rising above slow EMA", bearRule: "OBV fast EMA falling below slow EMA",
    params: [
      { key: "p1", label: "Fast EMA", min: 3, max: 40, step: 1, default: 10 },
      { key: "p2", label: "Slow EMA", min: 10, max: 100, step: 1, default: 30 },
    ],
    lines: [{ name: "OBV", color: "#38bdf8" }], formatValue: fmtCompact,
  },
  {
    id: 48, key: "cmf", name: "Chaikin Money Flow", shortName: "CMF", category: "volume", placement: "oscillator",
    description: "Closing location × volume over N bars to spot institutional accumulation.",
    bullRule: "Positive CMF (buying pressure)", bearRule: "Negative CMF (selling pressure)",
    params: [{ key: "p1", label: "Period", min: 5, max: 60, step: 1, default: 20 }],
    lines: [{ name: "CMF", color: "#10b981", style: "histogram" }], oscRange: [-0.5, 0.5], refLines: [0], formatValue: fmtSigned(3),
  },
  {
    id: 49, key: "adl", name: "Accumulation / Distribution Line", shortName: "A/D Line", category: "volume", placement: "oscillator",
    description: "Cumulative close-location volume line revealing stealth institutional buying or distribution.",
    bullRule: "ADL fast trend accelerating up", bearRule: "ADL rolling over into distribution",
    params: [
      { key: "p1", label: "Fast EMA", min: 3, max: 30, step: 1, default: 10 },
      { key: "p2", label: "Slow EMA", min: 10, max: 80, step: 1, default: 30 },
    ],
    lines: [{ name: "ADL", color: "#2dd4bf" }], formatValue: fmtCompact,
  },
  {
    id: 50, key: "chaikin_osc", name: "Chaikin Oscillator", shortName: "Chaikin Osc", category: "volume", placement: "oscillator",
    description: "MACD of the Accumulation/Distribution Line (3-day vs. 10-day EMA momentum).",
    bullRule: "Positive Chaikin Osc surge", bearRule: "Negative Chaikin Osc outflow",
    params: [
      { key: "p1", label: "Fast", min: 2, max: 15, step: 1, default: 3 },
      { key: "p2", label: "Slow", min: 5, max: 40, step: 1, default: 10 },
    ],
    lines: [{ name: "ChOsc", color: "#10b981", style: "histogram" }], refLines: [0], formatValue: fmtCompact,
  },
  {
    id: 51, key: "force_idx", name: "Elder Force Index", shortName: "Force Index", category: "volume", placement: "oscillator",
    description: "EMA of (Price Change × Volume) quantifying the sheer dollar force behind each swing.",
    bullRule: "Positive Force Index impulse", bearRule: "Negative Force Index selling wave",
    params: [{ key: "p1", label: "EMA Period", min: 2, max: 40, step: 1, default: 13 }],
    lines: [{ name: "Force", color: "#38bdf8", style: "histogram" }], refLines: [0], formatValue: fmtCompact,
  },
  {
    id: 52, key: "emv", name: "Ease of Movement (EMV)", shortName: "EMV", category: "volume", placement: "oscillator",
    description: "Richard Arms' metric showing how effortlessly price advances on light resistance.",
    bullRule: "Positive EMV (easy upside lift)", bearRule: "Negative EMV (easy downside drop)",
    params: [{ key: "p1", label: "SMA Period", min: 4, max: 40, step: 1, default: 14 }],
    lines: [{ name: "EMV", color: "#a78bfa" }], refLines: [0], formatValue: fmtSigned(2),
  },
  {
    id: 53, key: "vpt", name: "Volume Price Trend (VPT)", shortName: "VPT", category: "volume", placement: "oscillator",
    description: "Cumulative percentage return × volume tracking conviction-weighted capital inflows.",
    bullRule: "VPT fast EMA above slow EMA", bearRule: "VPT fast EMA below slow EMA",
    params: [
      { key: "p1", label: "Fast EMA", min: 3, max: 30, step: 1, default: 8 },
      { key: "p2", label: "Slow EMA", min: 10, max: 60, step: 1, default: 21 },
    ],
    lines: [{ name: "VPT", color: "#34d399" }], formatValue: fmtCompact,
  },
  {
    id: 54, key: "kvo", name: "Klinger Volume Oscillator (KVO)", shortName: "Klinger KVO", category: "volume", placement: "oscillator",
    description: "Stephen Klinger's long-range money-flow oscillator comparing 34/55 volume force EMAs.",
    bullRule: "KVO positive & above signal", bearRule: "KVO negative & below signal",
    params: [
      { key: "p1", label: "Fast", min: 10, max: 50, step: 1, default: 34 },
      { key: "p2", label: "Slow", min: 20, max: 90, step: 1, default: 55 },
      { key: "p3", label: "Signal", min: 4, max: 30, step: 1, default: 13 },
    ],
    lines: [{ name: "KVO", color: "#fbbf24" }, { name: "Signal", color: "#fb7185" }], refLines: [0], formatValue: fmtCompact,
  },
  {
    id: 55, key: "vol_surge", name: "Relative Volume Surge (Z-Score)", shortName: "Vol Surge", category: "volume", placement: "oscillator",
    description: "Standardized volume spike Z-score signed by candle direction to confirm breakouts.",
    bullRule: "High-volume bullish bar expansion", bearRule: "High-volume distribution bar",
    params: [{ key: "p1", label: "Window", min: 5, max: 60, step: 1, default: 20 }],
    lines: [{ name: "Vol Z", color: "#38bdf8", style: "histogram" }], refLines: [0, 1.5], formatValue: fmtSigned(2, "σ"),
  },

  // ===================== STATISTICAL & MARKET STRUCTURE (56..61) =====================
  {
    id: 56, key: "zscore", name: "Price Z-Score Mean Reversion", shortName: "Z-Score", category: "structure", placement: "oscillator",
    description: "Statistical standard deviations from rolling mean — classic quantitative pairs/reversion factor.",
    bullRule: "Price stretched below -2σ mean", bearRule: "Price stretched above +2σ mean",
    params: [
      { key: "p1", label: "Window", min: 5, max: 100, step: 1, default: 20 },
      { key: "p2", label: "Z-Band", min: 1.0, max: 3.5, step: 0.25, default: 2.0 },
    ],
    lines: [{ name: "Z-Score", color: "#c084fc" }], refLines: [-2, 0, 2], formatValue: fmtSigned(2, "σ"),
  },
  {
    id: 57, key: "eff_ratio", name: "Kaufman Efficiency Ratio (ER)", shortName: "Eff Ratio", category: "structure", placement: "oscillator",
    description: "Ratio of net price displacement to total path length distinguishing clean trends from random chop.",
    bullRule: "High ER directional upward efficiency", bearRule: "High ER directional downward efficiency",
    params: [{ key: "p1", label: "Period", min: 4, max: 40, step: 1, default: 14 }],
    lines: [{ name: "ER %", color: "#fbbf24" }], oscRange: [0, 100], refLines: [30, 60],
    formatValue: (v) => (Number.isFinite(v[0]) ? `${v[0].toFixed(0)}%` : "—"),
  },
  {
    id: 58, key: "pct_rank", name: "Rolling Percentile Rank", shortName: "Pct Rank", category: "structure", placement: "oscillator",
    description: "Exact percentile rank of current close within the rolling N-bar price distribution.",
    bullRule: "Trading in top decile (trend); invert for fade", bearRule: "Trading in bottom decile",
    params: [{ key: "p1", label: "Window", min: 10, max: 200, step: 5, default: 50 }],
    lines: [{ name: "Rank %", color: "#34d399" }], oscRange: [0, 100], refLines: [20, 50, 80],
    formatValue: (v) => (Number.isFinite(v[0]) ? `P${v[0].toFixed(0)}` : "—"),
  },
  {
    id: 59, key: "pivots", name: "Rolling Pivot S/R Structure", shortName: "Pivot S/R", category: "structure", placement: "overlay",
    description: "Dynamic floor-trader Pivot Point with R1 resistance and S1 support channels.",
    bullRule: "Price holding above Pivot Point", bearRule: "Price rejected below Pivot Point",
    params: [{ key: "p1", label: "Window", min: 5, max: 60, step: 1, default: 20 }],
    lines: [
      { name: "Pivot", color: "#f59e0b" },
      { name: "R1", color: "rgba(52, 211, 153, 0.55)", band: true },
      { name: "S1", color: "rgba(244, 63, 94, 0.55)", band: true },
    ],
    formatValue: fmtUsd,
  },
  {
    id: 60, key: "ha_streak", name: "Heikin-Ashi Streak Momentum", shortName: "HA Streak", category: "structure", placement: "oscillator",
    description: "Counts consecutive bullish/bearish smoothed Heikin-Ashi candles to measure trend continuity.",
    bullRule: "Consecutive bullish Heikin-Ashi run", bearRule: "Consecutive bearish Heikin-Ashi run",
    params: [{ key: "p1", label: "Scale Bars", min: 2, max: 15, step: 1, default: 5 }],
    lines: [{ name: "Streak", color: "#10b981", style: "histogram" }], refLines: [0],
    formatValue: (v) => (Number.isFinite(v[0]) ? `${v[0] > 0 ? "+" : ""}${v[0].toFixed(0)} bars` : "—"),
  },
  {
    id: 61, key: "candle_pressure", name: "Candle Body/Wick Imbalance", shortName: "Wick Pressure", category: "structure", placement: "oscillator",
    description: "EMA-smoothed microstructure ratio of candle body thrust and lower/upper wick rejection.",
    bullRule: "Strong bullish bodies & lower-wick absorption", bearRule: "Bearish bodies & upper-wick rejection",
    params: [{ key: "p1", label: "Smooth EMA", min: 2, max: 20, step: 1, default: 5 }],
    lines: [{ name: "Pressure", color: "#38bdf8", style: "histogram" }], refLines: [0], formatValue: fmtSigned(2),
  },
];

export const INDICATOR_BY_ID = new Map(INDICATOR_CATALOG.map((item) => [item.id, item]));
export const INDICATOR_BY_KEY = new Map(INDICATOR_CATALOG.map((item) => [item.key, item]));

export function createRuleFromCatalog(keyOrId, overrides = {}) {
  const meta = typeof keyOrId === "number" ? INDICATOR_BY_ID.get(keyOrId) : INDICATOR_BY_KEY.get(keyOrId);
  if (!meta) throw new Error(`Unknown indicator: ${keyOrId}`);
  const params = { p1: 0, p2: 0, p3: 0, p4: 0 };
  for (const p of meta.params) params[p.key] = p.default;
  return {
    uid: `${meta.key}_${Math.random().toString(36).slice(2, 7)}`,
    indicatorId: meta.id,
    key: meta.key,
    enabled: true,
    showOnChart: meta.placement === "overlay",
    weight: 1.5,
    mode: 0, // 0 = Strength, 1 = Binary Trigger, 2 = Regime Veto Filter
    triggerThresh: 0.35,
    vetoThresh: 0.25,
    invert: false,
    ...overrides,
    params: { ...params, ...(overrides.params || {}) },
  };
}
