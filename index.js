// ============================================================================
// BYBIT FUTURES LIQUIDATION ALERT BOT
// Real-time liquidation tracking with OI filtering
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
  // Alert thresholds
  MIN_LIQUIDATION_VOLUME: parseInt(process.env.MIN_LIQUIDATION_VOLUME) || 1_000_000,
  MIN_DOMINANCE: parseInt(process.env.MIN_DOMINANCE) || 65,
  LIQUIDATION_WINDOW_SECONDS: parseInt(process.env.LIQUIDATION_WINDOW_SECONDS) || 300, // 5 minutes
  COOLDOWN_MINUTES: parseInt(process.env.COOLDOWN_MINUTES) || 20,
  
  // OI filtering
  MIN_OPEN_INTEREST: parseInt(process.env.MIN_OPEN_INTEREST) || 10_000_000,
  MAX_OPEN_INTEREST: parseInt(process.env.MAX_OPEN_INTEREST) || 50_000_000,
  MIN_VOLUME_24H: parseInt(process.env.MIN_VOLUME_24H) || 1_000_000,
  
  // Debug mode - monitor ALL symbols (overrides filters)
  MONITOR_ALL_SYMBOLS: process.env.MONITOR_ALL_SYMBOLS === 'true',
  
  // Refresh settings
  REFRESH_MARKETS_MINUTES: parseInt(process.env.REFRESH_MARKETS_MINUTES) || 30,
  
  // Bybit WebSocket
  BYBIT_WS_PUBLIC: 'wss://stream.bybit.com/v5/public/linear',
  BYBIT_REST_API: 'https://api.bybit.com',
  
  // Telegram
  TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
};

// ============================================================================
// MARKET DATA MANAGER
// ============================================================================

class MarketDataManager {
  constructor() {
    this.markets = new Map(); // symbol -> { oi, price, volume24h, lastUpdate }
    this.eligibleSymbols = new Set();
  }

  async fetchAllMarkets() {
    console.log('[API] Fetching market data from Bybit...');
    
    try {
      // Get tickers (price, volume, OI)
      const tickersRes = await axios.get(`${CONFIG.BYBIT_REST_API}/v5/market/tickers`, {
        params: {
          category: 'linear'
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        },
        timeout: 15000
      });

      if (tickersRes.data.retCode !== 0) {
        throw new Error(`Bybit API error: ${tickersRes.data.retMsg}`);
      }

      const tickers = tickersRes.data.result.list;
      let eligibleCount = 0;
      const allSymbols = [];

      for (const ticker of tickers) {
        const symbol = ticker.symbol;
        
        // Only USDT perpetuals
        if (!symbol.endsWith('USDT')) continue;

        const price = parseFloat(ticker.lastPrice) || 0;
        const volume24h = parseFloat(ticker.turnover24h) || 0;
        const oi = parseFloat(ticker.openInterest) || 0;
        const oiValue = oi * price;

        allSymbols.push({ symbol, oiValue, volume24h, price });

        // Store market data
        this.markets.set(symbol, {
          oi: oiValue,
          price,
          volume24h,
          lastUpdate: Date.now()
        });

        // Check eligibility
        const isEligible = CONFIG.MONITOR_ALL_SYMBOLS || (
          oiValue >= CONFIG.MIN_OPEN_INTEREST &&
          oiValue <= CONFIG.MAX_OPEN_INTEREST &&
          volume24h >= CONFIG.MIN_VOLUME_24H
        );

        if (isEligible) {
          this.eligibleSymbols.add(symbol);
          eligibleCount++;
        }
      }

      console.log(`[API] Total markets: ${tickers.length}`);
      console.log(`[API] Eligible symbols: ${eligibleCount}`);
      
      if (CONFIG.MONITOR_ALL_SYMBOLS) {
        console.log(`[API] 🔥 DEBUG MODE: Monitoring ALL symbols (filters disabled)`);
      } else {
        console.log(`[API] Filters:`);
        console.log(`      - OI: ${(CONFIG.MIN_OPEN_INTEREST / 1e6).toFixed(1)}M - ${(CONFIG.MAX_OPEN_INTEREST / 1e6).toFixed(1)}M`);
        console.log(`      - Min 24h volume: ${(CONFIG.MIN_VOLUME_24H / 1e6).toFixed(1)}M`);
      }
      
      if (eligibleCount === 0) {
        console.log(`\n[API] ⚠️  No symbols match criteria. Top 10 by OI:`);
        allSymbols
          .sort((a, b) => b.oiValue - a.oiValue)
          .slice(0, 10)
          .forEach((s, i) => {
            console.log(`      ${(i + 1).toString().padStart(2)}. ${s.symbol.padEnd(12)} | OI: $${(s.oiValue / 1e6).toFixed(1)}M | Vol: $${(s.volume24h / 1e6).toFixed(1)}M`);
          });
      } else {
        console.log(`[API] ✅ Monitoring ${eligibleCount} symbols`);
      }
      console.log('');

      return Array.from(this.eligibleSymbols);
    } catch (error) {
      console.error('[API] ❌ Failed to fetch markets:', error.message);
      if (error.response) {
        console.error(`[API] Status: ${error.response.status}`);
      }
      return [];
    }
  }

