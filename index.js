// ============================================================================
// MEXC FUTURES LIQUIDATION ALERT BOT - ENHANCED VERSION
// WITH OI/MC FILTERING & COINGECKO INTEGRATION
// ============================================================================

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Thresholds
  MIN_VOLUME_USD: parseInt(process.env.MIN_VOLUME_USD) || 800000,
  MIN_DOMINANCE: parseInt(process.env.MIN_DOMINANCE) || 65,
  WINDOW_SECONDS: [30, 60, 120, 180],
  COOLDOWN_MINUTES: parseInt(process.env.COOLDOWN_MINUTES) || 20,
  
  // Market Cap & OI/MC filters
  MIN_MARKET_CAP: parseInt(process.env.MIN_MARKET_CAP) || 20_000_000,
  MAX_MARKET_CAP: parseInt(process.env.MAX_MARKET_CAP) || 150_000_000,
  MIN_OI_MC_RATIO: parseFloat(process.env.MIN_OI_MC_RATIO) || 0.25,
  MAX_OI_MC_RATIO: parseFloat(process.env.MAX_OI_MC_RATIO) || 10,
  MIN_VOLUME_24H: parseInt(process.env.MIN_VOLUME_24H) || 1_000_000,
  
  // Refresh settings
  REFRESH_SYMBOLS_HOURS: parseInt(process.env.REFRESH_SYMBOLS_HOURS) || 2,
  
  // APIs
  MEXC_WS: 'wss://contract.mexc.com/edge',
  MEXC_API: 'https://contract.mexc.com/api/v1/contract',
  COINGECKO_API: 'https://api.coingecko.com/api/v3',
  COINGECKO_RATE_LIMIT_MS: 1500,
  
  // Telegram
  TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
};

// ============================================================================
// SYMBOL MAPPER (MEXC → CoinGecko)
// ============================================================================

class SymbolMapper {
  constructor() {
    this.cache = new Map(); // symbol -> coin_id
    this.reverseCache = new Map(); // coin_id -> symbol
  }

  async mapSymbolToCoinGeckoId(mexcSymbol) {
    // Check cache
    if (this.cache.has(mexcSymbol)) {
      return this.cache.get(mexcSymbol);
    }

    // Hardcoded popular mappings
    const hardcoded = this.getHardcodedMapping(mexcSymbol);
    if (hardcoded) {
      this.cache.set(mexcSymbol, hardcoded);
      return hardcoded;
    }

    // Search on CoinGecko
    try {
      const searchTerm = mexcSymbol.replace('_USDT', '').toLowerCase();
      const response = await axios.get(`${CONFIG.COINGECKO_API}/search`, {
        params: { query: searchTerm },
        timeout: 5000
      });

      if (response.data && response.data.coins && response.data.coins.length > 0) {
        // Find best match
        const coin = response.data.coins.find(c => 
          c.symbol.toLowerCase() === searchTerm ||
          c.id.toLowerCase() === searchTerm
        ) || response.data.coins[0];

        this.cache.set(mexcSymbol, coin.id);
        this.reverseCache.set(coin.id, mexcSymbol);
        
        return coin.id;
      }
    } catch (error) {
      console.error(`[MAPPER] Error searching ${mexcSymbol}:`, error.message);
    }

    return null;
  }

  async batchMapSymbols(symbols) {
    console.log(`[MAPPER] Mapping ${symbols.length} symbols...`);
    const mapped = [];

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      const coinId = await this.mapSymbolToCoinGeckoId(symbol);
      
      if (coinId) {
        mapped.push({ symbol, coinId });
      }

      // Progress
      if ((i + 1) % 50 === 0) {
        console.log(`[MAPPER] Progress: ${i + 1}/${symbols.length}`);
      }

      // Rate limit
      await new Promise(r => setTimeout(r, CONFIG.COINGECKO_RATE_LIMIT_MS));
    }

