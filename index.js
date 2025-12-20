// ============================================================================
// MEXC FUTURES LIQUIDATION ALERT BOT - WebSocket Only Version
// OI-based filtering, no REST API, no CoinGecko
// ============================================================================

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Alert thresholds
  MIN_VOLUME_USD: parseInt(process.env.MIN_VOLUME_USD) || 800000,
  MIN_VOLUME_USD_LARGE: parseInt(process.env.MIN_VOLUME_USD_LARGE) || 1000000,
  MIN_DOMINANCE: parseInt(process.env.MIN_DOMINANCE) || 65,
  WINDOW_SECONDS: [30, 60, 120, 180],
  COOLDOWN_MINUTES: parseInt(process.env.COOLDOWN_MINUTES) || 20,
  
  // OI filtering (замість MC)
  MIN_OPEN_INTEREST: parseInt(process.env.MIN_OPEN_INTEREST) || 10_000_000,
  MAX_OPEN_INTEREST: parseInt(process.env.MAX_OPEN_INTEREST) || 50_000_000,
  
  // Refresh settings
  REFRESH_SYMBOLS_MINUTES: parseInt(process.env.REFRESH_SYMBOLS_MINUTES) || 30,
  
  // WebSocket
  MEXC_WS: 'wss://contract.mexc.com/edge',
  
  // Telegram
  TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
};

// ============================================================================
// OI TRACKER (Open Interest via WebSocket)
// ============================================================================

class OITracker {
  constructor() {
    this.oiData = new Map(); // symbol -> { oi, lastPrice, fundingRate, timestamp }
  }

  updateOI(symbol, oi, lastPrice, fundingRate) {
    this.oiData.set(symbol, {
      oi,
      lastPrice,
      fundingRate,
      timestamp: Date.now()
    });
  }

  getOI(symbol) {
    return this.oiData.get(symbol);
  }

  getFilteredSymbols() {
    const filtered = [];
    
    for (const [symbol, data] of this.oiData.entries()) {
      const oiValue = data.oi * data.lastPrice;
      
      if (oiValue >= CONFIG.MIN_OPEN_INTEREST && 
          oiValue <= CONFIG.MAX_OPEN_INTEREST) {
        filtered.push({
          symbol,
          oiValue,
          lastPrice: data.lastPrice,
          fundingRate: data.fundingRate
        });
      }
    }

    // Sort by OI
    filtered.sort((a, b) => b.oiValue - a.oiValue);
    
    return filtered;
  }

  cleanupOld() {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 minutes
    
    for (const [symbol, data] of this.oiData.entries()) {
      if (now - data.timestamp > maxAge) {
        this.oiData.delete(symbol);
      }
    }
  }
}

// ============================================================================
// VOLUME AGGREGATOR
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
// TREND ANALYZER
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
// COOLDOWN MANAGER
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
// ALERT FORMATTER
// ============================================================================