  getMarketData(symbol) {
    return this.markets.get(symbol);
  }

  isEligible(symbol) {
    return this.eligibleSymbols.has(symbol);
  }

  getEligibleSymbols() {
    return Array.from(this.eligibleSymbols);
  }

  updatePrice(symbol, price) {
    const market = this.markets.get(symbol);
    if (market) {
      market.price = price;
      market.lastUpdate = Date.now();
    }
  }
}

// ============================================================================
// LIQUIDATION TRACKER
// ============================================================================

class LiquidationTracker {
  constructor() {
    this.liquidations = new Map(); // symbol -> [liquidation events]
  }

  addLiquidation(symbol, liquidation) {
    if (!this.liquidations.has(symbol)) {
      this.liquidations.set(symbol, []);
    }

    this.liquidations.get(symbol).push({
      timestamp: liquidation.timestamp,
      side: liquidation.side, // 'Buy' or 'Sell'
      price: liquidation.price,
      size: liquidation.size,
      value: liquidation.value // USD value
    });

    this.cleanup(symbol);
  }

  cleanup(symbol) {
    const now = Date.now();
    const windowMs = CONFIG.LIQUIDATION_WINDOW_SECONDS * 1000;

    if (this.liquidations.has(symbol)) {
      const filtered = this.liquidations.get(symbol)
        .filter(liq => now - liq.timestamp < windowMs);
      
      if (filtered.length === 0) {
        this.liquidations.delete(symbol);
      } else {
        this.liquidations.set(symbol, filtered);
      }
    }
  }

  getWindowStats(symbol) {
    if (!this.liquidations.has(symbol)) {
      return null;
    }

    const liquidations = this.liquidations.get(symbol);
    if (liquidations.length === 0) return null;

    let longLiqValue = 0;  // Longs getting liquidated (Sell side)
    let shortLiqValue = 0; // Shorts getting liquidated (Buy side)

    for (const liq of liquidations) {
      if (liq.side === 'Sell') {
        // Long position liquidated
        longLiqValue += liq.value;
      } else {
        // Short position liquidated
        shortLiqValue += liq.value;
      }
    }

    const totalVolume = longLiqValue + shortLiqValue;
    
    if (totalVolume === 0) return null;

    // Dominance calculation
    const longDominance = (longLiqValue / totalVolume) * 100;
    const shortDominance = (shortLiqValue / totalVolume) * 100;
    
    const dominantSide = longLiqValue > shortLiqValue ? 'long' : 'short';
    const dominance = Math.max(longDominance, shortDominance);

    const now = Date.now();
    const duration = (now - liquidations[0].timestamp) / 1000;

    return {
      longLiqValue,
      shortLiqValue,
      totalVolume,
      dominantSide,
      dominance,
      longDominance,
      shortDominance,
      duration,
      count: liquidations.length
    };
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
      // Allow new alert if significantly larger or different side
      const volumeIncrease = stats.totalVolume / lastAlert.volume;
      const sameSide = stats.dominantSide === lastAlert.side;
      
      if (sameSide && volumeIncrease < 1.5) {
        return false;
      }
    }

    return true;
  }

  recordAlert(symbol, stats) {
    this.cooldowns.set(symbol, {
      timestamp: Date.now(),
      volume: stats.totalVolume,
      side: stats.dominantSide
    });
  }
}

// ============================================================================
// ALERT FORMATTER
// ============================================================================