    console.log(`[MAPPER] Mapped ${mapped.length}/${symbols.length} symbols`);
    return mapped;
  }

  getHardcodedMapping(symbol) {
    const map = {
      'BTC_USDT': 'bitcoin',
      'ETH_USDT': 'ethereum',
      'SOL_USDT': 'solana',
      'BNB_USDT': 'binancecoin',
      'XRP_USDT': 'ripple',
      'ADA_USDT': 'cardano',
      'DOGE_USDT': 'dogecoin',
      'AVAX_USDT': 'avalanche-2',
      'MATIC_USDT': 'matic-network',
      'DOT_USDT': 'polkadot',
      'TRX_USDT': 'tron',
      'LINK_USDT': 'chainlink',
      'UNI_USDT': 'uniswap',
      'ATOM_USDT': 'cosmos',
      'LTC_USDT': 'litecoin',
      'ETC_USDT': 'ethereum-classic',
      'BCH_USDT': 'bitcoin-cash',
      'FIL_USDT': 'filecoin',
      'APT_USDT': 'aptos',
      'ARB_USDT': 'arbitrum',
      'OP_USDT': 'optimism',
      'SUI_USDT': 'sui',
      'PEPE_USDT': 'pepe',
      'SHIB_USDT': 'shiba-inu',
      'WIF_USDT': 'dogwifcoin',
      'BONK_USDT': 'bonk',
    };
    return map[symbol] || null;
  }
}

// ============================================================================
// SYMBOL FILTER (OI/MC filtering)
// ============================================================================

class SymbolFilter {
  constructor(symbolMapper) {
    this.symbolMapper = symbolMapper;
  }

  async fetchAllSymbolsFromMEXC() {
    try {
      console.log('[FILTER] Fetching all symbols from MEXC...');
      const response = await axios.get(`${CONFIG.MEXC_API}/ticker`, {
        timeout: 10000
      });

      if (response.data && response.data.data) {
        const symbols = response.data.data
          .filter(s => s.symbol && s.symbol.includes('_USDT'))
          .filter(s => parseFloat(s.volume24 || 0) >= CONFIG.MIN_VOLUME_24H)
          .map(s => ({
            symbol: s.symbol,
            volume24: parseFloat(s.volume24 || 0),
            lastPrice: parseFloat(s.lastPrice || 0)
          }))
          .sort((a, b) => b.volume24 - a.volume24);

        console.log(`[FILTER] Found ${symbols.length} symbols with volume > $${CONFIG.MIN_VOLUME_24H}`);
        return symbols;
      }
    } catch (error) {
      console.error('[FILTER] Error fetching symbols:', error.message);
    }
    return [];
  }

  async getOIForSymbols(symbols) {
    console.log('[FILTER] Fetching OI data...');
    const symbolsWithOI = [];

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i].symbol;
      
      try {
        const response = await axios.get(`${CONFIG.MEXC_API}/detail`, {
          params: { symbol },
          timeout: 3000
        });

        if (response.data && response.data.data) {
          const oi = parseFloat(response.data.data.openInterest) || 0;
          const oiValue = oi * symbols[i].lastPrice;
          
          if (oiValue > 0) {
            symbolsWithOI.push({
              ...symbols[i],
              oi: oiValue
            });
          }
        }
      } catch (error) {
        // Skip on error
      }