class AlertFormatter {
  format(symbol, stats, context, oiData) {
    const type = stats.dominantSide === 'sell' ? 'ЛОНГОВ' : 'ШОРТОВ';
    const emoji = stats.dominantSide === 'sell' ? '🔴' : '🟢';
    
    const lines = [];
    
    lines.push(`${emoji} ЛИКВИДАЦИЯ ${type}`);
    lines.push(`Объем: $${this.formatNumber(stats.totalVolume)} (за ${this.formatDuration(stats.duration)})`);
    lines.push(`Доминирование: ${stats.dominance.toFixed(1)}% ${type}`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');
    
    lines.push(`🔥 ${symbol}`);
    
    if (oiData) {
      const oiValue = oiData.oi * oiData.lastPrice;
      lines.push(`💰 Open Interest: $${this.formatNumber(oiValue)}`);
      
      if (oiData.fundingRate !== 0) {
        lines.push(`⚪️ Funding Rate: ${(oiData.fundingRate * 100).toFixed(4)}%`);
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
  constructor(telegram, cooldownManager, oiTracker, trendAnalyzer) {
    this.telegram = telegram;
    this.cooldownManager = cooldownManager;
    this.oiTracker = oiTracker;
    this.trendAnalyzer = trendAnalyzer;
    this.formatter = new AlertFormatter();
  }

  async checkAndAlert(symbol, allStats) {
    let bestStats = null;

    for (const [window, stats] of Object.entries(allStats)) {
      if (!stats) continue;
      
      // Два варіанти тригеру:
      // 1. Volume >= 800k + dominance >= 65%
      // 2. Volume >= 1M + dominance >= 65% (пріоритетніший)
      
      const meetsStandard = stats.totalVolume >= CONFIG.MIN_VOLUME_USD &&
                           stats.dominance >= CONFIG.MIN_DOMINANCE;
      
      const meetsLarge = stats.totalVolume >= CONFIG.MIN_VOLUME_USD_LARGE &&
                        stats.dominance >= CONFIG.MIN_DOMINANCE;
      
      if (meetsLarge || meetsStandard) {
        if (!bestStats || stats.totalVolume > bestStats.totalVolume) {
          bestStats = stats;
        }
      }
    }

    if (!bestStats) return;

    if (!this.cooldownManager.canAlert(symbol, bestStats)) {
      return;
    }

    const oiData = this.oiTracker.getOI(symbol);
    const context = this.trendAnalyzer.getContext(symbol);
    const message = this.formatter.format(symbol, bestStats, context, oiData);
    
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
// WEBSOCKET LISTENER
// ============================================================================

class MEXCWebSocketListener {
  constructor(volumeAggregator, trendAnalyzer, alertTrigger, oiTracker) {
    this.volumeAggregator = volumeAggregator;
    this.trendAnalyzer = trendAnalyzer;
    this.alertTrigger = alertTrigger;
    this.oiTracker = oiTracker;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.activeSymbols = new Set();
    this.allSymbols = [];
    this.pingInterval = null;
    this.refreshInterval = null;
  }

  async connect() {
    console.log('[WS] Connecting to MEXC WebSocket...');
    
    this.ws = new WebSocket(CONFIG.MEXC_WS);

    this.ws.on('open', async () => {
      console.log('[WS] Connected successfully');
      this.reconnectAttempts = 0;
      this.startPingInterval();
      
      // Subscribe to all symbols for OI data
      await this.subscribeToAllSymbols();
      
      // Start periodic refresh
      this.startRefreshInterval();
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
      this.stopRefreshInterval();
      this.reconnect();
    });
  }

  async subscribeToAllSymbols() {
    console.log('\n[INIT] Subscribing to all symbols for OI tracking...');
    
    // Subscribe to deal (trades) + detail (OI, funding) for all symbols
    // We'll filter later based on OI
    
    // Get list of all symbols (simplified - subscribe to pattern)
    // MEXC supports wildcard subscriptions
    
    // For now, subscribe to popular symbols initially
    const initialSymbols = [
      'BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'BNB_USDT', 'XRP_USDT',
      'ADA_USDT', 'DOGE_USDT', 'AVAX_USDT', 'MATIC_USDT', 'DOT_USDT',
      'TRX_USDT', 'LINK_USDT', 'UNI_USDT', 'ATOM_USDT', 'LTC_USDT'
    ];
    
    for (const symbol of initialSymbols) {
      this.subscribeToSymbol(symbol);
    }
    
    console.log('[INIT] Initial subscriptions complete. Will discover more symbols via WS messages.\n');
  }

  subscribeToSymbol(symbol) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      // Subscribe to trades
      this.ws.send(JSON.stringify({
        method: 'sub.deal',
        param: { symbol }
      }));
      
      // Subscribe to contract details (OI, funding rate)
      this.ws.send(JSON.stringify({
        method: 'sub.detail',
        param: { symbol }
      }));
      
      this.allSymbols.push(symbol);
      console.log(`[WS] Subscribed to ${symbol}`);
    } catch (error) {
      console.error(`[ERROR] Failed to subscribe to ${symbol}:`, error.message);
    }
  }

  unsubscribeFromSymbol(symbol) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      this.ws.send(JSON.stringify({
        method: 'unsub.deal',
        param: { symbol }
      }));
      
      this.ws.send(JSON.stringify({
        method: 'unsub.detail',
        param: { symbol }
      }));
      
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
      
      // Handle trades
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
          
          // Only process if symbol passes OI filter
          if (this.activeSymbols.has(symbol)) {
            this.volumeAggregator.addTrade(symbol, trade);
            this.trendAnalyzer.addTrade(symbol, trade);
            
            // Check for alerts
            const allStats = this.volumeAggregator.getAllWindowStats(symbol);
            this.alertTrigger.checkAndAlert(symbol, allStats);
          }
        }
      }
      
      // Handle contract details (OI, funding rate, price)
      if (message.channel === 'push.detail' && message.data) {
        const symbol = message.symbol;
        const data = message.data;
        
        const oi = parseFloat(data.openInterest) || 0;
        const lastPrice = parseFloat(data.lastPrice) || 0;
        const fundingRate = parseFloat(data.fundingRate) || 0;
        
        if (oi > 0 && lastPrice > 0) {
          this.oiTracker.updateOI(symbol, oi, lastPrice, fundingRate);
          
          // Check if should be active
          this.updateActiveSymbols();
        }
      }
      
    } catch (error) {
      console.error('[ERROR] Failed to parse message:', error.message);
    }
  }