class AlertFormatter {
  format(symbol, stats, marketData) {
    const isLongLiq = stats.dominantSide === 'long';
    const type = isLongLiq ? 'ЛОНГОВ' : 'ШОРТОВ';
    const emoji = isLongLiq ? '🌊' : '🔥';
    
    const lines = [];
    
    lines.push(`${emoji} ЛИКВИДАЦИЯ ${type}`);
    lines.push(`Объем: $${this.formatNumber(stats.totalVolume)} (за ${this.formatDuration(stats.duration)})`);
    lines.push(`Доминирование: ${stats.dominance.toFixed(1)}% ${type}`);
    lines.push('============================');
    
    // Clean symbol name (remove USDT)
    const cleanSymbol = symbol.replace('USDT', '');
    lines.push(`🔥 ${symbol} #${cleanSymbol}`);
    lines.push('============================');
    
    if (marketData) {
      lines.push(`💸 OI : $${this.formatNumber(marketData.oi)}`);
      lines.push('============================');
      lines.push(`📉 Цена : $${marketData.price.toFixed(5)}`);
    }
    
    return lines.join('\n');
  }

  formatNumber(num) {
    if (num >= 1_000_000) {
      return (num / 1_000_000).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
  constructor(telegram, cooldownManager, marketDataManager) {
    this.telegram = telegram;
    this.cooldownManager = cooldownManager;
    this.marketDataManager = marketDataManager;
    this.formatter = new AlertFormatter();
  }

  async checkAndAlert(symbol, stats) {
    // Check thresholds
    if (stats.totalVolume < CONFIG.MIN_LIQUIDATION_VOLUME) {
      return;
    }

    if (stats.dominance < CONFIG.MIN_DOMINANCE) {
      return;
    }

    // Check cooldown
    if (!this.cooldownManager.canAlert(symbol, stats)) {
      return;
    }

    // Get market data
    const marketData = this.marketDataManager.getMarketData(symbol);
    if (!marketData) {
      return;
    }

    // Format and send message
    const message = this.formatter.format(symbol, stats, marketData);
    
    try {
      await this.telegram.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message);
      this.cooldownManager.recordAlert(symbol, stats);
      
      console.log(`[ALERT] ${symbol} - ${stats.dominantSide.toUpperCase()} LIQ - $${(stats.totalVolume / 1e6).toFixed(2)}M - ${stats.dominance.toFixed(1)}%`);
    } catch (error) {
      console.error(`[ERROR] Failed to send alert for ${symbol}:`, error.message);
    }
  }
}

// ============================================================================
// BYBIT WEBSOCKET LISTENER
// ============================================================================

class BybitWebSocketListener {
  constructor(liquidationTracker, alertTrigger, marketDataManager) {
    this.liquidationTracker = liquidationTracker;
    this.alertTrigger = alertTrigger;
    this.marketDataManager = marketDataManager;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.pingInterval = null;
    this.subscribedSymbols = new Set();
    this.lastHeartbeat = null;
    this.subscriptionConfirmed = false;
    this.activityCheckInterval = null;
  }

  async connect() {
    console.log('[WS] Connecting to Bybit WebSocket...');
    
    this.ws = new WebSocket(CONFIG.BYBIT_WS_PUBLIC);

    this.ws.on('open', () => {
      console.log('[WS] ✅ Connected successfully');
      this.reconnectAttempts = 0;
      this.startPingInterval();
      this.subscribeToLiquidations();
      this.startActivityCheck();
    });

    this.ws.on('message', (data) => {
      // Log EVERY message for debugging
      const message = JSON.parse(data);
      
      // Skip only pings
      if (message.op !== 'pong') {
        console.log('[WS] 📨 RAW MESSAGE:', JSON.stringify(message).substring(0, 200));
      }
      
      this.handleMessage(data);
    });

    this.ws.on('error', (error) => {
      console.error('[WS] Error:', error.message);
    });

    this.ws.on('close', () => {
      console.log('[WS] Connection closed');
      this.stopPingInterval();
      this.stopActivityCheck();
      this.reconnect();
    });
  }

  subscribeToLiquidations() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const eligibleSymbols = this.marketDataManager.getEligibleSymbols();
    
    if (eligibleSymbols.length === 0) {
      console.log('[WS] ⚠️  No eligible symbols to subscribe');
      return;
    }

