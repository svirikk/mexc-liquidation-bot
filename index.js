// ============================================================================
// BINANCE FUTURES LIQUIDATION ALERT BOT
// Моніторинг масових ліквідацій для reversal-трейдингу
// 
// ЛОГІКА:
// 1. Отримати ВСІ токени з Binance Futures
// 2. Перевірити MCAP кожного на CoinGecko
// 3. Підписатись ТІЛЬКИ на валідні (в діапазоні MCAP)
// 4. Оновлювати список кожні 2 години
// ============================================================================

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const { TokenFilter } = require('./token-filter');

// ============================================================================
// КОНФІГУРАЦІЯ
// ============================================================================

const CONFIG = {
  // WebSocket - множинні стріми для валідних токенів
  BINANCE_WS_BASE: 'wss://fstream.binance.com/stream?streams=',
  
  // Пороги алертів
  MIN_LIQUIDATION_USD: parseInt(process.env.MIN_LIQUIDATION_USD) || 1_000_000,
  MIN_DOMINANCE: parseFloat(process.env.MIN_DOMINANCE) || 65.0,
  
  // Часове вікно агрегації (секунди)
  AGGREGATION_WINDOW_SEC: parseInt(process.env.AGGREGATION_WINDOW_SEC) || 180,
  
  // Anti-spam
  COOLDOWN_MINUTES: parseInt(process.env.COOLDOWN_MINUTES) || 20,
  DEDUP_WINDOW_SEC: parseInt(process.env.DEDUP_WINDOW_SEC) || 60,
  
  // Перевірка вікон
  CHECK_INTERVAL_SEC: parseInt(process.env.CHECK_INTERVAL_SEC) || 15,
  
  // Фільтр токенів (тільки MCAP)
  FILTER_CONFIG: {
    MIN_MCAP_USD: parseInt(process.env.MIN_MCAP_USD) || 10_000_000,
    MAX_MCAP_USD: parseInt(process.env.MAX_MCAP_USD) || 150_000_000,
    UPDATE_INTERVAL_HOURS: parseInt(process.env.FILTER_UPDATE_HOURS) || 2,
  },
  
  // Telegram
  TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_IDS: process.env.TELEGRAM_CHAT_ID 
    ? process.env.TELEGRAM_CHAT_ID.split(',').map(id => id.trim())
    : [],
};

// ============================================================================
// АГРЕГАТОР ЛІКВІДАЦІЙ
// ============================================================================

class LiquidationAggregator {
  constructor(windowSeconds) {
    this.windows = new Map();
    this.windowMs = windowSeconds * 1000;
  }

  addLiquidation(symbol, liquidation) {
    if (!this.windows.has(symbol)) {
      this.windows.set(symbol, {
        liquidations: [],
        startTime: Date.now()
      });
    }

    const window = this.windows.get(symbol);
    window.liquidations.push(liquidation);
    
    this.cleanup(symbol);
  }

  cleanup(symbol) {
    if (!this.windows.has(symbol)) return;

    const window = this.windows.get(symbol);
    const now = Date.now();
    
    window.liquidations = window.liquidations.filter(
      liq => now - liq.timestamp < this.windowMs
    );

    if (window.liquidations.length === 0) {
      this.windows.delete(symbol);
    } else {
      window.startTime = window.liquidations[0].timestamp;
    }
  }

  getWindowStats(symbol) {
    if (!this.windows.has(symbol)) return null;

    const window = this.windows.get(symbol);
    if (window.liquidations.length === 0) return null;

    let longVolumeUSD = 0;
    let shortVolumeUSD = 0;

    for (const liq of window.liquidations) {
      if (liq.side === 'LONG') {
        longVolumeUSD += liq.volumeUSD;
      } else {
        shortVolumeUSD += liq.volumeUSD;
      }
    }

    const totalVolumeUSD = longVolumeUSD + shortVolumeUSD;
    if (totalVolumeUSD === 0) return null;

    const longDominance = (longVolumeUSD / totalVolumeUSD) * 100;
    const shortDominance = (shortVolumeUSD / totalVolumeUSD) * 100;
    
    const dominantSide = longVolumeUSD > shortVolumeUSD ? 'LONG' : 'SHORT';
    const dominance = Math.max(longDominance, shortDominance);

    const now = Date.now();
    const durationSec = (now - window.startTime) / 1000;

    return {
      symbol,
      longVolumeUSD,
      shortVolumeUSD,
      totalVolumeUSD,
      dominantSide,
      dominance,
      longDominance,
      shortDominance,
      count: window.liquidations.length,
      durationSec,
      timestamp: now
    };
  }