  updateActiveSymbols() {
    const filtered = this.oiTracker.getFilteredSymbols();
    const newActive = new Set(filtered.map(f => f.symbol));
    
    // Subscribe to new symbols
    for (const symbol of newActive) {
      if (!this.activeSymbols.has(symbol)) {
        console.log(`[FILTER] ✅ ${symbol} | OI: $${(filtered.find(f => f.symbol === symbol).oiValue / 1e6).toFixed(1)}M`);
      }
    }
    
    // Unsubscribe from old symbols (optional - can keep them for future)
    // for (const symbol of this.activeSymbols) {
    //   if (!newActive.has(symbol)) {
    //     console.log(`[FILTER] ❌ ${symbol} - OI out of range`);
    //   }
    // }
    
    this.activeSymbols = newActive;
    
    if (this.activeSymbols.size > 0) {
      console.log(`[FILTER] Monitoring ${this.activeSymbols.size} symbols with OI $${CONFIG.MIN_OPEN_INTEREST/1e6}M - $${CONFIG.MAX_OPEN_INTEREST/1e6}M`);
    }
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

  startRefreshInterval() {
    this.refreshInterval = setInterval(() => {
      console.log('[REFRESH] Cleaning up old OI data...');
      this.oiTracker.cleanupOld();
      this.updateActiveSymbols();
    }, CONFIG.REFRESH_SYMBOLS_MINUTES * 60 * 1000);
  }

  stopRefreshInterval() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
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
    this.stopRefreshInterval();
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
    this.oiTracker = new OITracker();
    this.alertTrigger = new AlertTrigger(
      this.telegram,
      this.cooldownManager,
      this.oiTracker,
      this.trendAnalyzer
    );
    this.wsListener = new MEXCWebSocketListener(
      this.volumeAggregator,
      this.trendAnalyzer,
      this.alertTrigger,
      this.oiTracker
    );
  }

  async start() {
    console.log('='.repeat(60));
    console.log('MEXC LIQUIDATION ALERT BOT - WebSocket Only');
    console.log('='.repeat(60));
    console.log(`Alert Volume Threshold: $${CONFIG.MIN_VOLUME_USD.toLocaleString()}`);
    console.log(`Large Volume Threshold: $${CONFIG.MIN_VOLUME_USD_LARGE.toLocaleString()}`);
    console.log(`Min Dominance: ${CONFIG.MIN_DOMINANCE}%`);
    console.log(`OI Range: $${CONFIG.MIN_OPEN_INTEREST.toLocaleString()} - $${CONFIG.MAX_OPEN_INTEREST.toLocaleString()}`);
    console.log(`Cooldown: ${CONFIG.COOLDOWN_MINUTES} minutes`);
    console.log(`Refresh: every ${CONFIG.REFRESH_SYMBOLS_MINUTES} minutes`);
    console.log('='.repeat(60));

    // Test Telegram
    try {
      await this.telegram.sendMessage(
        CONFIG.TELEGRAM_CHAT_ID,
        '🚀 MEXC Liquidation Bot Started (WebSocket Only)\n\nФільтрація по OI активна!'
      );
      console.log('[TELEGRAM] Connection successful\n');
    } catch (error) {
      console.error('[TELEGRAM] Failed to connect:', error.message);
      process.exit(1);
    }

    // Connect WebSocket
    await this.wsListener.connect();

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