    console.log(`[WS] 📡 Subscribing to ${eligibleSymbols.length} symbols...`);

    // Subscribe in batches of 10
    const batchSize = 10;
    for (let i = 0; i < eligibleSymbols.length; i += batchSize) {
      const batch = eligibleSymbols.slice(i, i + batchSize);
      const topics = batch.map(symbol => `allLiquidation.${symbol}`); // ← CHANGED from 'liquidation.'
      
      this.ws.send(JSON.stringify({
        op: 'subscribe',
        args: topics
      }));

      batch.forEach(symbol => this.subscribedSymbols.add(symbol));
    }

    console.log(`[WS] ✅ Subscribed to ${eligibleSymbols.length} symbols`);
    console.log('[WS] 📊 Monitored symbols (first 15):');
    
    eligibleSymbols.slice(0, 15).forEach(symbol => {
      const data = this.marketDataManager.getMarketData(symbol);
      if (data) {
        console.log(`     ${symbol.padEnd(15)} | OI: $${(data.oi / 1e6).toFixed(1)}M`);
      }
    });
    
    if (eligibleSymbols.length > 15) {
      console.log(`     ... and ${eligibleSymbols.length - 15} more`);
    }
    
    console.log('\n[STATUS] 🎯 Monitoring liquidations...');
    console.log(`[STATUS] 💰 Threshold: $${(CONFIG.MIN_LIQUIDATION_VOLUME / 1e6).toFixed(1)}M volume, ${CONFIG.MIN_DOMINANCE}% dominance`);
    console.log('[STATUS] ⏳ Waiting for liquidation events...\n');
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      
      // Handle pong
      if (message.op === 'pong') {
        // Show heartbeat every 5 minutes
        if (!this.lastHeartbeat || Date.now() - this.lastHeartbeat > 300000) {
          console.log('[WS] 💓 Heartbeat - connection alive');
          this.lastHeartbeat = Date.now();
        }
        return;
      }

      // Handle subscription success
      if (message.success === true) {
        if (!this.subscriptionConfirmed) {
          console.log('[WS] ✅ Subscription confirmed by Bybit');
          this.subscriptionConfirmed = true;
        }
        return;
      }