      // Progress
      if ((i + 1) % 50 === 0) {
        console.log(`[FILTER] OI progress: ${i + 1}/${symbols.length}`);
      }

      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[FILTER] Got OI for ${symbolsWithOI.length} symbols`);
    return symbolsWithOI;
  }

  async getMarketCapsFromCoinGecko(mappedSymbols) {
    console.log('[FILTER] Fetching market caps from CoinGecko...');
    const symbolsWithMC = [];

    // Batch request (250 IDs per request)
    const batchSize = 250;
    for (let i = 0; i < mappedSymbols.length; i += batchSize) {
      const batch = mappedSymbols.slice(i, i + batchSize);
      const coinIds = batch.map(s => s.coinId).join(',');

      try {
        const response = await axios.get(`${CONFIG.COINGECKO_API}/coins/markets`, {
          params: {
            vs_currency: 'usd',
            ids: coinIds,
            per_page: 250,
            page: 1
          },
          timeout: 10000
        });

        if (response.data) {
          for (const coinData of response.data) {
            const mappedSymbol = batch.find(s => s.coinId === coinData.id);
            if (mappedSymbol && coinData.market_cap) {
              symbolsWithMC.push({
                ...mappedSymbol,
                marketCap: coinData.market_cap
              });
            }
          }
        }

        console.log(`[FILTER] MC progress: ${Math.min(i + batchSize, mappedSymbols.length)}/${mappedSymbols.length}`);
        await new Promise(r => setTimeout(r, CONFIG.COINGECKO_RATE_LIMIT_MS));
        
      } catch (error) {
        console.error(`[FILTER] Error fetching MC batch:`, error.message);
      }
    }

    console.log(`[FILTER] Got market cap for ${symbolsWithMC.length} symbols`);
    return symbolsWithMC;
  }

  filterByOIMC(symbolsWithData) {
    console.log('[FILTER] Applying OI/MC filter...');
    
    const filtered = symbolsWithData.filter(s => {
      const mc = s.marketCap;
      const oi = s.oi;
      const ratio = oi / mc;

      const passedMC = mc >= CONFIG.MIN_MARKET_CAP && mc <= CONFIG.MAX_MARKET_CAP;
      const passedRatio = ratio >= CONFIG.MIN_OI_MC_RATIO && ratio <= CONFIG.MAX_OI_MC_RATIO;

      if (passedMC && passedRatio) {
        console.log(`[FILTER] ✅ ${s.symbol} | MC: $${(mc/1e6).toFixed(1)}M | OI: $${(oi/1e6).toFixed(1)}M | Ratio: ${ratio.toFixed(2)}`);
      }

      return passedMC && passedRatio;
    });

    // Sort by OI/MC ratio (most speculative first)
    filtered.sort((a, b) => (b.oi / b.marketCap) - (a.oi / a.marketCap));

    console.log(`[FILTER] Final result: ${filtered.length} symbols passed filter`);
    return filtered;
  }

  async getFilteredSymbols() {
    try {
      // 1. Get all symbols from MEXC
      const allSymbols = await this.fetchAllSymbolsFromMEXC();
      if (allSymbols.length === 0) return [];

      // 2. Get OI for symbols
      const symbolsWithOI = await this.getOIForSymbols(allSymbols);
      if (symbolsWithOI.length === 0) return [];

      // 3. Map to CoinGecko IDs
      const symbolsToMap = symbolsWithOI.map(s => s.symbol);
      const mapped = await this.symbolMapper.batchMapSymbols(symbolsToMap);
      
      // Merge data
      const symbolsWithMapping = symbolsWithOI
        .map(s => {
          const mapping = mapped.find(m => m.symbol === s.symbol);
          return mapping ? { ...s, coinId: mapping.coinId } : null;
        })
        .filter(s => s !== null);

      if (symbolsWithMapping.length === 0) return [];

      // 4. Get market caps
      const symbolsWithMC = await this.getMarketCapsFromCoinGecko(symbolsWithMapping);

      // 5. Filter by OI/MC
      const filtered = this.filterByOIMC(symbolsWithMC);

      return filtered.map(s => s.symbol);
      
    } catch (error) {
      console.error('[FILTER] Error in filtering process:', error.message);
      return [];
    }
  }
}

// ============================================================================
// VOLUME AGGREGATOR (unchanged)
// ============================================================================

class VolumeAggregator {
  constructor() {
    this.trades = new Map();
    this.windows = CONFIG.WINDOW_SECONDS;
  }

  addTrade(symbol, trade) {
    if (!this.trades.has(symbol)) {
      this.trades.set(symbol, []);
    }
    
    const usdVolume = trade.price * trade.quantity;
    const tradeData = {
      timestamp: trade.timestamp,
      side: trade.side,
      usdVolume,
      price: trade.price
    };
    
    this.trades.get(symbol).push(tradeData);
    this.cleanup(symbol);
  }

  cleanup(symbol) {
    const now = Date.now();
    const maxWindow = Math.max(...this.windows) * 1000;
    
    if (this.trades.has(symbol)) {
      const filtered = this.trades.get(symbol)
        .filter(t => now - t.timestamp < maxWindow);
      this.trades.set(symbol, filtered);
    }
  }

  getWindowStats(symbol, windowSeconds) {
    if (!this.trades.has(symbol)) {
      return null;
    }

    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const recentTrades = this.trades.get(symbol)
      .filter(t => now - t.timestamp < windowMs);

    if (recentTrades.length === 0) return null;

    let buyVolume = 0;
    let sellVolume = 0;
    const prices = recentTrades.map(t => t.price);

    recentTrades.forEach(t => {
      if (t.side === 'buy') {
        buyVolume += t.usdVolume;
      } else {
        sellVolume += t.usdVolume;
      }
    });

    const totalVolume = buyVolume + sellVolume;
    const dominance = totalVolume > 0 
      ? Math.max(buyVolume, sellVolume) / totalVolume * 100 
      : 0;
    
    const priceChange = prices.length > 1
      ? ((prices[prices.length - 1] - prices[0]) / prices[0] * 100)
      : 0;

    return {
      buyVolume,
      sellVolume,
      totalVolume,
      dominance,
      dominantSide: buyVolume > sellVolume ? 'buy' : 'sell',
      duration: (now - recentTrades[0].timestamp) / 1000,
      priceChange,
      tradeCount: recentTrades.length
    };
  }

  getAllWindowStats(symbol) {
    const stats = {};
    for (const window of this.windows) {
      stats[`${window}s`] = this.getWindowStats(symbol, window);
    }
    return stats;
  }
}

// ============================================================================
// TREND ANALYZER (unchanged)
// ============================================================================

class TrendAnalyzer {
  constructor() {
    this.contextWindows = {
      '2h': 7200,
      '5m': 300
    };
    this.trades = new Map();
  }

  addTrade(symbol, trade) {
    if (!this.trades.has(symbol)) {
      this.trades.set(symbol, []);
    }
    
    const usdVolume = trade.price * trade.quantity;
    this.trades.get(symbol).push({
      timestamp: trade.timestamp,
      side: trade.side,
      usdVolume
    });
    
    this.cleanup(symbol);
  }

  cleanup(symbol) {
    const now = Date.now();
    const maxWindow = 7200 * 1000;
    
    if (this.trades.has(symbol)) {
      const filtered = this.trades.get(symbol)
        .filter(t => now - t.timestamp < maxWindow);
      this.trades.set(symbol, filtered);
    }
  }

  getContext(symbol) {
    if (!this.trades.has(symbol)) {
      return null;
    }

    const context = {};
    for (const [name, seconds] of Object.entries(this.contextWindows)) {
      const now = Date.now();
      const windowMs = seconds * 1000;
      const trades = this.trades.get(symbol)
        .filter(t => now - t.timestamp < windowMs);

      let buyVolume = 0;
      let sellVolume = 0;

      trades.forEach(t => {
        if (t.side === 'buy') {
          buyVolume += t.usdVolume;
        } else {
          sellVolume += t.usdVolume;
        }
      });

      const total = buyVolume + sellVolume;
      const imbalance = total > 0 ? (buyVolume - sellVolume) / total : 0;

      context[name] = {
        buyVolume,
        sellVolume,
        total,
        imbalance,
        trend: this.getTrendLabel(imbalance)
      };
    }

    return context;
  }

  getTrendLabel(imbalance) {
    if (imbalance > 0.15) return { label: 'Лонг', emoji: '📈' };
    if (imbalance < -0.15) return { label: 'Шорт', emoji: '📉' };
    return { label: 'Баланс', emoji: '⚖️' };
  }
}

// ============================================================================
// COOLDOWN MANAGER (unchanged)
// ============================================================================

class CooldownManager {
  constructor(cooldownMinutes) {
    this.cooldowns = new Map();
    this.cooldownMs = cooldownMinutes * 60 * 1000;
  }

  canAlert(symbol, stats) {
    if (!this.cooldowns.has(symbol)) {
      return true;
    }

    const lastAlert = this.cooldowns.get(symbol);
    const now = Date.now();
    
    if (now - lastAlert.timestamp < this.cooldownMs) {
      const volumeIncrease = stats.totalVolume / lastAlert.volume;
      const dominanceIncrease = stats.dominance - lastAlert.dominance;
      const sameSide = stats.dominantSide === lastAlert.side;
      
      if (sameSide && volumeIncrease < 1.5 && dominanceIncrease < 10) {
        return false;
      }
    }

    return true;
  }

  recordAlert(symbol, stats) {
    this.cooldowns.set(symbol, {
      timestamp: Date.now(),
      volume: stats.totalVolume,
      dominance: stats.dominance,
      side: stats.dominantSide
    });
  }
}

// ============================================================================
// MARKET DATA FETCHER (enhanced)
// ============================================================================

class MarketDataFetcher {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 60000;
  }

  async getMarketData(symbol) {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    try {
      const detailRes = await axios.get(`${CONFIG.MEXC_API}/detail`, {
        params: { symbol },
        timeout: 5000
      });

      const data = {
        openInterest: 0,
        fundingRate: 0,
        marketCap: 50_000_000,
        lastPrice: 0
      };

      if (detailRes.data && detailRes.data.data) {
        const detail = detailRes.data.data;
        data.openInterest = parseFloat(detail.openInterest) || 0;
        data.fundingRate = parseFloat(detail.fundingRate) || 0;
        data.lastPrice = parseFloat(detail.lastPrice) || 0;
      }

      data.marketCap = this.estimateMarketCap(data.openInterest);

      this.cache.set(symbol, {
        timestamp: Date.now(),
        data
      });

      return data;
    } catch (error) {
      return {
        openInterest: 0,
        fundingRate: 0,
        marketCap: 50_000_000,
        lastPrice: 0
      };
    }
  }

  estimateMarketCap(oi) {
    if (oi > 100_000_000) return 500_000_000;
    if (oi > 50_000_000) return 200_000_000;
    if (oi > 10_000_000) return 50_000_000;
    return 30_000_000;
  }
}

// ============================================================================
// ALERT FORMATTER (unchanged)
// ============================================================================

class AlertFormatter {
  format(symbol, stats, context, marketData) {
    const type = stats.dominantSide === 'sell' ? 'ЛОНГОВ' : 'ШОРТОВ';
    const emoji = stats.dominantSide === 'sell' ? '🔴' : '🟢';
    
    const lines = [];
    
    lines.push(`${emoji} ЛИКВИДАЦИЯ ${type}`);
    lines.push(`Объем: $${this.formatNumber(stats.totalVolume)} (за ${this.formatDuration(stats.duration)})`);
    lines.push(`Доминирование: ${stats.dominance.toFixed(1)}% ${type}`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');
    
    lines.push(`🔥 ${symbol}`);
    
    if (marketData) {
      if (marketData.marketCap > 0) {
        lines.push(`💎 Mcap: $${this.formatNumber(marketData.marketCap)}`);
      }
      if (marketData.fundingRate !== 0) {
        lines.push(`⚪️ Funding Rate: ${(marketData.fundingRate * 100).toFixed(4)}%`);
      }
    }
    
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');
    
    if (context) {
      lines.push('🔮 ТРЕНД (Aggression):');
      const ctx2h = context['2h'];
      const ctx5m = context['5m'];
      
      if (ctx2h) {
        lines.push(`    2Ч Контекст: ${ctx2h.trend.label} ${ctx2h.trend.emoji}`);
      }
      if (ctx5m) {
        lines.push(`    5М Импульс: ${ctx5m.trend.label} ${ctx5m.trend.emoji}`);
      }
      
      lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');
      
      lines.push('💥 Агрессия:');
      if (ctx2h) {
        lines.push(`⚡ (2Ч) | 🟢B: $${this.formatNumber(ctx2h.buyVolume)} | 🔴S: $${this.formatNumber(ctx2h.sellVolume)}`);
      }
      if (ctx5m) {
        lines.push(`⚡ (5М) | 🟢B: $${this.formatNumber(ctx5m.buyVolume)} | 🔴S: $${this.formatNumber(ctx5m.sellVolume)}`);
      }
      
      lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');
    }
    
    if (stats.priceChange) {
      const priceEmoji = stats.priceChange > 0 ? '📈' : '📉';
      lines.push(`${priceEmoji} Цена (ивент): ${stats.priceChange > 0 ? '+' : ''}${stats.priceChange.toFixed(2)}%`);
    }
    
    if (marketData && marketData.openInterest > 0 && marketData.marketCap > 0) {
      const oiRatio = marketData.openInterest / marketData.marketCap;
      lines.push(`📊 OI / MC: ${oiRatio.toFixed(2)}`);
    }
    
    return lines.join('\n');
  }

  formatNumber(num) {
    if (num >= 1_000_000) {
      return (num / 1_000_000).toFixed(2) + 'M';
    }
    if (num >= 1_000) {
      return (num / 1_000).toFixed(0) + 'K';
    }
    return num.toFixed(0);
  }

  formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}м ${secs}с`;
  }
}

