// ============================================================================
// MEXC FUTURES LIQUIDATION ALERT BOT
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
  MIN_MARKET_CAP: parseInt(process.env.MIN_MARKET_CAP) || 20_000_000,
  
  // API - Updated endpoints
  MEXC_WS: 'wss://contract.mexc.com/edge',
  MEXC_API: 'https://contract.mexc.com/api/v1/contract',
  
  // Telegram
  TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
};

// ============================================================================
// VOLUME AGGREGATOR (Rolling Windows)
// ============================================================================

class VolumeAggregator {
  constructor() {
    this.trades = new Map(); // symbol -> array of trades
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
// TREND ANALYZER (2H vs 5M context)
// ============================================================================

class TrendAnalyzer {
  constructor() {
    this.contextWindows = {
      '2h': 7200,  // 2 hours
      '5m': 300    // 5 minutes
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
    const maxWindow = 7200 * 1000; // 2 hours
    
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
// COOLDOWN MANAGER
// ============================================================================

class CooldownManager {
  constructor(cooldownMinutes) {
    this.cooldowns = new Map(); // symbol -> last alert data
    this.cooldownMs = cooldownMinutes * 60 * 1000;
  }

  canAlert(symbol, stats) {
    if (!this.cooldowns.has(symbol)) {
      return true;
    }

    const lastAlert = this.cooldowns.get(symbol);
    const now = Date.now();
    
    // Check cooldown time
    if (now - lastAlert.timestamp < this.cooldownMs) {
      // Allow only if significantly better
      const volumeIncrease = stats.totalVolume / lastAlert.volume;
      const dominanceIncrease = stats.dominance - lastAlert.dominance;
      const sameSide = stats.dominantSide === lastAlert.side;
      
      // Don't alert if same side with worse or similar stats
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
// MARKET DATA FETCHER
// ============================================================================

class MarketDataFetcher {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 60000; // 1 minute
  }

  async getMarketData(symbol) {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    try {
      // Get contract details
      const detailRes = await axios.get(`${CONFIG.MEXC_API}/detail`, {
        params: { symbol },
        timeout: 5000
      });

      const data = {
        openInterest: 0,
        fundingRate: 0,
        marketCap: 50_000_000, // Default
        lastPrice: 0
      };

      if (detailRes.data && detailRes.data.data) {
        const detail = detailRes.data.data;
        data.openInterest = parseFloat(detail.openInterest) || 0;
        data.fundingRate = parseFloat(detail.fundingRate) || 0;
        data.lastPrice = parseFloat(detail.lastPrice) || 0;
      }

      // Estimate market cap from trading volume (rough estimate)
      data.marketCap = await this.estimateMarketCap(symbol, data);

      this.cache.set(symbol, {
        timestamp: Date.now(),
        data
      });

      return data;
    } catch (error) {
      console.error(`[ERROR] Failed to fetch market data for ${symbol}:`, error.message);
      
      // Return default data
      return {
        openInterest: 0,
        fundingRate: 0,
        marketCap: 50_000_000,
        lastPrice: 0
      };
    }
  }

  async estimateMarketCap(symbol, contractData) {
    // Simple heuristic: larger OI usually means larger market cap
    // This is a rough estimate - for production, use CoinGecko/CMC API
    const oi = contractData.openInterest || 0;
    
    if (oi > 100_000_000) return 500_000_000; // Large cap
    if (oi > 50_000_000) return 200_000_000;  // Mid cap
    if (oi > 10_000_000) return 50_000_000;   // Small cap
    
    return 30_000_000; // Default
  }
}

// ============================================================================
// ALERT FORMATTER
// ============================================================================

class AlertFormatter {
  format(symbol, stats, context, marketData) {
    const type = stats.dominantSide === 'sell' ? 'ЛОНГОВ' : 'ШОРТОВ';
    const emoji = stats.dominantSide === 'sell' ? '🔴' : '🟢';
    
    const lines = [];
    
    // Header
    lines.push(`${emoji} ЛИКВИДАЦИЯ ${type}`);
    lines.push(`Объем: $${this.formatNumber(stats.totalVolume)} (за ${this.formatDuration(stats.duration)})`);
    lines.push(`Доминирование: ${stats.dominance.toFixed(1)}% ${type}`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Symbol
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
    
    // Trend context
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
      
      // Volume breakdown
      lines.push('💥 Агрессия:');
      if (ctx2h) {
        lines.push(`⚡ (2Ч) | 🟢B: $${this.formatNumber(ctx2h.buyVolume)} | 🔴S: $${this.formatNumber(ctx2h.sellVolume)}`);
      }
      if (ctx5m) {
        lines.push(`⚡ (5М) | 🟢B: $${this.formatNumber(ctx5m.buyVolume)} | 🔴S: $${this.formatNumber(ctx5m.sellVolume)}`);
      }
      
      lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');
    }
    
    // Price change
    if (stats.priceChange) {
      const priceEmoji = stats.priceChange > 0 ? '📈' : '📉';
      lines.push(`${priceEmoji} Цена (ивент): ${stats.priceChange > 0 ? '+' : ''}${stats.priceChange.toFixed(2)}%`);
    }
    
    // OI ratio (if available)
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
// ALERT TRIGGER ENGINE
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
    // Find best window that meets criteria
    let bestStats = null;
    let bestWindow = null;

    for (const [window, stats] of Object.entries(allStats)) {
      if (!stats) continue;
      
      if (stats.totalVolume >= CONFIG.MIN_VOLUME_USD &&
          stats.dominance >= CONFIG.MIN_DOMINANCE) {
        
        if (!bestStats || stats.dominance > bestStats.dominance) {
          bestStats = stats;
          bestWindow = window;
        }
      }
    }

    if (!bestStats) return;

    // Check cooldown
    if (!this.cooldownManager.canAlert(symbol, bestStats)) {
      console.log(`[COOLDOWN] ${symbol} - skipping alert`);
      return;
    }

    // Get market data
    const marketData = await this.marketDataFetcher.getMarketData(symbol);
    
    // Filter by market cap
    if (marketData && marketData.marketCap < CONFIG.MIN_MARKET_CAP) {
      console.log(`[FILTER] ${symbol} - market cap too low: $${marketData.marketCap}`);
      return;
    }

    // Get trend context
    const context = this.trendAnalyzer.getContext(symbol);

    // Format and send alert
    const message = this.formatter.format(symbol, bestStats, context, marketData);
    
    try {
      await this.telegram.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message);
      this.cooldownManager.recordAlert(symbol, bestStats);
      
      console.log(`[ALERT SENT] ${symbol} - ${bestStats.dominantSide} - $${bestStats.totalVolume.toFixed(0)} - ${bestStats.dominance.toFixed(1)}%`);
    } catch (error) {
      console.error(`[ERROR] Failed to send alert for ${symbol}:`, error.message);
    }
  }
}

// ============================================================================
// WEBSOCKET LISTENER
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
      
      // Start ping interval to keep connection alive
      this.startPingInterval();
      
      // Subscribe to symbols
      this.subscribeToSymbols();
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
    }, 30000); // Ping every 30 seconds
  }

  stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  async subscribeToSymbols() {
    // Subscribe to all futures symbols
    // MEXC specific: you need to get list of symbols first
    const symbols = await this.getActiveSymbols();
    
    for (const symbol of symbols) {
      this.subscribeToTrades(symbol);
    }
  }

  async getActiveSymbols() {
    try {
      const response = await axios.get(`${CONFIG.MEXC_API}/ticker`);
      if (response.data && response.data.data) {
        // Get top symbols by volume
        const symbols = response.data.data
          .filter(c => c.symbol && c.symbol.includes('_USDT'))
          .sort((a, b) => (b.volume24 || 0) - (a.volume24 || 0))
          .slice(0, 30) // Top 30 by volume
          .map(c => c.symbol);
        
        console.log(`[INFO] Loaded ${symbols.length} symbols`);
        return symbols;
      }
    } catch (error) {
      console.error('[ERROR] Failed to get symbols:', error.message);
    }
    
    // Fallback to popular symbols
    console.log('[INFO] Using fallback symbols');
    return ['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'BNB_USDT', 'XRP_USDT'];
  }

  subscribeToTrades(symbol) {
    // MEXC uses different subscription format
    const subscribeMsg = {
      method: 'sub.deal',
      param: {
        symbol: symbol
      }
    };
    
    try {
      this.ws.send(JSON.stringify(subscribeMsg));
      this.subscribedSymbols.add(symbol);
      console.log(`[WS] Subscribed to ${symbol}`);
    } catch (error) {
      console.error(`[ERROR] Failed to subscribe to ${symbol}:`, error.message);
    }
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      
      // Handle pong
      if (message.channel === 'pong') {
        return;
      }
      
      // Handle subscription confirmation
      if (message.channel === 'rs.error') {
        console.error('[WS] Subscription error:', message);
        return;
      }
      
      // Handle trade data
      if (message.channel && message.channel === 'push.deal') {
        const symbol = message.symbol;
        
        if (!message.data || !message.data.deals) {
          return;
        }
        
        // Process each deal
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
        
        // Check for alerts periodically
        const allStats = this.volumeAggregator.getAllWindowStats(symbol);
        this.alertTrigger.checkAndAlert(symbol, allStats);
      }
    } catch (error) {
      console.error('[ERROR] Failed to parse message:', error.message);
      // console.log('[DEBUG] Raw message:', data.toString());
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
  }

  async start() {
    console.log('='.repeat(60));
    console.log('MEXC LIQUIDATION ALERT BOT');
    console.log('='.repeat(60));
    console.log(`Min Volume: $${CONFIG.MIN_VOLUME_USD.toLocaleString()}`);
    console.log(`Min Dominance: ${CONFIG.MIN_DOMINANCE}%`);
    console.log(`Cooldown: ${CONFIG.COOLDOWN_MINUTES} minutes`);
    console.log(`Min Market Cap: $${CONFIG.MIN_MARKET_CAP.toLocaleString()}`);
    console.log('='.repeat(60));

    // Test Telegram connection
    try {
      await this.telegram.sendMessage(
        CONFIG.TELEGRAM_CHAT_ID,
        '🚀 MEXC Liquidation Bot Started\n\nМониторинг активирован!'
      );
      console.log('[TELEGRAM] Connection successful');
    } catch (error) {
      console.error('[TELEGRAM] Failed to connect:', error.message);
      process.exit(1);
    }

    // Start WebSocket listener
    await this.wsListener.connect();

    // Handle shutdown
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