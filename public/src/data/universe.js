// Curated Universe of Major Indexes, Mega-Cap Tech, Fortune 100 & Blue-Chip Equities

export const UNIVERSE_GROUPS = [
  { id: "indexes", label: "Major Indexes" },
  { id: "tech", label: "Big Tech & Semis" },
  { id: "finance", label: "Payments & Finance" },
  { id: "health", label: "Healthcare & Pharma" },
  { id: "consumer", label: "Consumer & Retail" },
  { id: "industrial", label: "Energy & Industrials" },
];

export const MARKET_UNIVERSE = [
  // Major Indexes & Benchmark ETFs
  { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", group: "indexes", benchmark: true },
  { symbol: "QQQ", name: "Invesco Nasdaq-100 ETF", group: "indexes", benchmark: true },
  { symbol: "DIA", name: "SPDR Dow Jones Industrial Avg ETF", group: "indexes", benchmark: true },
  { symbol: "IWM", name: "iShares Russell 2000 ETF", group: "indexes", benchmark: true },
  { symbol: "^GSPC", name: "S&P 500 Index", group: "indexes", benchmark: false },
  { symbol: "^NDX", name: "Nasdaq-100 Index", group: "indexes", benchmark: false },
  { symbol: "^DJI", name: "Dow Jones Industrial Average", group: "indexes", benchmark: false },

  // Big Tech & Semiconductors
  { symbol: "NVDA", name: "NVIDIA Corporation", group: "tech", benchmark: true },
  { symbol: "TSLA", name: "Tesla, Inc.", group: "tech", benchmark: true },
  { symbol: "GOOG", name: "Alphabet Inc. (Google)", group: "tech", benchmark: true },
  { symbol: "AAPL", name: "Apple Inc.", group: "tech", benchmark: true },
  { symbol: "MSFT", name: "Microsoft Corporation", group: "tech", benchmark: true },
  { symbol: "AMZN", name: "Amazon.com, Inc.", group: "tech", benchmark: true },
  { symbol: "META", name: "Meta Platforms, Inc.", group: "tech", benchmark: true },
  { symbol: "INTC", name: "Intel Corporation", group: "tech", benchmark: true },
  { symbol: "AMD", name: "Advanced Micro Devices", group: "tech", benchmark: true },
  { symbol: "AVGO", name: "Broadcom Inc.", group: "tech", benchmark: true },
  { symbol: "ORCL", name: "Oracle Corporation", group: "tech", benchmark: false },
  { symbol: "NFLX", name: "Netflix, Inc.", group: "tech", benchmark: false },
  { symbol: "CRM", name: "Salesforce, Inc.", group: "tech", benchmark: false },
  { symbol: "CSCO", name: "Cisco Systems, Inc.", group: "tech", benchmark: false },
  { symbol: "IBM", name: "International Business Machines", group: "tech", benchmark: false },
  { symbol: "QCOM", name: "Qualcomm Incorporated", group: "tech", benchmark: false },

  // Payments & Finance (Fortune 100 Blue Chips)
  { symbol: "V", name: "Visa Inc.", group: "finance", benchmark: true },
  { symbol: "MA", name: "Mastercard Incorporated", group: "finance", benchmark: true },
  { symbol: "JPM", name: "JPMorgan Chase & Co.", group: "finance", benchmark: true },
  { symbol: "BAC", name: "Bank of America Corp.", group: "finance", benchmark: true },
  { symbol: "BRK-B", name: "Berkshire Hathaway Inc. (B)", group: "finance", benchmark: true },
  { symbol: "GS", name: "Goldman Sachs Group, Inc.", group: "finance", benchmark: false },
  { symbol: "WFC", name: "Wells Fargo & Company", group: "finance", benchmark: false },
  { symbol: "AXP", name: "American Express Company", group: "finance", benchmark: false },

  // Healthcare & Pharma
  { symbol: "UNH", name: "UnitedHealth Group Inc.", group: "health", benchmark: true },
  { symbol: "JNJ", name: "Johnson & Johnson", group: "health", benchmark: true },
  { symbol: "LLY", name: "Eli Lilly and Company", group: "health", benchmark: true },
  { symbol: "ABBV", name: "AbbVie Inc.", group: "health", benchmark: false },
  { symbol: "PFE", name: "Pfizer Inc.", group: "health", benchmark: false },
  { symbol: "MRK", name: "Merck & Co., Inc.", group: "health", benchmark: false },

  // Consumer & Retail
  { symbol: "WMT", name: "Walmart Inc.", group: "consumer", benchmark: true },
  { symbol: "COST", name: "Costco Wholesale Corp.", group: "consumer", benchmark: true },
  { symbol: "HD", name: "The Home Depot, Inc.", group: "consumer", benchmark: true },
  { symbol: "PG", name: "Procter & Gamble Co.", group: "consumer", benchmark: false },
  { symbol: "KO", name: "The Coca-Cola Company", group: "consumer", benchmark: false },
  { symbol: "PEP", name: "PepsiCo, Inc.", group: "consumer", benchmark: false },
  { symbol: "MCD", name: "McDonald's Corporation", group: "consumer", benchmark: false },
  { symbol: "DIS", name: "The Walt Disney Company", group: "consumer", benchmark: false },
  { symbol: "NKE", name: "NIKE, Inc.", group: "consumer", benchmark: false },

  // Energy & Industrials
  { symbol: "XOM", name: "Exxon Mobil Corporation", group: "industrial", benchmark: true },
  { symbol: "CVX", name: "Chevron Corporation", group: "industrial", benchmark: false },
  { symbol: "CAT", name: "Caterpillar Inc.", group: "industrial", benchmark: false },
  { symbol: "BA", name: "The Boeing Company", group: "industrial", benchmark: false },
  { symbol: "GE", name: "GE Aerospace", group: "industrial", benchmark: false },
  { symbol: "UPS", name: "United Parcel Service, Inc.", group: "industrial", benchmark: false },
];

export const BENCHMARK_TICKERS = MARKET_UNIVERSE.filter((x) => x.benchmark).map((x) => x.symbol);
export const UNIVERSE_BY_SYMBOL = new Map(MARKET_UNIVERSE.map((x) => [x.symbol, x]));