// ============================================================================
// ALERT TRIGGER ENGINE (unchanged)
// ============================================================================

class AlertTrigger {
  constructor(telegram, cooldownManager, marketDataFetcher, trendAnalyzer) {
    this.telegram = telegram;
    this.cooldownManager = cooldownManager;
    this.marketDataFetcher = marketDataFetcher;
    this.trendAnalyzer = trendAnalyzer;
    this.formatter = new AlertFormatter();
  }

  async checkAndAlert(symbol, allStats) {
    let bestStats = null;

    for (const [window, stats] of Object.entries(allStats)) {
      if (!stats) continue;
      
      if (stats.totalVolume >= CONFIG.MIN_VOLUME_USD &&
          stats.dominance >= CONFIG.MIN_DOMINANCE) {
        
        if (!bestStats || stats.dominance > bestStats.dominance) {
          bestStats = stats;
        }
      }
    }

    if (!bestStats) return;

    if (!this.cooldownManager.canAlert(symbol, bestStats)) {
      return;
    }

    const marketData = await this.marketDataFetcher.getMarketData(symbol);
    const context = this.trendAnalyzer.getContext(symbol);
    const message = this.formatter.format(symbol, bestStats, context, marketData);
    
    try {
      await this.telegram.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message);
      this.cooldownManager.recordAlert(symbol, bestStats);
      
      console.log(`[ALERT] ${symbol} - ${bestStats.dominantSide} - $${bestStats.totalVolume.toFixed(0)} - ${bestStats.dominance.toFixed(1)}%`);
    } catch (error) {
      console.error(`[ERROR] Failed to send alert for ${symbol}:`, error.message);
    }
  }
}

