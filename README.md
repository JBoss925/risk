# Risk — WebAssembly Multi-Strategy Quant & Paper Trading Terminal

Zero-runtime-dependency browser quantitative research, multi-strategy consensus, backtesting, forecasting, and paper trading terminal powered by a compiled **56 KB WebAssembly** (`risk-engine.wasm`) compute kernel running inside a dedicated Web Worker.

## Capabilities

- **62 WebAssembly-Compiled Technical Indicators** across 5 categories:
  - **Trend (16):** `SMA`, `EMA Cross`, `WMA`, `Hull MA (HMA)`, `DEMA`, `TEMA`, `Kaufman Adaptive MA (KAMA)`, `Zero-Lag EMA (ZLEMA)`, `ALMA`, `Supertrend`, `ADX / DMI`, `Parabolic SAR`, `Ichimoku Cloud`, `Aroon Oscillator`, `Vortex (VI+/VI-)`, `Linear Regression Slope & R²`
  - **Momentum (18):** `RSI`, `Stochastic RSI`, `MACD`, `PPO`, `Stochastic %K/%D`, `CCI`, `Williams %R`, `ROC`, `MFI`, `Awesome Oscillator`, `TRIX`, `Ultimate Oscillator`, `CMO`, `True Strength Index (TSI)`, `Know Sure Thing (KST)`, `Coppock Curve`, `DPO`, `Elder Ray`
  - **Volatility & Channels (12):** `Bollinger Bands (%B)`, `Bollinger BandWidth Squeeze`, `ATR Volatility Regime`, `Keltner Channels`, `Donchian Channels`, `Chaikin Volatility`, `Ulcer Index`, `Historical Realized Vol`, `Mass Index`, `Chandelier Exit`, `ATR Trailing Stop`, `Standard Error Bands`
  - **Volume & Microstructure (10):** `Rolling VWAP (±1σ)`, `OBV Trend`, `Chaikin Money Flow (CMF)`, `A/D Line`, `Chaikin Oscillator`, `Elder Force Index`, `Ease of Movement (EMV)`, `Volume Price Trend (VPT)`, `Klinger Volume Oscillator (KVO)`, `Relative Volume Surge`
  - **Structure & Statistical (6):** `Price Z-Score`, `Kaufman Efficiency Ratio (ER)`, `Rolling Percentile Rank`, `Rolling Pivot S/R`, `Heikin-Ashi Streak`, `Candle Body/Wick Imbalance`
- **24 Built-In Quantitative Strategies + Custom Strategy Creator Studio:**
  - Composable rules with continuous **Strength**, binary **Trigger**, and **Veto Gate** modes, polarity **Invert**, and custom thresholds mapping `-100..+100` to **STRONG BUY / BUY / HOLD / SELL / STRONG SELL**.
  - **Live `<1ms` WASM Preview** inside the Strategy Creator Studio (shows live verdict, Return, Sharpe, OOS Sharpe, Max DD, equity sparkline, and projected Leaderboard rank as you drag sliders).
  - Rich **`⌘K` Strategy Switcher**, **`[` / `]`** instant strategy cycling, URL hash deep-linking, and JSON import/export.
- **Multi-Strategy Consensus & Agreement Visualization:**
  - **Strategy Agreement Matrix (`24 × Time` heatmap)** directly under the price chart showing every strategy grouped by family across every bar — click any row to activate it.
  - **Pinned Strategies Overlay** plotting Active + up to 4 pinned strategies with unanimous agreement zone shading.
  - **Two Zero-Lookahead Meta-Ensembles:** *All-Strategy Consensus (Equal Weight)* and *Rolling OOS Sharpe Ensemble* (20-bar strictly causal trailing rebalance with 60-bar warmup).
- **Strictly Causal Backtester, 2D Sweep, Monte Carlo & Forecast Lab:**
  - Next-bar Open execution, exact entry + exit commission accounting, held-out final **30% Out-of-Sample (OOS)** split metrics, 196-grid Sharpe heatmap, portfolio-scaled 1,000-path Monte Carlo bootstrap, and frozen-origin causal Walk-Forward Kalman + Regularized Logistic/Ridge forecasting.
