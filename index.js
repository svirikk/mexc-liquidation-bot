// ============================================================================
// CRYPTO LIQUIDATION ALERT BOT
// Detects forced liquidations via aggressive volume dominance
// ============================================================================

const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs').promises;

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Bybit API
  BYBIT_WS: 'wss://stream.bybit.com/v5/public/linear',
  BYBIT_REST: 'https://api.bybit.com',
  
  // Alert thresholds
  MIN_VOLUME_USD: parseInt(process.env.MIN_VOLUME_USD || '500000'),
  MIN_DOMINANCE_PCT: parseFloat(process.env.MIN_DOMINANCE_PCT || '65'),
  MIN_PRICE_CHANGE_PCT: parseFloat(process.env.MIN_PRICE_CHANGE_PCT || '0.5'),
  
  // Time windows
  WINDOW_DURATION_SEC: parseInt(process.env.WINDOW_DURATION_SEC || '240'),
  COOLDOWN_MINUTES: parseInt(process.env.COOLDOWN_MINUTES || '20'),
  
  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  
  // System
  MAX_SYMBOLS: parseInt(process.env.MAX_SYMBOLS || '1000'),
  BATCH_SIZE: 10, // Symbols per WS subscription batch
  BLACKLIST_ENABLED: process.env.BLACKLIST_ENABLED !== 'false',
  DEBUG_MODE: process.env.DEBUG_MODE === 'true',
  
  // Volume increase threshold for same-side alerts during cooldown
  VOLUME_INCREASE_THRESHOLD: parseFloat(process.env.VOLUME_INCREASE_THRESHOLD || '1.5'),
};

// ============================================================================
// LOGGER
// ============================================================================

class Logger {
  static log(message, data = null) {
    const timestamp = new Date().toISOString();
    if (data) {
      console.log(`[${timestamp}] ${message}`, JSON.stringify(data, null, 2));
    } else {
      console.log(`[${timestamp}] ${message}`);
    }
  }
  
  static error(message, error = null) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR: ${message}`, error || '');
  }
  
  static debug(message, data = null) {
    if (CONFIG.DEBUG_MODE) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] DEBUG: ${message}`, data || '');
    }
  }
}

// ============================================================================
// MARKET DATA MANAGER
// ============================================================================

class MarketDataManager {
  constructor() {
    this.symbols = new Map(); // symbol -> { oi, volume24h, price }
    this.blacklist = new Set();
  }
  
  async initialize() {
    Logger.log('Initializing market data...');
    
    // Load blacklist
    if (CONFIG.BLACKLIST_ENABLED) {
      await this.loadBlacklist();
    }
    
    // Fetch active symbols
    await this.fetchSymbols();
    
    Logger.log(`Market data initialized: ${this.symbols.size} symbols, ${this.blacklist.size} blacklisted`);
  }
  
  async loadBlacklist() {
    try {
      const data = await fs.readFile('blacklist.json', 'utf-8');
      const list = JSON.parse(data);
      list.forEach(symbol => this.blacklist.add(symbol));
      Logger.log(`Blacklist loaded: ${this.blacklist.size} symbols`);
    } catch (error) {
      Logger.log('No blacklist.json found or error loading, starting with empty blacklist');
    }
  }
  
  async fetchSymbols() {
    try {
      const response = await axios.get(`${CONFIG.BYBIT_REST}/v5/market/tickers`, {
        params: { category: 'linear' }
      });
      
      const items = response.data.result.list || [];
      let count = 0;
      
      for (const item of items) {
        if (count >= CONFIG.MAX_SYMBOLS) break;
        
        const symbol = item.symbol;
        
        // Skip if blacklisted or not USDT perpetual
        if (this.blacklist.has(symbol) || !symbol.endsWith('USDT')) {
          continue;
        }
        
        this.symbols.set(symbol, {
          oi: parseFloat(item.openInterest || 0),
          volume24h: parseFloat(item.volume24h || 0),
          price: parseFloat(item.lastPrice || 0)
        });
        
        count++;
      }
      
      Logger.log(`Fetched ${this.symbols.size} active symbols`);
    } catch (error) {
      Logger.error('Failed to fetch symbols', error.message);
      throw error;
    }
  }
  