// ============================================================================
// SUBSCRIPTION MANAGER
// ============================================================================

class SubscriptionManager {
  constructor(wsListener, symbolFilter) {
    this.wsListener = wsListener;
    this.symbolFilter = symbolFilter;
    this.currentSymbols = new Set();
  }

  async refreshSubscriptions() {
    console.log('\n[SUBSCRIPTION] Starting refresh...');
    
    // Get filtered symbols
    const newSymbols = await this.symbolFilter.getFilteredSymbols();
    
    if (newSymbols.length === 0) {
      console.log('[SUBSCRIPTION] No symbols passed filter, keeping current subscriptions');
      return;
    }

    const newSymbolsSet = new Set(newSymbols);

    // Unsubscribe from old symbols
    for (const oldSymbol of this.currentSymbols) {
      if (!newSymbolsSet.has(oldSymbol)) {
        this.wsListener.unsubscribeFromTrades(oldSymbol);
      }
    }

    // Subscribe to new symbols
    for (const newSymbol of newSymbols) {
      if (!this.currentSymbols.has(newSymbol)) {
        this.wsListener.subscribeToTrades(newSymbol);
      }
    }

    this.currentSymbols = newSymbolsSet;
    console.log(`[SUBSCRIPTION] Refresh complete. Monitoring ${this.currentSymbols.size} symbols\n`);
  }