  getAllActiveSymbols() {
    return Array.from(this.windows.keys());
  }

  reset(symbol) {
    this.windows.delete(symbol);
  }
}

// ============================================================================
// ДЕТЕКТОР СИГНАЛІВ
// ============================================================================

class SignalDetector {
  shouldAlert(stats) {
    if (!stats) return false;

    if (stats.totalVolumeUSD < CONFIG.MIN_LIQUIDATION_USD) {
      return false;
    }

    if (stats.dominance < CONFIG.MIN_DOMINANCE) {
      return false;
    }

    return true;
  }

  getSignature(stats) {
    return `${stats.symbol}:${stats.dominantSide}:${Math.floor(stats.totalVolumeUSD / 100000)}`;
  }
}

// ============================================================================
// COOLDOWN МЕНЕДЖЕР
// ============================================================================

class CooldownManager {
  constructor(cooldownMinutes, dedupWindowSec) {
    this.cooldowns = new Map();
    this.recentAlerts = new Map();
    this.cooldownMs = cooldownMinutes * 60 * 1000;
    this.dedupWindowMs = dedupWindowSec * 1000;
  }

  canAlert(symbol, stats, signature) {
    const now = Date.now();

    if (this.cooldowns.has(symbol)) {
      const lastAlert = this.cooldowns.get(symbol);
      if (now - lastAlert < this.cooldownMs) {
        return false;
      }
    }

    if (this.recentAlerts.has(signature)) {
      const lastSig = this.recentAlerts.get(signature);
      if (now - lastSig < this.dedupWindowMs) {
        return false;
      }
    }

    return true;
  }

  recordAlert(symbol, signature) {
    const now = Date.now();
    this.cooldowns.set(symbol, now);
    this.recentAlerts.set(signature, now);
    
    this.cleanup();
  }

  cleanup() {
    const now = Date.now();
    
    for (const [symbol, timestamp] of this.cooldowns.entries()) {
      if (now - timestamp > this.cooldownMs * 2) {
        this.cooldowns.delete(symbol);
      }
    }

    for (const [sig, timestamp] of this.recentAlerts.entries()) {
      if (now - timestamp > this.dedupWindowMs * 2) {
        this.recentAlerts.delete(sig);
      }
    }
  }
}

// ============================================================================
// ФОРМАТЕР АЛЕРТІВ
// ============================================================================

class AlertFormatter {
  format(stats) {
    const lines = [];
    
    const emoji = stats.dominantSide === 'LONG' ? '🌊' : '🔥';
    const sideText = stats.dominantSide === 'LONG' ? 'ЛОНГОВ' : 'ШОРТОВ';
    lines.push(`${emoji} ЛИКВИДАЦИЯ ${sideText}`);
    
    const volumeStr = this.formatVolume(stats.totalVolumeUSD);
    const durationStr = this.formatDuration(stats.durationSec);
    lines.push(`Объем: $${volumeStr} (за ${durationStr})`);
    
    const dominanceText = stats.dominantSide === 'LONG' ? 'ЛОНГОВ' : 'ШОРТОВ';
    lines.push(`Доминирование: ${stats.dominance.toFixed(1)}% ${dominanceText}`);
    
    lines.push('————————————————————');
    
    const cleanSymbol = stats.symbol.replace('USDT', '');
    lines.push(`🔥 ${stats.symbol} #${cleanSymbol}`);
    
    const windowMin = Math.floor(stats.durationSec / 60);
    lines.push(`⏱️ Окно: ${windowMin} мин`);
    
    lines.push(`📊 Кол-во ликвидаций: ${stats.count}`);
    
    return lines.join('\n');
  }

  formatVolume(usd) {
    if (usd >= 1_000_000) {
      return `${(usd / 1_000_000).toFixed(2)}M`;
    }
    return `${(usd / 1_000).toFixed(0)}K`;
  }

  formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}м ${secs}с`;
  }
}

// ============================================================================
// TELEGRAM NOTIFIER
// ============================================================================

class TelegramNotifier {
  constructor(token, chatIds) {
    this.bot = new TelegramBot(token, { polling: false });
    this.chatIds = chatIds;
    this.formatter = new AlertFormatter();
  }

  async sendAlert(stats) {
    const message = this.formatter.format(stats);
    
    const promises = this.chatIds.map(chatId =>
      this.bot.sendMessage(chatId, message).catch(err => {
        console.error(`[TELEGRAM] Помилка відправки до ${chatId}:`, err.message);
      })
    );

    await Promise.all(promises);
  }

  async sendStatus(message) {
    const promises = this.chatIds.map(chatId =>
      this.bot.sendMessage(chatId, message).catch(err => {
        console.error(`[TELEGRAM] Помилка відправки статусу:`, err.message);
      })
    );

    await Promise.all(promises);
  }
}

// ============================================================================
// WEBSOCKET МЕНЕДЖЕР (підписка тільки на валідні токени)
// ============================================================================

class BinanceWebSocketManager {
  constructor(aggregator, tokenFilter) {
    this.aggregator = aggregator;
    this.tokenFilter = tokenFilter;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.isConnected = false;
    this.subscribedTokens = new Set();
  }

  async connect() {
    const validTokens = this.tokenFilter.getValidTokens();
    
    if (validTokens.length === 0) {
      console.error('[WS] Немає валідних токенів для підписки!');
      return;
    }

    console.log(`[WS] Підключення до Binance Futures (${validTokens.length} токенів)...`);
    
    // Формуємо список стрімів тільки для валідних токенів
    const streams = validTokens.map(symbol => 
      `${symbol.toLowerCase()}@forceOrder`
    );

    const wsUrl = CONFIG.BINANCE_WS_BASE + streams.join('/');
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('[WS] ✅ Підключено');
      console.log(`[WS] 📡 Підписано на ${validTokens.length} токенів`);
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.subscribedTokens = new Set(validTokens);
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (error) => {
      console.error('[WS] Помилка:', error.message);
    });

    this.ws.on('close', () => {
      console.log('[WS] З\'єднання закрито');
      this.isConnected = false;
      this.reconnect();
    });
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      
      // Формат: { stream: "btcusdt@forceOrder", data: { o: {...} } }
      if (!message.data || !message.data.o) return;

      const order = message.data.o;
      const symbol = order.s;
      
      const side = order.S === 'BUY' ? 'SHORT' : 'LONG';
      const price = parseFloat(order.p);
      const quantity = parseFloat(order.q);
      const volumeUSD = price * quantity;

      // Додаємо в агрегатор (тільки валідні токени приходять з WS)
      this.aggregator.addLiquidation(symbol, {
        side,
        price,
        quantity,
        volumeUSD,
        timestamp: Date.now()
      });

    } catch (error) {
      // Мовчки ігноруємо помилки парсингу
    }
  }

  async resubscribe() {
    console.log('[WS] 🔄 Переподписка на оновлений список токенів...');
    
    // Закриваємо старе з'єднання
    if (this.ws) {
      this.ws.close();
    }

    // Чекаємо трохи
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Підключаємось знову з новим списком
    await this.connect();
  }

  reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Досягнуто максимум спроб переподключення');
      return;
    }

    this.reconnectAttempts++;
    console.log(`[WS] Переподключення через ${this.reconnectDelay / 1000}с (спроба ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// ============================================================================
// ALERT ENGINE
// ============================================================================

class AlertEngine {
  constructor(aggregator, detector, cooldownManager, notifier) {
    this.aggregator = aggregator;
    this.detector = detector;
    this.cooldownManager = cooldownManager;
    this.notifier = notifier;
    this.checkInterval = null;
  }

  start() {
    console.log(`[ENGINE] Запуск перевірки кожні ${CONFIG.CHECK_INTERVAL_SEC}с`);
    
    this.checkInterval = setInterval(() => {
      this.checkAllWindows();
    }, CONFIG.CHECK_INTERVAL_SEC * 1000);
  }

  checkAllWindows() {
    const symbols = this.aggregator.getAllActiveSymbols();
    
    for (const symbol of symbols) {
      const stats = this.aggregator.getWindowStats(symbol);
      
      if (!stats) continue;

      if (!this.detector.shouldAlert(stats)) {
        continue;
      }

      const signature = this.detector.getSignature(stats);
      if (!this.cooldownManager.canAlert(symbol, stats, signature)) {
        continue;
      }

      this.sendAlert(symbol, stats, signature);
    }
  }

  async sendAlert(symbol, stats, signature) {
    try {
      await this.notifier.sendAlert(stats);
      
      this.cooldownManager.recordAlert(symbol, signature);
      
      console.log(`[🚨 ALERT] ${symbol} | ${stats.dominantSide} | $${(stats.totalVolumeUSD / 1e6).toFixed(2)}M | ${stats.dominance.toFixed(1)}%`);
      
      this.aggregator.reset(symbol);
      
    } catch (error) {
      console.error(`[ERROR] Помилка відправки алерту ${symbol}:`, error.message);
    }
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }
}

// ============================================================================
// ГОЛОВНИЙ БОТ
// ============================================================================

class BinanceLiquidationBot {
  constructor() {
    this.tokenFilter = new TokenFilter(CONFIG.FILTER_CONFIG);
    this.aggregator = new LiquidationAggregator(CONFIG.AGGREGATION_WINDOW_SEC);
    this.detector = new SignalDetector();
    this.cooldownManager = new CooldownManager(
      CONFIG.COOLDOWN_MINUTES,
      CONFIG.DEDUP_WINDOW_SEC
    );
    this.notifier = new TelegramNotifier(
      CONFIG.TELEGRAM_TOKEN,
      CONFIG.TELEGRAM_CHAT_IDS
    );
    this.wsManager = new BinanceWebSocketManager(this.aggregator, this.tokenFilter);
    this.alertEngine = new AlertEngine(
      this.aggregator,
      this.detector,
      this.cooldownManager,
      this.notifier
    );

    // Слухаємо оновлення фільтра для переподписки
    this.setupFilterUpdateListener();
  }

  setupFilterUpdateListener() {
    // Перевіряємо оновлення фільтра кожні 2 години + 1 хвилину
    const checkInterval = CONFIG.FILTER_CONFIG.UPDATE_INTERVAL_HOURS * 60 * 60 * 1000 + 60000;
    
    setInterval(async () => {
      console.log('[BOT] 🔄 Час переподписатися на оновлений список токенів...');
      await this.wsManager.resubscribe();
    }, checkInterval);
  }

  async start() {
    console.log('='.repeat(70));
    console.log('BINANCE FUTURES LIQUIDATION ALERT BOT');
    console.log('🎯 Отримати токени Binance → Перевірити MCAP → Підписатись');
    console.log('='.repeat(70));
    console.log(`Мін об'єм: $${(CONFIG.MIN_LIQUIDATION_USD / 1e6).toFixed(1)}M`);
    console.log(`Мін домінування: ${CONFIG.MIN_DOMINANCE}%`);
    console.log(`Вікно агрегації: ${CONFIG.AGGREGATION_WINDOW_SEC}с`);
    console.log(`Cooldown: ${CONFIG.COOLDOWN_MINUTES} хв`);
    console.log('='.repeat(70));
    console.log('ФІЛЬТР ТОКЕНІВ (MCAP):');
    console.log(`  Діапазон: $${this.formatNum(CONFIG.FILTER_CONFIG.MIN_MCAP_USD)} - $${this.formatNum(CONFIG.FILTER_CONFIG.MAX_MCAP_USD)}`);
    console.log(`  Оновлення: кожні ${CONFIG.FILTER_CONFIG.UPDATE_INTERVAL_HOURS}год`);
    console.log('='.repeat(70));

    // Ініціалізація фільтра токенів
    console.log('\n⏳ Аналіз токенів Binance Futures та їх Market Cap...');
    await this.tokenFilter.initialize();

    const stats = this.tokenFilter.getStats();
    console.log('\n📊 ФІЛЬТРАЦІЯ ЗАВЕРШЕНА');
    console.log(`   Валідних токенів: ${stats.total}`);
    console.log(`   Діапазон: ${stats.config.mcapRange}\n`);

    // Тест Telegram
    try {
      await this.notifier.sendStatus(
        '🚀 Binance Liquidation Bot запущено\n\n' +
        `✅ Валідних токенів: ${stats.total}\n` +
        `✅ MCAP діапазон: ${stats.config.mcapRange}\n` +
        `✅ Мін об\'єм: $${(CONFIG.MIN_LIQUIDATION_USD / 1e6).toFixed(1)}M\n` +
        `✅ Мін домінування: ${CONFIG.MIN_DOMINANCE}%`
      );
      console.log('[TELEGRAM] ✅ Підключено\n');
    } catch (error) {
      console.error('[TELEGRAM] ❌ Помилка:', error.message);
      process.exit(1);
    }

    // Запуск WebSocket (підписка тільки на валідні токени)
    await this.wsManager.connect();

    // Запуск движка алертів
    this.alertEngine.start();

    // Обробники завершення
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  formatNum(num) {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    }
    return `${(num / 1_000).toFixed(0)}K`;
  }

  async shutdown() {
    console.log('\n[SHUTDOWN] Зупинка бота...');
    
    this.alertEngine.stop();
    this.tokenFilter.stop();
    this.wsManager.close();
    
    await this.notifier.sendStatus('⛔ Binance Liquidation Bot зупинено');
    
    process.exit(0);
  }
}

// ============================================================================
// ЗАПУСК
// ============================================================================

if (require.main === module) {
  const bot = new BinanceLiquidationBot();
  bot.start().catch(error => {
    console.error('[FATAL]', error);
    process.exit(1);
  });
}

module.exports = { BinanceLiquidationBot };
