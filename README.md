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
- **Paper Desk & Causal Market Replay:**
  - Persistent `$100k` portfolio, Market/Limit/Stop orders, bar-by-bar serialized causal Market Replay (next-bar Open auto-fills + causal tournament consensus), and optional **Alpaca Markets BYOK** (`<1s` IEX WebSocket + Paper API order mirroring with explicit broker status reporting).

## Quick Start

```bash
npm install
npm run build:wasm
npm test
npm run dev
```

Open [http://localhost:5180](http://localhost:5180).