  scheduleRefresh() {
    setInterval(() => {
      this.refreshSubscriptions();
    }, CONFIG.REFRESH_SYMBOLS_HOURS * 60 * 60 * 1000);
  }
}

// ============================================================================
// WEBSOCKET LISTENER (enhanced)
// ============================================================================

class MEXCWebSocketListener {
  constructor(volumeAggregator, trendAnalyzer, alertTrigger) {
    this.volumeAggregator = volumeAggregator;
    this.trendAnalyzer = trendAnalyzer;
    this.alertTrigger = alertTrigger;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.subscribedSymbols = new Set();
    this.pingInterval = null;
  }

  async connect() {
    console.log('[WS] Connecting to MEXC WebSocket...');
    
    this.ws = new WebSocket(CONFIG.MEXC_WS);

    this.ws.on('open', () => {
      console.log('[WS] Connected successfully');
      this.reconnectAttempts = 0;
      this.startPingInterval();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (error) => {
      console.error('[WS] Error:', error.message);
    });

    this.ws.on('close', () => {
      console.log('[WS] Connection closed');
      this.stopPingInterval();
      this.reconnect();
    });
  }

  startPingInterval() {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ method: 'ping' }));
        } catch (error) {
          console.error('[WS] Ping error:', error.message);
        }
      }
    }, 25000);
  }

  stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  subscribeToTrades(symbol) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const subscribeMsg = {
      method: 'sub.deal',
      param: { symbol }
    };
    
    try {
      this.ws.send(JSON.stringify(subscribeMsg));
      this.subscribedSymbols.add(symbol);
      console.log(`[WS] Subscribed to ${symbol}`);
    } catch (error) {
      console.error(`[ERROR] Failed to subscribe to ${symbol}:`, error.message);
    }
  }

  unsubscribeFromTrades(symbol) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const unsubscribeMsg = {
      method: 'unsub.deal',
      param: { symbol }
    };
    
    try {
      this.ws.send(JSON.stringify(unsubscribeMsg));
      this.subscribedSymbols.delete(symbol);
      console.log(`[WS] Unsubscribed from ${symbol}`);
    } catch (error) {
      console.error(`[ERROR] Failed to unsubscribe from ${symbol}:`, error.message);
    }
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      
      if (message.channel === 'pong') {
        return;
      }
      
      if (message.channel === 'rs.error') {
        console.error('[WS] Subscription error:', message);
        return;
      }
      
      if (message.channel === 'push.deal' && message.data && message.data.deals) {
        const symbol = message.symbol;
        
        for (const deal of message.data.deals) {
          const trade = {
            timestamp: deal.t || Date.now(),
            price: parseFloat(deal.p),
            quantity: parseFloat(deal.v),
            side: deal.T === 1 ? 'buy' : 'sell'
          };
          
          if (isNaN(trade.price) || isNaN(trade.quantity)) {
            continue;
          }
          
          this.volumeAggregator.addTrade(symbol, trade);
          this.trendAnalyzer.addTrade(symbol, trade);
        }
        
        const allStats = this.volumeAggregator.getAllWindowStats(symbol);
        this.alertTrigger.checkAndAlert(symbol, allStats);
      }
    } catch (error) {
      console.error('[ERROR] Failed to parse message:', error.message);
    }
  }

  reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    console.log(`[WS] Reconnecting in ${this.reconnectDelay / 1000}s... (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
  }

  close() {
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close();
    }
  }
}

// ============================================================================
// MAIN APPLICATION
// ============================================================================

class LiquidationBot {
  constructor() {
    this.telegram = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });
    this.volumeAggregator = new VolumeAggregator();
    this.trendAnalyzer = new TrendAnalyzer();
    this.cooldownManager = new CooldownManager(CONFIG.COOLDOWN_MINUTES);
    this.marketDataFetcher = new MarketDataFetcher();
    this.alertTrigger = new AlertTrigger(
      this.telegram,
      this.cooldownManager,
      this.marketDataFetcher,
      this.trendAnalyzer
    );
    this.wsListener = new MEXCWebSocketListener(
      this.volumeAggregator,
      this.trendAnalyzer,
      this.alertTrigger
    );
    this.symbolMapper = new SymbolMapper();
    this.symbolFilter = new SymbolFilter(this.symbolMapper);
    this.subscriptionManager = new SubscriptionManager(
      this.wsListener,
      this.symbolFilter
    );
  }

  async start() {
    console.log('='.repeat(60));
    console.log('MEXC LIQUIDATION ALERT BOT - ENHANCED');
    console.log('='.repeat(60));
    console.log(`Min Volume: $${CONFIG.MIN_VOLUME_USD.toLocaleString()}`);
    console.log(`Min Dominance: ${CONFIG.MIN_DOMINANCE}%`);
    console.log(`Market Cap: $${CONFIG.MIN_MARKET_CAP.toLocaleString()} - $${CONFIG.MAX_MARKET_CAP.toLocaleString()}`);
    console.log(`OI/MC Ratio: ${CONFIG.MIN_OI_MC_RATIO} - ${CONFIG.MAX_OI_MC_RATIO}`);
    console.log(`Cooldown: ${CONFIG.COOLDOWN_MINUTES} minutes`);
    console.log(`Refresh: every ${CONFIG.REFRESH_SYMBOLS_HOURS} hours`);
    console.log('='.repeat(60));

    // Test Telegram
    try {
      await this.telegram.sendMessage(
        CONFIG.TELEGRAM_CHAT_ID,
        '🚀 MEXC Liquidation Bot Started (Enhanced)\n\nФільтрація по OI/MC активна!'
      );
      console.log('[TELEGRAM] Connection successful\n');
    } catch (error) {
      console.error('[TELEGRAM] Failed to connect:', error.message);
      process.exit(1);
    }

    // Connect WebSocket
    await this.wsListener.connect();

    // Wait for WS to connect
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Initial subscription
    console.log('\n[INIT] Starting initial symbol filtering...\n');
    await this.subscriptionManager.refreshSubscriptions();

    // Schedule periodic refresh
    this.subscriptionManager.scheduleRefresh();
    console.log(`[INIT] Scheduled refresh every ${CONFIG.REFRESH_SYMBOLS_HOURS} hours\n`);

    // Shutdown handlers
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  async shutdown() {
    console.log('\n[SHUTDOWN] Stopping bot...');
    this.wsListener.close();
    await this.telegram.sendMessage(
      CONFIG.TELEGRAM_CHAT_ID,
      '⛔ MEXC Liquidation Bot Stopped'
    );
    process.exit(0);
  }
}

// ============================================================================
// START BOT
// ============================================================================

if (require.main === module) {
  const bot = new LiquidationBot();
  bot.start().catch(error => {
    console.error('[FATAL ERROR]', error);
    process.exit(1);
  });
}

module.exports = { LiquidationBot };