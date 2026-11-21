import { createRuleFromCatalog } from "./indicators.js";

export const DEFAULT_THRESHOLDS = {
  strongBuy: 52,
  buy: 18,
  sell: -18,
  strongSell: -52,
};

export const STRATEGY_FAMILIES = [
  { id: "all", label: "All Families" },
  { id: "multi", label: "Multi-Factor" },
  { id: "trend", label: "Trend" },
  { id: "momentum", label: "Momentum" },
  { id: "reversion", label: "Mean Reversion" },
  { id: "volatility", label: "Volatility & Breakout" },
  { id: "volume", label: "Volume Flow" },
  { id: "custom", label: "My Strategies" },
];

export function classifyScore(score, thresholds = DEFAULT_THRESHOLDS) {
  if (score >= thresholds.strongBuy) return { id: "strong_buy", label: "STRONG BUY", short: "STR BUY", tone: "strong-buy" };
  if (score >= thresholds.buy) return { id: "buy", label: "BUY", short: "BUY", tone: "buy" };
  if (score <= thresholds.strongSell) return { id: "strong_sell", label: "STRONG SELL", short: "STR SELL", tone: "strong-sell" };
  if (score <= thresholds.sell) return { id: "sell", label: "SELL", short: "SELL", tone: "sell" };
  return { id: "hold", label: "HOLD", short: "HOLD", tone: "hold" };
}

const r = (key, opts = {}) => createRuleFromCatalog(key, opts);