  isBlacklisted(symbol) {
    return this.blacklist.has(symbol);
  }
  
  getSymbolData(symbol) {
    return this.symbols.get(symbol);
  }
  
  getActiveSymbols() {
    return Array.from(this.symbols.keys());
  }
}

// ============================================================================
// TRADE AGGREGATOR
// ============================================================================

class TradeAggregator {
  constructor(symbol, windowDurationSec) {
    this.symbol = symbol;
    this.windowDurationSec = windowDurationSec;
    this.trades = []; // Array of {timestamp, side, price, size, usdValue}
  }
  
  addTrade(trade) {
    const now = Date.now();
    
    const price = parseFloat(trade.price);
    const size = parseFloat(trade.size);
    
    // Validate trade data
    if (!isFinite(price) || !isFinite(size) || price <= 0 || size <= 0) {
      return;
    }
    
    this.trades.push({
      timestamp: now,
      side: trade.side,
      price: price,
      size: size,
      usdValue: price * size
    });
    
    // Clean old trades
    this.cleanup(now);
  }
  
  cleanup(now) {
    const cutoff = now - (this.windowDurationSec * 1000);
    this.trades = this.trades.filter(t => t.timestamp > cutoff);
  }
  
  getAggregation() {
    if (this.trades.length === 0) {
      return null;
    }
    
    const now = Date.now();
    this.cleanup(now);
    
    if (this.trades.length < 2) {
      return null;
    }
    
    let totalVolumeUSD = 0;
    let buyVolumeUSD = 0;
    let sellVolumeUSD = 0;
    
    const firstTrade = this.trades[0];
    const lastTrade = this.trades[this.trades.length - 1];
    
    for (const trade of this.trades) {
      const usdValue = trade.usdValue;
      
      // Skip invalid trades
      if (!isFinite(usdValue) || usdValue <= 0) {
        continue;
      }
      
      totalVolumeUSD += usdValue;
      
      if (trade.side === 'Buy') {
        buyVolumeUSD += usdValue;
      } else {
        sellVolumeUSD += usdValue;
      }
    }
    
    // Critical validation
    if (totalVolumeUSD === 0 || !isFinite(totalVolumeUSD)) {
      return null;
    }
    
    if (firstTrade.price === 0 || !isFinite(firstTrade.price)) {
      return null;
    }
    
    const dominantVolume = Math.max(buyVolumeUSD, sellVolumeUSD);
    const dominancePercent = (dominantVolume / totalVolumeUSD) * 100;
    const dominantSide = buyVolumeUSD > sellVolumeUSD ? 'buy' : 'sell';
    
    const priceChangePercent = ((lastTrade.price - firstTrade.price) / firstTrade.price) * 100;
    const windowDurationSeconds = (lastTrade.timestamp - firstTrade.timestamp) / 1000;
    
    // Final validation
    if (!isFinite(dominancePercent) || !isFinite(priceChangePercent)) {
      return null;
    }
    
    return {
      symbol: this.symbol,
      totalVolumeUSD,
      buyVolumeUSD,
      sellVolumeUSD,
      dominancePercent,
      dominantSide,
      priceChangePercent,
      windowDurationSeconds,
      tradeCount: this.trades.length,
      firstPrice: firstTrade.price,
      lastPrice: lastTrade.price
    };
  }
}

// ============================================================================
// SIGNAL DETECTOR
// ============================================================================