- **52-Market Blue-Chip, Fortune 100 & Major Index Universe + Live Signal Scanner:**
  - Curated 52-symbol universe spanning Major Indexes (`SPY`, `QQQ`, `DIA`, `IWM`, `^GSPC`, `^NDX`, `^DJI`), Big Tech & Semis (`NVDA`, `TSLA`, `GOOG`, `AAPL`, `MSFT`, `AMZN`, `META`, `INTC`, `AMD`, `AVGO`, …), Payments & Finance (`V`, `MA`, `JPM`, `BAC`, `BRK-B`, …), Healthcare, Consumer, and Energy/Industrials.
  - Built-in **⚡ Scan Live Signals** scanner across the 26 flagship markets with instant **All / Actionable / Buys / Sells / Sort |Score|** filters.
- **Multi-Asset WASM Benchmark Leaderboard (`npm run benchmark`):**
  - Pre-computed **9,785 authentic WebAssembly backtests** across 26 flagship stocks & indexes × 4 timeframes (`1d/1y`, `1d/2y`, `1h/3mo`, `15m/1mo`) × 24 strategies × 4 risk/threshold profiles (`Standard Long`, `SL 5% / TP 15%`, `Long/Short`, `Train-Optimized Cutoffs`).
  - **Collapsible Benchmark Drawer** under every Strategy Arena row listing exact tested settings, 70% Train & 30% Held-Out OOS metrics, and **1-click `Chart →` / `Simulate OOS →`** launchers that reproduce the exact saved parameters and held-out window.
- **Real-Time Terminal Trade Co-Pilot & OCO Bracket Execution:**
  - Floating **Trade Recommendation Popup** directly on the Terminal chart with ATR-based Stop-Loss, Take-Profit, Risk:Reward ratio, risk-% position sizing (`0.5% / 1% / 1.5% / 2.5%`), top indicator drivers, and **Accept / Decline** buttons, plus a live open-position quick-flatten pill and opaque Entry/SL/TP reference overlays.
  - True **OCO (One-Cancels-Other) Brackets** with conservative Stop-First ordering, realistic gap-through stop fill pricing, automatic sibling cleanup on flatten, serialized `inFlightClientOrderId` exit locks for Alpaca Paper reconciliation, and **Live Auto-Poll** bar updates.
- **Interactive Live-Chart Paper Trading Simulator (`Simulator` tab):**
  - Full Terminal-grade candlestick chart, indicator overlays, causal Forecast Cone, Consensus Ribbon, and 24-Strategy Agreement Matrix rendered strictly on revealed bars `[0..cursor]` with zero look-ahead.
  - **Inherited Top-Right Interval & Range + Custom Replay Region:** Automatically inherits the top-right bar interval (`5m`, `15m`, `1h`, `1D`, `1W`) and chart length (`5D`–`5Y`), with granular **`START` / `END`** bar/date region bounds and quick length pills (`Last 30`, `Last 60`, `Last 120`, `Full Region`).
  - **Co-Pilot Auto-Pause Prompts & Live Scoreboard:** Pauses automatically on *Signal Shift*, *Strong Buy/Sell Only*, *≥70% Consensus*, *Actionable Entry/Exit*, or *Manual Only*, with `Instant Close` vs `Next-Bar Open` fills, Stop-Loss / Take-Profit brackets, and live **You vs. Armed Strategy (with SL/TP & shorting parity) vs. Buy & Hold** scoreboard.
- **Paper Desk & Causal Market Replay:**
  - Persistent `$100k` portfolio, exact net-of-commission realized & unrealized PnL, Market/Limit/Stop/OCO orders, bar-by-bar serialized causal Market Replay, and optional **Alpaca Markets BYOK** (`<1s` IEX WebSocket + native `order_class: "bracket"` submission & idempotent `client_order_id` reconciliation).

## Quick Start

```bash
npm install
npm run build:wasm
npm test
npm run benchmark   # optional: refresh multi-asset benchmarks.json
npm run dev
```

Open [http://localhost:5180](http://localhost:5180).