// 24 Diverse, Authentic Quantitative Strategies spanning all 62 WASM indicators
export const BUILTIN_STRATEGIES = [
  {
    id: "quant_composite",
    name: "Quant Multi-Factor Core",
    family: "multi",
    description: "Balanced institutional blend of trend structure, MACD momentum, ADX strength, CMF flow, and SMA regime filtering.",
    thresholds: { strongBuy: 52, buy: 18, sell: -18, strongSell: -52 },
    buildRules: () => [
      r("ema_cross", { weight: 2.2, params: { p1: 12, p2: 26 }, showOnChart: true }),
      r("supertrend", { weight: 2.0, params: { p1: 10, p2: 3.0 }, showOnChart: true }),
      r("macd", { weight: 1.8, params: { p1: 12, p2: 26, p3: 9 }, showOnChart: false }),
      r("rsi", { weight: 1.2, params: { p1: 14, p2: 30, p3: 70 }, showOnChart: false }),
      r("adx", { weight: 1.5, params: { p1: 14, p2: 20 }, showOnChart: false }),
      r("cmf", { weight: 1.4, params: { p1: 20 }, showOnChart: false }),
      r("sma", { weight: 1.8, mode: 2, vetoThresh: 0.2, params: { p1: 100 }, showOnChart: true }),
    ],
  },
  {
    id: "trend_rider",
    name: "Trend Momentum Rider",
    family: "trend",
    description: "Rides clean directional waves with Hull MA, Supertrend, ADX, MACD, Donchian breakout, and ROC thrust.",
    thresholds: { strongBuy: 55, buy: 22, sell: -22, strongSell: -55 },
    buildRules: () => [
      r("hma", { weight: 2.4, params: { p1: 21 }, showOnChart: true }),
      r("supertrend", { weight: 2.2, params: { p1: 10, p2: 2.75 }, showOnChart: true }),
      r("adx", { weight: 1.8, params: { p1: 14, p2: 20 }, showOnChart: false }),
      r("macd", { weight: 1.8, params: { p1: 12, p2: 26, p3: 9 }, showOnChart: false }),
      r("donchian", { weight: 1.5, params: { p1: 20 }, showOnChart: false }),
      r("roc", { weight: 1.2, params: { p1: 12, p2: 5 }, showOnChart: false }),
    ],
  },
  {
    id: "kaufman_adaptive",
    name: "Kaufman Adaptive Regime",
    family: "trend",
    description: "Self-adapting KAMA + Efficiency Ratio + TSI momentum guarded by Chandelier Exit and ATR stress veto.",
    thresholds: { strongBuy: 50, buy: 18, sell: -18, strongSell: -50 },
    buildRules: () => [
      r("kama", { weight: 2.5, params: { p1: 10, p2: 2, p3: 30 }, showOnChart: true }),
      r("eff_ratio", { weight: 1.8, params: { p1: 14 }, showOnChart: false }),
      r("tsi", { weight: 2.0, params: { p1: 25, p2: 13, p3: 7 }, showOnChart: false }),
      r("chandelier", { weight: 2.0, params: { p1: 22, p2: 3.0 }, showOnChart: true }),
      r("atr", { weight: 1.5, mode: 2, vetoThresh: 0.35, params: { p1: 14, p2: 50 }, showOnChart: false }),
    ],
  },
  {
    id: "elder_triple_screen",
    name: "Elder Triple Screen",
    family: "multi",
    description: "Classic Alexander Elder system fusing EMA trend tide, Elder Ray power, Force Index, Stochastic timing, and ADX.",
    thresholds: { strongBuy: 50, buy: 18, sell: -18, strongSell: -50 },
    buildRules: () => [
      r("ema_cross", { weight: 2.2, params: { p1: 13, p2: 34 }, showOnChart: true }),
      r("elder_ray", { weight: 2.0, params: { p1: 13 }, showOnChart: false }),
      r("force_idx", { weight: 1.9, params: { p1: 13 }, showOnChart: false }),
      r("stoch", { weight: 1.3, params: { p1: 14, p2: 3, p3: 20, p4: 80 }, showOnChart: false }),
      r("adx", { weight: 1.4, params: { p1: 14, p2: 20 }, showOnChart: false }),
    ],
  },
  {
    id: "turtle_donchian",
    name: "Turtle Donchian Breakout",
    family: "volatility",
    description: "Modernized Richard Dennis Turtle rules: 20-bar Donchian channel breakout, ATR Trailing Stop, Vortex & Volume Surge.",
    thresholds: { strongBuy: 54, buy: 22, sell: -20, strongSell: -54 },
    buildRules: () => [
      r("donchian", { weight: 2.6, params: { p1: 20 }, showOnChart: true }),
      r("atr_stop", { weight: 2.2, params: { p1: 14, p2: 2.5 }, showOnChart: true }),
      r("vortex", { weight: 1.8, params: { p1: 14 }, showOnChart: false }),
      r("adx", { weight: 1.5, params: { p1: 14, p2: 18 }, showOnChart: false }),
      r("vol_surge", { weight: 1.2, params: { p1: 20 }, showOnChart: false }),
    ],
  },
  {
    id: "ichimoku_sovereign",
    name: "Ichimoku Kumo Sovereign",
    family: "trend",
    description: "Full Japanese cloud trend architecture confirmed by Aroon trend age, Klinger Volume, CMO, and VWAP.",
    thresholds: { strongBuy: 52, buy: 20, sell: -20, strongSell: -52 },
    buildRules: () => [
      r("ichimoku", { weight: 2.8, params: { p1: 9, p2: 26, p3: 52 }, showOnChart: true }),
      r("aroon", { weight: 1.6, params: { p1: 25 }, showOnChart: false }),
      r("kvo", { weight: 1.5, params: { p1: 34, p2: 55, p3: 13 }, showOnChart: false }),
      r("cmo", { weight: 1.4, params: { p1: 14 }, showOnChart: false }),
      r("vwap", { weight: 1.5, params: { p1: 20 }, showOnChart: false }),
    ],
  },
  {
    id: "zero_lag_pulse",
    name: "Zero-Lag Momentum Pulse",
    family: "momentum",
    description: "Minimal-phase ZLEMA + TEMA paired with PPO, TRIX, and Awesome Oscillator for rapid inflection capture.",
    thresholds: { strongBuy: 52, buy: 19, sell: -19, strongSell: -52 },
    buildRules: () => [
      r("zlema", { weight: 2.3, params: { p1: 18 }, showOnChart: true }),
      r("tema", { weight: 2.1, params: { p1: 21 }, showOnChart: true }),
      r("ppo", { weight: 1.9, params: { p1: 12, p2: 26, p3: 9 }, showOnChart: false }),
      r("trix", { weight: 1.7, params: { p1: 15, p2: 9 }, showOnChart: false }),
      r("ao", { weight: 1.4, params: { p1: 5, p2: 34 }, showOnChart: false }),
    ],
  },
  {
    id: "gaussian_alma_swing",
    name: "Gaussian ALMA Swing",
    family: "trend",
    description: "Low-noise Arnaud Legoux MA & Linear Regression R² trend core refined by Ultimate Oscillator and CMF.",
    thresholds: { strongBuy: 50, buy: 18, sell: -18, strongSell: -50 },
    buildRules: () => [
      r("alma", { weight: 2.5, params: { p1: 20, p2: 0.85, p3: 6 }, showOnChart: true }),
      r("linreg", { weight: 2.2, params: { p1: 20 }, showOnChart: true }),
      r("uo", { weight: 1.3, params: { p1: 7, p2: 14, p3: 28 }, showOnChart: false }),
      r("cmf", { weight: 1.6, params: { p1: 20 }, showOnChart: false }),
      r("rsi", { weight: 1.0, params: { p1: 14, p2: 30, p3: 70 }, showOnChart: false }),
    ],
  },
  {
    id: "mean_reversion",
    name: "Mean Reversion Snapback",
    family: "reversion",
    description: "Buys statistical oversold extremes and fades stretched rallies using RSI, Bollinger, Stoch, MFI & CCI.",
    thresholds: { strongBuy: 48, buy: 18, sell: -18, strongSell: -48 },
    buildRules: () => [
      r("rsi", { weight: 2.4, params: { p1: 14, p2: 30, p3: 70 }, showOnChart: false }),
      r("bbands", { weight: 2.3, params: { p1: 20, p2: 2.0 }, showOnChart: true }),
      r("stoch", { weight: 1.7, params: { p1: 14, p2: 3, p3: 20, p4: 80 }, showOnChart: false }),
      r("mfi", { weight: 1.6, params: { p1: 14, p2: 20, p3: 80 }, showOnChart: false }),
      r("cci", { weight: 1.4, params: { p1: 20, p2: 100 }, showOnChart: false }),
      r("atr", { weight: 1.3, mode: 2, vetoThresh: 0.35, params: { p1: 14, p2: 50 }, showOnChart: false }),
    ],
  },
  {
    id: "stat_zscore_arb",
    name: "Statistical Z-Score Arb",
    family: "reversion",
    description: "Pure statistical reversion combining Price Z-Score, Standard Error Bands, Stoch RSI, Williams %R & DPO.",
    thresholds: { strongBuy: 48, buy: 18, sell: -18, strongSell: -48 },
    buildRules: () => [
      r("zscore", { weight: 2.5, params: { p1: 20, p2: 2.0 }, showOnChart: false }),
      r("stderr_bands", { weight: 2.3, params: { p1: 21, p2: 2.0 }, showOnChart: true }),
      r("stoch_rsi", { weight: 1.8, params: { p1: 14, p2: 14, p3: 3 }, showOnChart: false }),
      r("willr", { weight: 1.5, params: { p1: 14, p2: -80, p3: -20 }, showOnChart: false }),
      r("dpo", { weight: 1.3, params: { p1: 20 }, showOnChart: false }),
    ],
  },
  {
    id: "volatility_breakout",
    name: "Volatility Squeeze Breakout",
    family: "volatility",
    description: "Inverted Bollinger breakout + BB Squeeze expansion + Keltner Channels + Donchian + OBV confirmation.",
    thresholds: { strongBuy: 54, buy: 20, sell: -20, strongSell: -54 },
    buildRules: () => [
      r("bbands", { weight: 2.2, invert: true, params: { p1: 20, p2: 2.0 }, showOnChart: true }),
      r("bb_squeeze", { weight: 1.8, params: { p1: 20, p2: 2.0 }, showOnChart: false }),
      r("keltner", { weight: 2.0, params: { p1: 20, p2: 1.75 }, showOnChart: true }),
      r("donchian", { weight: 1.9, params: { p1: 20 }, showOnChart: false }),
      r("obv", { weight: 1.6, params: { p1: 10, p2: 30 }, showOnChart: false }),
      r("vwap", { weight: 1.5, params: { p1: 20 }, showOnChart: false }),
    ],
  },
  {
    id: "smart_money_flow",
    name: "Institutional Flow & VWAP",
    family: "volume",
    description: "Tracks volume-weighted accumulation via VWAP, CMF, OBV, Ichimoku structure, and MFI.",
    thresholds: { strongBuy: 50, buy: 18, sell: -18, strongSell: -50 },
    buildRules: () => [
      r("vwap", { weight: 2.4, params: { p1: 20 }, showOnChart: true }),
      r("cmf", { weight: 2.2, params: { p1: 20 }, showOnChart: false }),
      r("obv", { weight: 1.8, params: { p1: 10, p2: 30 }, showOnChart: false }),
      r("ichimoku", { weight: 1.9, params: { p1: 9, p2: 26, p3: 52 }, showOnChart: true }),
      r("mfi", { weight: 1.2, params: { p1: 14, p2: 20, p3: 80 }, showOnChart: false }),
    ],
  },
  {
    id: "stealth_accumulation",
    name: "Stealth Volume Accumulation",
    family: "volume",
    description: "Pure microstructure capital-flow engine: A/D Line, Chaikin Oscillator, VPT, EMV, CMF, and Klinger KVO.",
    thresholds: { strongBuy: 50, buy: 18, sell: -18, strongSell: -50 },
    buildRules: () => [
      r("adl", { weight: 2.2, params: { p1: 10, p2: 30 }, showOnChart: false }),
      r("chaikin_osc", { weight: 2.0, params: { p1: 3, p2: 10 }, showOnChart: false }),
      r("vpt", { weight: 2.0, params: { p1: 8, p2: 21 }, showOnChart: false }),
      r("emv", { weight: 1.5, params: { p1: 14 }, showOnChart: false }),
      r("cmf", { weight: 1.8, params: { p1: 20 }, showOnChart: false }),
      r("kvo", { weight: 1.6, params: { p1: 34, p2: 55, p3: 13 }, showOnChart: false }),
    ],
  },
  {
    id: "defensive_low_dd",
    name: "Defensive Low-Drawdown",
    family: "multi",
    description: "Capital-preservation focus: SMA 120 macro veto, Ulcer Index downside guard, Realized Vol filter, KAMA & Chandelier.",
    thresholds: { strongBuy: 55, buy: 24, sell: -14, strongSell: -45 },
    buildRules: () => [
      r("kama", { weight: 2.4, params: { p1: 12, p2: 2, p3: 30 }, showOnChart: true }),
      r("chandelier", { weight: 2.3, params: { p1: 22, p2: 2.75 }, showOnChart: true }),
      r("ulcer", { weight: 2.0, params: { p1: 14 }, showOnChart: false }),
      r("hist_vol", { weight: 1.6, mode: 2, vetoThresh: 0.25, params: { p1: 20 }, showOnChart: false }),
      r("sma", { weight: 2.2, mode: 2, vetoThresh: 0.15, params: { p1: 120 }, showOnChart: true }),
      r("cmf", { weight: 1.3, params: { p1: 20 }, showOnChart: false }),
    ],
  },
  {
    id: "parabolic_accel",
    name: "Parabolic Trend Accelerator",
    family: "momentum",
    description: "Aggressive trend acceleration hunting strong impulses via Parabolic SAR, DEMA, Vortex, ROC & Force Index.",
    thresholds: { strongBuy: 54, buy: 20, sell: -20, strongSell: -54 },
    buildRules: () => [
      r("psar", { weight: 2.4, params: { p1: 0.02, p2: 0.2 }, showOnChart: true }),
      r("dema", { weight: 2.1, params: { p1: 20 }, showOnChart: true }),
      r("vortex", { weight: 1.8, params: { p1: 14 }, showOnChart: false }),
      r("roc", { weight: 1.6, params: { p1: 12, p2: 5 }, showOnChart: false }),
      r("force_idx", { weight: 1.6, params: { p1: 13 }, showOnChart: false }),
    ],
  },
  {
    id: "cycle_reversal_hunter",
    name: "Cycle & Reversal Hunter",
    family: "momentum",
    description: "Targets major turning points with Coppock Curve, KST, Mass Index reversal bulges, Stoch RSI & Wick Pressure.",
    thresholds: { strongBuy: 48, buy: 17, sell: -17, strongSell: -48 },
    buildRules: () => [
      r("coppock", { weight: 2.3, params: { p1: 10, p2: 14, p3: 11 }, showOnChart: false }),
      r("kst", { weight: 2.1, params: { p1: 9 }, showOnChart: false }),
      r("mass_index", { weight: 1.5, params: { p1: 9, p2: 25 }, showOnChart: false }),
      r("stoch_rsi", { weight: 1.4, params: { p1: 14, p2: 14, p3: 3 }, showOnChart: false }),
      r("candle_pressure", { weight: 1.4, params: { p1: 5 }, showOnChart: false }),
    ],
  },
  {
    id: "heikin_ashi_flow",
    name: "Heikin-Ashi Structure Flow",
    family: "trend",
    description: "Smoothed candle trend streaks backed by Hull MA, Supertrend, TSI momentum, and Relative Volume Surge.",
    thresholds: { strongBuy: 52, buy: 20, sell: -20, strongSell: -52 },
    buildRules: () => [
      r("ha_streak", { weight: 2.4, params: { p1: 5 }, showOnChart: false }),
      r("hma", { weight: 2.2, params: { p1: 21 }, showOnChart: true }),
      r("supertrend", { weight: 2.0, params: { p1: 10, p2: 3.0 }, showOnChart: true }),
      r("tsi", { weight: 1.7, params: { p1: 25, p2: 13, p3: 7 }, showOnChart: false }),
      r("vol_surge", { weight: 1.2, params: { p1: 20 }, showOnChart: false }),
    ],
  },
  {
    id: "pivot_breakout_desk",
    name: "Pivot & Percentile Breakout",
    family: "volatility",
    description: "Floor-trader Pivot S/R breakouts confirmed by Rolling Percentile Rank, Donchian, MACD, and OBV.",
    thresholds: { strongBuy: 54, buy: 20, sell: -20, strongSell: -54 },
    buildRules: () => [
      r("pivots", { weight: 2.3, params: { p1: 20 }, showOnChart: true }),
      r("pct_rank", { weight: 2.0, params: { p1: 50 }, showOnChart: false }),
      r("donchian", { weight: 1.9, params: { p1: 20 }, showOnChart: false }),
      r("macd", { weight: 1.7, params: { p1: 12, p2: 26, p3: 9 }, showOnChart: false }),
      r("obv", { weight: 1.5, params: { p1: 10, p2: 30 }, showOnChart: false }),
    ],
  },
  {
    id: "binary_high_conviction",
    name: "Strict Binary Trigger Matrix",
    family: "multi",
    description: "Zero soft votes — every indicator fires in strict Binary Trigger mode (TRUE/FALSE) for ultra-clean entries.",
    thresholds: { strongBuy: 60, buy: 25, sell: -25, strongSell: -60 },
    buildRules: () => [
      r("ema_cross", { weight: 2.0, mode: 1, triggerThresh: 0.25, params: { p1: 12, p2: 26 }, showOnChart: true }),
      r("supertrend", { weight: 2.0, mode: 1, triggerThresh: 0.3, params: { p1: 10, p2: 3.0 }, showOnChart: true }),
      r("macd", { weight: 2.0, mode: 1, triggerThresh: 0.25, params: { p1: 12, p2: 26, p3: 9 }, showOnChart: false }),
      r("adx", { weight: 1.5, mode: 1, triggerThresh: 0.25, params: { p1: 14, p2: 20 }, showOnChart: false }),
      r("cmf", { weight: 1.5, mode: 1, triggerThresh: 0.2, params: { p1: 20 }, showOnChart: false }),
    ],
  },
  {
    id: "intraday_scalper",
    name: "Fast Microstructure Scalper",
    family: "momentum",
    description: "Short-lookback ZLEMA, VWAP, Stochastic, Williams %R, and Candle Wick Pressure built for rapid swings.",
    thresholds: { strongBuy: 48, buy: 16, sell: -16, strongSell: -48 },
    buildRules: () => [
      r("zlema", { weight: 2.2, params: { p1: 9 }, showOnChart: true }),
      r("vwap", { weight: 2.0, params: { p1: 12 }, showOnChart: true }),
      r("stoch", { weight: 1.6, params: { p1: 9, p2: 3, p3: 20, p4: 80 }, showOnChart: false }),
      r("willr", { weight: 1.4, params: { p1: 9, p2: -80, p3: -20 }, showOnChart: false }),
      r("candle_pressure", { weight: 1.8, params: { p1: 3 }, showOnChart: false }),
    ],
  },
  {
    id: "contrarian_exhaustion",
    name: "Contrarian Exhaustion Fade",
    family: "reversion",
    description: "Fades extreme multi-oscillator overextensions using inverted Percentile Rank, RSI, CCI, Bollinger, and Z-Score.",
    thresholds: { strongBuy: 50, buy: 20, sell: -20, strongSell: -50 },
    buildRules: () => [
      r("pct_rank", { weight: 2.1, invert: true, params: { p1: 40 }, showOnChart: false }),
      r("rsi", { weight: 2.2, params: { p1: 10, p2: 28, p3: 72 }, showOnChart: false }),
      r("cci", { weight: 1.8, params: { p1: 20, p2: 100 }, showOnChart: false }),
      r("bbands", { weight: 2.0, params: { p1: 20, p2: 2.25 }, showOnChart: true }),
      r("zscore", { weight: 1.8, params: { p1: 20, p2: 2.0 }, showOnChart: false }),
    ],
  },
  {
    id: "macro_compounder",
    name: "Macro Structural Compounder",
    family: "trend",
    description: "Patient long-horizon trend capture combining SMA 50, Ichimoku, Coppock, KST, Linear Regression R² & ADX.",
    thresholds: { strongBuy: 50, buy: 16, sell: -22, strongSell: -55 },
    buildRules: () => [
      r("sma", { weight: 2.2, params: { p1: 50 }, showOnChart: true }),
      r("ichimoku", { weight: 2.2, params: { p1: 9, p2: 26, p3: 52 }, showOnChart: true }),
      r("coppock", { weight: 1.9, params: { p1: 10, p2: 14, p3: 11 }, showOnChart: false }),
      r("kst", { weight: 1.8, params: { p1: 9 }, showOnChart: false }),
      r("linreg", { weight: 1.8, params: { p1: 30 }, showOnChart: false }),
      r("adx", { weight: 1.3, params: { p1: 14, p2: 20 }, showOnChart: false }),
    ],
  },
  {
    id: "vortex_chandelier",
    name: "Vortex & Chandelier Breakout",
    family: "volatility",
    description: "Directional volatility capture pairing Vortex VI+/VI-, Chandelier Exit, Keltner Channels, KVO & Efficiency Ratio.",
    thresholds: { strongBuy: 52, buy: 20, sell: -20, strongSell: -52 },
    buildRules: () => [
      r("vortex", { weight: 2.3, params: { p1: 14 }, showOnChart: false }),
      r("chandelier", { weight: 2.3, params: { p1: 22, p2: 3.0 }, showOnChart: true }),
      r("keltner", { weight: 2.0, params: { p1: 20, p2: 2.0 }, showOnChart: true }),
      r("kvo", { weight: 1.5, params: { p1: 34, p2: 55, p3: 13 }, showOnChart: false }),
      r("eff_ratio", { weight: 1.5, params: { p1: 14 }, showOnChart: false }),
    ],
  },
  {
    id: "all_weather_parity",
    name: "All-Weather Risk Parity",
    family: "multi",
    description: "Cross-regime balance combining KAMA trend, VWAP value, TSI momentum, Ulcer safety, CMF flow & Realized Vol veto.",
    thresholds: { strongBuy: 50, buy: 18, sell: -18, strongSell: -50 },
    buildRules: () => [
      r("kama", { weight: 2.0, params: { p1: 10, p2: 2, p3: 30 }, showOnChart: true }),
      r("vwap", { weight: 1.8, params: { p1: 20 }, showOnChart: true }),
      r("tsi", { weight: 1.8, params: { p1: 25, p2: 13, p3: 7 }, showOnChart: false }),
      r("ulcer", { weight: 1.5, params: { p1: 14 }, showOnChart: false }),
      r("cmf", { weight: 1.6, params: { p1: 20 }, showOnChart: false }),
      r("chaikin_vol", { weight: 1.2, mode: 2, vetoThresh: 0.35, params: { p1: 10, p2: 10 }, showOnChart: false }),
    ],
  },
];