      // Handle liquidation data
      if (message.topic && message.topic.startsWith('liquidation.')) {
        const symbol = message.topic.replace('liquidation.', '');
        
        const rawData = message.data;
        const liqValue = parseFloat(rawData.price) * parseFloat(rawData.size);
        const liqType = rawData.side === 'Sell' ? '🔴 LONG' : '🟢 SHORT';
        
        // Log individual liquidation
        console.log(`[LIQ] ${symbol.padEnd(12)} | ${liqType} | ${(liqValue / 1000).toFixed(1)}K @ ${parseFloat(rawData.price).toFixed(2)}`);
        
        // Only process eligible symbols
        if (!this.marketDataManager.isEligible(symbol)) {
          console.log(`      └─ ⏭️  Skipped (not eligible)`);
          return;
        }

        const liquidation = {
          timestamp: rawData.updatedTime || Date.now(),
          side: rawData.side, // 'Buy' or 'Sell'
          price: parseFloat(rawData.price),
          size: parseFloat(rawData.size),
          value: liqValue
        };

        // Update price
        this.marketDataManager.updatePrice(symbol, liquidation.price);

        // Add liquidation
        this.liquidationTracker.addLiquidation(symbol, liquidation);

        // Check for alerts
        const stats = this.liquidationTracker.getWindowStats(symbol);
        if (stats) {
          const accType = stats.dominantSide === 'long' ? '🔴 LONG' : '🟢 SHORT';
          console.log(`[ACCUM] ${symbol.padEnd(12)} | Total: ${(stats.totalVolume / 1000).toFixed(1)}K | ${accType} ${stats.dominance.toFixed(1)}% | ${stats.duration.toFixed(0)}s`);
          
          // Show progress
          if (stats.totalVolume >= CONFIG.MIN_LIQUIDATION_VOLUME && stats.dominance >= CONFIG.MIN_DOMINANCE) {
            console.log(`        └─ 🎯 THRESHOLD MET! Sending alert...`);
          } else {
            const volPct = (stats.totalVolume / CONFIG.MIN_LIQUIDATION_VOLUME * 100).toFixed(0);
            console.log(`        └─ 📊 ${volPct}% volume | ${stats.dominance.toFixed(1)}% dominance`);
          }
          
          this.alertTrigger.checkAndAlert(symbol, stats);
        }
      }
      
    } catch (error) {
      console.error('[ERROR] Failed to parse message:', error.message);
    }
  }

  startPingInterval() {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ op: 'ping' }));
        } catch (error) {
          console.error('[WS] Ping error:', error.message);
        }
      }
    }, 20000);
  }

  startActivityCheck() {
    // Check every 10 minutes if we're receiving data
    this.activityCheckInterval = setInterval(() => {
      console.log('[STATUS] 🔍 Activity check - still monitoring...');
      console.log(`[STATUS] 📊 Subscribed to ${this.subscribedSymbols.size} symbols`);
      console.log(`[STATUS] ⏳ Waiting for liquidations... (This is normal during low volatility)`);
    }, 600000); // 10 minutes
  }

  stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  stopActivityCheck() {
    if (this.activityCheckInterval) {
      clearInterval(this.activityCheckInterval);
      this.activityCheckInterval = null;
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

  async resubscribe() {
    console.log('[WS] Resubscribing to symbols...');
    this.subscribedSymbols.clear();
    
    // Refresh market data
    await this.marketDataManager.fetchAllMarkets();
    
    // Resubscribe
    this.subscribeToLiquidations();
  }

  close() {
    this.stopPingInterval();
    this.stopActivityCheck();
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
    this.marketDataManager = new MarketDataManager();
    this.liquidationTracker = new LiquidationTracker();
    this.cooldownManager = new CooldownManager(CONFIG.COOLDOWN_MINUTES);
    this.alertTrigger = new AlertTrigger(
      this.telegram,
      this.cooldownManager,
      this.marketDataManager
    );
    this.wsListener = new BybitWebSocketListener(
      this.liquidationTracker,
      this.alertTrigger,
      this.marketDataManager
    );
    this.refreshInterval = null;
  }

  async start() {
    console.log('='.repeat(60));
    console.log('BYBIT LIQUIDATION ALERT BOT');
    console.log('='.repeat(60));
    console.log(`Min Liquidation Volume: $${(CONFIG.MIN_LIQUIDATION_VOLUME / 1e6).toFixed(1)}M`);
    console.log(`Min Dominance: ${CONFIG.MIN_DOMINANCE}%`);
    console.log(`Liquidation Window: ${CONFIG.LIQUIDATION_WINDOW_SECONDS}s`);
    console.log(`OI Range: $${(CONFIG.MIN_OPEN_INTEREST / 1e6).toFixed(1)}M - $${(CONFIG.MAX_OPEN_INTEREST / 1e6).toFixed(1)}M`);
    console.log(`Min 24h Volume: $${(CONFIG.MIN_VOLUME_24H / 1e6).toFixed(1)}M`);
    console.log(`Cooldown: ${CONFIG.COOLDOWN_MINUTES} minutes`);
    console.log(`Market Refresh: every ${CONFIG.REFRESH_MARKETS_MINUTES} minutes`);
    console.log('='.repeat(60));

    // Test Telegram
    try {
      await this.telegram.sendMessage(
        CONFIG.TELEGRAM_CHAT_ID,
        '🚀 Bybit Liquidation Bot Started\n\n✅ Real-time liquidation tracking active!'
      );
      console.log('[TELEGRAM] ✅ Connection successful\n');
    } catch (error) {
      console.error('[TELEGRAM] ❌ Failed to connect:', error.message);
      process.exit(1);
    }

    // Fetch initial market data
    await this.marketDataManager.fetchAllMarkets();

    // Connect WebSocket
    await this.wsListener.connect();

    // Start periodic market refresh
    this.startMarketRefresh();

    // Shutdown handlers
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  startMarketRefresh() {
    this.refreshInterval = setInterval(async () => {
      console.log('\n[REFRESH] Updating market data...');
      await this.wsListener.resubscribe();
    }, CONFIG.REFRESH_MARKETS_MINUTES * 60 * 1000);
  }

  async shutdown() {
    console.log('\n[SHUTDOWN] Stopping bot...');
    
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    
    this.wsListener.close();
    
    await this.telegram.sendMessage(
      CONFIG.TELEGRAM_CHAT_ID,
      '⛔ Bybit Liquidation Bot Stopped'
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