class SignalDetector {
  static shouldAlert(aggregation, symbolData) {
    if (!aggregation) return false;
    
    // Critical: validate all values are finite numbers
    if (!isFinite(aggregation.totalVolumeUSD) || 
        !isFinite(aggregation.dominancePercent) || 
        !isFinite(aggregation.priceChangePercent)) {
      return false;
    }
    
    // Minimum trade count requirement
    if (aggregation.tradeCount < 5) {
      return false;
    }
    
    // Minimum window duration (avoid instant spikes)
    if (aggregation.windowDurationSeconds < 10) {
      return false;
    }
    
    // Check volume threshold
    if (aggregation.totalVolumeUSD < CONFIG.MIN_VOLUME_USD) {
      return false;
    }
    
    // Check dominance threshold
    if (aggregation.dominancePercent < CONFIG.MIN_DOMINANCE_PCT) {
      return false;
    }
    
    // Check price change threshold
    if (Math.abs(aggregation.priceChangePercent) < CONFIG.MIN_PRICE_CHANGE_PCT) {
      return false;
    }
    
    // Check price direction matches dominance
    const priceUp = aggregation.priceChangePercent > 0;
    const buyDominant = aggregation.dominantSide === 'buy';
    
    if (priceUp !== buyDominant) {
      return false;
    }
    
    return true;
  }
  
  static formatAlert(aggregation, symbolData) {
    const liquidationType = aggregation.dominantSide === 'buy' ? 'SHORTS' : 'LONGS';
    const volumeStr = this.formatVolume(aggregation.totalVolumeUSD);
    const durationStr = this.formatDuration(aggregation.windowDurationSeconds);
    const changeSign = aggregation.priceChangePercent > 0 ? '+' : '';
    
    const baseCurrency = aggregation.symbol.replace('USDT', '');
    
    const buyStr = this.formatVolume(aggregation.buyVolumeUSD);
    const sellStr = this.formatVolume(aggregation.sellVolumeUSD);
    const oiStr = symbolData ? this.formatVolume(symbolData.oi * symbolData.price) : 'N/A';
    
    return `🔥 LIQUIDATION OF ${liquidationType}
Volume: ${volumeStr} (${durationStr})
Dominance: ${aggregation.dominancePercent.toFixed(1)}% ${aggregation.dominantSide.toUpperCase()}
————————————
🔥 ${baseCurrency}USDT #${baseCurrency}
Price change: ${changeSign}${aggregation.priceChangePercent.toFixed(2)}%
Buy: ${buyStr}
Sell: ${sellStr}
OI: ${oiStr}`;
  }
  
  static formatVolume(value) {
    if (!isFinite(value) || value === 0) {
      return '$0';
    }
    if (value >= 1000000) {
      return `${(value / 1000000).toFixed(2)}M`;
    }
    return `${(value / 1000).toFixed(0)}K`;
  }
  