// Keep backwards-compatible alias
export const STRATEGY_PRESETS = BUILTIN_STRATEGIES;

// ---- Custom User Strategy Persistence (localStorage) ----
const CUSTOM_KEY = "risk_custom_strategies_v1";

export function loadCustomStrategies() {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCustomStrategies(list) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function materializeStrategy(def) {
  return {
    id: def.id,
    name: def.name,
    family: def.family || "custom",
    description: def.description || "",
    isCustom: Boolean(def.isCustom),
    thresholds: { ...DEFAULT_THRESHOLDS, ...(def.thresholds || {}) },
    rules: typeof def.buildRules === "function" ? def.buildRules() : (def.rules || []).map((x) => ({ ...x, params: { ...x.params } })),
  };
}

export function getAllStrategies() {
  const builtins = BUILTIN_STRATEGIES.map(materializeStrategy);
  const customs = loadCustomStrategies().map((c) => materializeStrategy({ ...c, isCustom: true, family: c.family || "custom" }));
  return [...customs, ...builtins];
}

export const POPULAR_TICKERS = [
  { symbol: "NVDA", name: "NVIDIA Corp." },
  { symbol: "AAPL", name: "Apple Inc." },
  { symbol: "SPY", name: "SPDR S&P 500 ETF" },
  { symbol: "MSFT", name: "Microsoft Corp." },
  { symbol: "TSLA", name: "Tesla Inc." },
  { symbol: "META", name: "Meta Platforms" },
  { symbol: "AMD", name: "Advanced Micro Devices" },
  { symbol: "QQQ", name: "Invesco QQQ Trust" },
  { symbol: "BTC-USD", name: "Bitcoin USD" },
];