  static formatDuration(seconds) {
    if (!isFinite(seconds)) {
      return '0m 00s';
    }
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}m ${secs.toString().padStart(2, '0')}s`;
  }
}

// ============================================================================
// COOLDOWN MANAGER
// ============================================================================

class CooldownManager {
  constructor(cooldownMinutes) {
    this.cooldownMs = cooldownMinutes * 60 * 1000;
    this.lastAlerts = new Map(); // symbol -> { timestamp, side, volume }
  }
  
  canAlert(symbol, aggregation) {
    const lastAlert = this.lastAlerts.get(symbol);
    
    if (!lastAlert) {
      return true;
    }
    
    const now = Date.now();
    const timeSinceLastAlert = now - lastAlert.timestamp;
    
    // Cooldown not expired
    if (timeSinceLastAlert < this.cooldownMs) {
      // Allow if opposite side
      if (lastAlert.side !== aggregation.dominantSide) {
        return true;
      }
      
      // Allow if volume significantly increased
      const volumeRatio = aggregation.totalVolumeUSD / lastAlert.volume;
      if (volumeRatio >= CONFIG.VOLUME_INCREASE_THRESHOLD) {
        return true;
      }
      
      return false;
    }
    
    // Cooldown expired
    return true;
  }
  
  recordAlert(symbol, aggregation) {
    this.lastAlerts.set(symbol, {
      timestamp: Date.now(),
      side: aggregation.dominantSide,
      volume: aggregation.totalVolumeUSD
    });
  }
  
  cleanup() {
    const now = Date.now();
    const cutoff = now - (this.cooldownMs * 2); // Keep 2x cooldown period
    
    for (const [symbol, data] of this.lastAlerts.entries()) {
      if (data.timestamp < cutoff) {
        this.lastAlerts.delete(symbol);
      }
    }
  }
}

// ============================================================================
// ALERT ENGINE
// ============================================================================

class AlertEngine {
  constructor() {
    this.telegramEnabled = !!(CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID);
    this.alertQueue = [];
    this.sending = false;
  }
  
  async sendAlert(message) {
    if (!this.telegramEnabled) {
      Logger.log('ALERT (Telegram disabled):', message);
      return;
    }
    
    this.alertQueue.push(message);
    this.processQueue();
  }
  
  async processQueue() {
    if (this.sending || this.alertQueue.length === 0) {
      return;
    }
    
    this.sending = true;
    
    while (this.alertQueue.length > 0) {
      const message = this.alertQueue.shift();
      
      try {
        await this.sendTelegram(message);
        Logger.log('Alert sent successfully');
        
        // Rate limit: 1 message per 2 seconds
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        Logger.error('Failed to send alert', error.message);
        // Don't retry, move to next message
      }
    }
    
    this.sending = false;
  }
  
  async sendTelegram(message) {
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
    
    await axios.post(url, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    }, {
      timeout: 10000
    });
  }
}

// ============================================================================
// WEBSOCKET MANAGER
// ============================================================================

class WebSocketManager {
  constructor(marketData, aggregators, cooldownManager, alertEngine) {
    this.marketData = marketData;
    this.aggregators = aggregators;
    this.cooldownManager = cooldownManager;
    this.alertEngine = alertEngine;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.pingInterval = null;
    this.subscribed = false;
  }
  
  connect() {
    Logger.log('Connecting to Bybit WebSocket...');
    
    this.ws = new WebSocket(CONFIG.BYBIT_WS);
    
    this.ws.on('open', () => {
      Logger.log('WebSocket connected');
      this.reconnectAttempts = 0;
      this.subscribed = false;
      this.subscribe();
      this.startPing();
    });
    
    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });
    
    this.ws.on('error', (error) => {
      Logger.error('WebSocket error', error.message);
    });
    
    this.ws.on('close', () => {
      Logger.log('WebSocket closed');
      this.stopPing();
      this.reconnect();
    });
  }
  
  subscribe() {
    if (this.subscribed) return;
    
    const symbols = this.marketData.getActiveSymbols();
    Logger.log(`Subscribing to ${symbols.length} symbols...`);
    
    // Subscribe in batches
    for (let i = 0; i < symbols.length; i += CONFIG.BATCH_SIZE) {
      const batch = symbols.slice(i, i + CONFIG.BATCH_SIZE);
      const topics = batch.map(s => `publicTrade.${s}`);
      
      const subscribeMsg = {
        op: 'subscribe',
        args: topics
      };
      
      setTimeout(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(subscribeMsg));
        }
      }, i * 100); // 100ms between batches
    }
    
    this.subscribed = true;
    Logger.log('Subscription requests sent');
  }
  
  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      
      // Subscription confirmation
      if (message.op === 'subscribe' && message.success) {
        Logger.debug('Subscription confirmed');
        return;
      }
      
      // Pong response
      if (message.op === 'pong') {
        return;
      }
      
      // Trade data
      if (message.topic && message.topic.startsWith('publicTrade.')) {
        this.handleTrade(message);
      }
    } catch (error) {
      Logger.debug('Message parse error', error.message);
    }
  }
  
  handleTrade(message) {
    const symbol = message.topic.replace('publicTrade.', '');
    
    if (this.marketData.isBlacklisted(symbol)) {
      return;
    }
    
    const trades = message.data || [];
    
    for (const trade of trades) {
      const aggregator = this.aggregators.get(symbol);
      if (!aggregator) continue;
      
      aggregator.addTrade(trade);
      
      // Check for signal
      const aggregation = aggregator.getAggregation();
      if (!aggregation) continue;
      
      const symbolData = this.marketData.getSymbolData(symbol);
      
      if (SignalDetector.shouldAlert(aggregation, symbolData)) {
        if (this.cooldownManager.canAlert(symbol, aggregation)) {
          const alertMessage = SignalDetector.formatAlert(aggregation, symbolData);
          this.alertEngine.sendAlert(alertMessage);
          this.cooldownManager.recordAlert(symbol, aggregation);
          
          Logger.log(`ALERT: ${symbol} - ${aggregation.dominantSide.toUpperCase()} dominance ${aggregation.dominancePercent.toFixed(1)}%`);
        }
      }
    }
  }
  
  startPing() {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, 20000); // Ping every 20 seconds
  }
  
  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
  
  reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      Logger.error('Max reconnect attempts reached. Exiting...');
      process.exit(1);
    }
    
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;
    
    Logger.log(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    
    setTimeout(() => {
      this.connect();
    }, delay);
  }
  
  close() {
    this.stopPing();
    if (this.ws) {
      this.ws.close();
    }
  }
}

// ============================================================================
// MAIN APPLICATION
// ============================================================================

class CryptoAlertBot {
  constructor() {
    this.marketData = null;
    this.aggregators = new Map();
    this.cooldownManager = null;
    this.alertEngine = null;
    this.wsManager = null;
    this.cleanupInterval = null;
  }
  
  async start() {
    Logger.log('='.repeat(60));
    Logger.log('CRYPTO LIQUIDATION ALERT BOT');
    Logger.log('='.repeat(60));
    Logger.log('Configuration:', {
      minVolumeUSD: CONFIG.MIN_VOLUME_USD,
      minDominancePct: CONFIG.MIN_DOMINANCE_PCT,
      minPriceChangePct: CONFIG.MIN_PRICE_CHANGE_PCT,
      windowDurationSec: CONFIG.WINDOW_DURATION_SEC,
      cooldownMinutes: CONFIG.COOLDOWN_MINUTES,
      maxSymbols: CONFIG.MAX_SYMBOLS,
      blacklistEnabled: CONFIG.BLACKLIST_ENABLED,
      telegramEnabled: !!(CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID)
    });
    Logger.log('='.repeat(60));
    
    // Initialize components
    this.marketData = new MarketDataManager();
    await this.marketData.initialize();
    
    // Create aggregators for each symbol
    const symbols = this.marketData.getActiveSymbols();
    for (const symbol of symbols) {
      this.aggregators.set(symbol, new TradeAggregator(symbol, CONFIG.WINDOW_DURATION_SEC));
    }
    
    this.cooldownManager = new CooldownManager(CONFIG.COOLDOWN_MINUTES);
    this.alertEngine = new AlertEngine();
    
    // Start WebSocket
    this.wsManager = new WebSocketManager(
      this.marketData,
      this.aggregators,
      this.cooldownManager,
      this.alertEngine
    );
    this.wsManager.connect();
    
    // Periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cooldownManager.cleanup();
    }, 60000); // Every minute
    
    Logger.log('Bot started successfully');
    Logger.log('='.repeat(60));
  }
  
  stop() {
    Logger.log('Shutting down bot...');
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    if (this.wsManager) {
      this.wsManager.close();
    }
    
    Logger.log('Bot stopped');
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main() {
  const bot = new CryptoAlertBot();
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    Logger.log('Received SIGINT signal');
    bot.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    Logger.log('Received SIGTERM signal');
    bot.stop();
    process.exit(0);
  });
  
  process.on('uncaughtException', (error) => {
    Logger.error('Uncaught exception', error);
    bot.stop();
    process.exit(1);
  });
  
  process.on('unhandledRejection', (error) => {
    Logger.error('Unhandled rejection', error);
    bot.stop();
    process.exit(1);
  });
  
  try {
    await bot.start();
  } catch (error) {
    Logger.error('Failed to start bot', error);
    process.exit(1);
  }
}

// Run if this is the main module
if (require.main === module) {
  main();
}

module.exports = { CryptoAlertBot, CONFIG };