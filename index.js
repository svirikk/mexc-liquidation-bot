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
  // WebSocket - глобальний стрім всіх ліквідацій (фільтрація на рівні обробки)
  BINANCE_WS: 'wss://fstream.binance.com/ws/!forceOrder@arr',
  
  // Пороги алертів
  MIN_LIQUIDATION_USD: parseInt(process.env.MIN_LIQUIDATION_USD) || 1_000_000,
  MIN_DOMINANCE: parseFloat(process.env.MIN_DOMINANCE) || 65.0,
  
  // Додаткові фільтри агресії
  MIN_PRICE_CHANGE_PERCENT: parseFloat(process.env.MIN_PRICE_CHANGE_PERCENT) || 3.0,
  PRICE_CHANGE_WINDOW_SEC: parseInt(process.env.PRICE_CHANGE_WINDOW_SEC) || 180, // 3 хв
  
  AGGRESSIVE_VOLUME_USD: parseInt(process.env.AGGRESSIVE_VOLUME_USD) || 1_000_000,
  AGGRESSIVE_VOLUME_WINDOW_SEC: parseInt(process.env.AGGRESSIVE_VOLUME_WINDOW_SEC) || 300, // 5 хв
  
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
        startTime: Date.now(),
        startPrice: liquidation.price,
        lastPrice: liquidation.price
      });
    }

    const window = this.windows.get(symbol);
    window.liquidations.push(liquidation);
    window.lastPrice = liquidation.price; // Оновлюємо останню ціну
    
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

    // Розраховуємо зміну ціни
    const priceChange = ((window.lastPrice - window.startPrice) / window.startPrice) * 100;

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
      timestamp: now,
      startPrice: window.startPrice,
      lastPrice: window.lastPrice,
      priceChange
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
// ДЕТЕКТОР СИГНАЛІВ (з агресивними фільтрами)
// ============================================================================

class SignalDetector {
  shouldAlert(stats) {
    if (!stats) return false;

    // Базова перевірка мінімального об'єму
    if (stats.totalVolumeUSD < CONFIG.MIN_LIQUIDATION_USD) {
      return false;
    }

    // Базова перевірка домінування
    if (stats.dominance < CONFIG.MIN_DOMINANCE) {
      return false;
    }

    // НОВИЙ ФІЛЬТР 1: Перевірка різкої зміни ціни
    // Ціна має змінитись на мінімум MIN_PRICE_CHANGE_PERCENT%
    if (Math.abs(stats.priceChange) < CONFIG.MIN_PRICE_CHANGE_PERCENT) {
      return false;
    }

    // НОВИЙ ФІЛЬТР 2: Перевірка агресивного об'єму
    // Об'єм має досягти AGGRESSIVE_VOLUME_USD за період
    if (stats.totalVolumeUSD < CONFIG.AGGRESSIVE_VOLUME_USD) {
      return false;
    }

    // Додаткова валідація: напрямок ціни має відповідати домінуванню
    // Якщо LONG ліквідується (SHORT домінує), ціна має падати
    // Якщо SHORT ліквідується (LONG домінує), ціна має рости
    if (stats.dominantSide === 'SHORT' && stats.priceChange > 0) {
      return false; // SHORT домінує але ціна росте - невідповідність
    }
    if (stats.dominantSide === 'LONG' && stats.priceChange < 0) {
      return false; // LONG домінує але ціна падає - невідповідність
    }

    return true;
  }

  getSignature(stats) {
    return `${stats.symbol}:${stats.dominantSide}:${Math.floor(stats.totalVolumeUSD / 100000)}`;
  }

  // Інтерпретація для логів
  interpretSignal(stats) {
    if (stats.dominantSide === 'SHORT') {
      return {
        liquidatedSide: 'ЛОНГІВ',
        emoji: '🌊',
        reason: 'падіння ціни'
      };
    } else {
      return {
        liquidatedSide: 'ШОРТІВ', 
        emoji: '🔥',
        reason: 'зростання ціни'
      };
    }
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
    
    const emoji = stats.dominantSide === 'LONG' ? '🔥' : '🌊';
    const sideText = stats.dominantSide === 'LONG' ? 'ШОРТІВ' : 'ЛОНГІВ';
    lines.push(`${emoji} ЛИКВИДАЦИЯ ${sideText}`);
    
    const volumeStr = this.formatVolume(stats.totalVolumeUSD);
    const durationStr = this.formatDuration(stats.durationSec);
    lines.push(`Объем: ${volumeStr} (за ${durationStr})`);
    
    const dominanceText = stats.dominantSide === 'LONG' ? 'ЛОНГІВ' : 'ШОРТІВ';
    lines.push(`Доминирование: ${stats.dominance.toFixed(1)}% ${dominanceText}`);
    
    lines.push('————————————————————');
    
    const cleanSymbol = stats.symbol.replace('USDT', '');
    lines.push(`🔥 ${stats.symbol} #${cleanSymbol}`);
    
    // НОВЕ: Додаємо зміну ціни
    const priceChangeSign = stats.priceChange >= 0 ? '+' : '';
    const priceEmoji = stats.priceChange >= 0 ? '📈' : '📉';
    lines.push(`${priceEmoji} Зміна ціни: ${priceChangeSign}${stats.priceChange.toFixed(2)}%`);
    
    const windowMin = Math.floor(stats.durationSec / 60);
    lines.push(`⏱️ Окно: ${windowMin} мин`);
    
    lines.push(`📊 Кол-во ликвидаций: ${stats.count}`);
    
    // НОВЕ: Розбивка об'єму
    lines.push(`💥 Агресивний об'єм:`);
    lines.push(`   🟢 LONG: ${this.formatVolume(stats.longVolumeUSD)}`);
    lines.push(`   🔴 SHORT: ${this.formatVolume(stats.shortVolumeUSD)}`);
    
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
    this.processedCount = 0;
    this.filteredCount = 0;
  }

  connect() {
    console.log('[WS] Підключення до Binance Futures (глобальний стрім)...');
    
    this.ws = new WebSocket(CONFIG.BINANCE_WS);

    this.ws.on('open', () => {
      const validCount = this.tokenFilter.getValidTokens().length;
      console.log('[WS] ✅ Підключено до глобального стріму');
      console.log(`[WS] 🎯 Фільтрація на рівні обробки (${validCount} валідних токенів)`);
      this.isConnected = true;
      this.reconnectAttempts = 0;
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
      
      // Binance надсилає об'єкт з полем "o" (order)
      if (!message.o) return;

      const order = message.o;
      const symbol = order.s;
      
      this.processedCount++;
      
      // КРИТИЧНО: Фільтрація по MCAP перед обробкою
      if (!this.tokenFilter.isValid(symbol)) {
        this.filteredCount++;
        return;
      }
      
      const side = order.S === 'BUY' ? 'SHORT' : 'LONG';
      const price = parseFloat(order.p);
      const quantity = parseFloat(order.q);
      const volumeUSD = price * quantity;

      // Додаємо в агрегатор (тільки валідні токени)
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

  getStats() {
    return {
      processed: this.processedCount,
      filtered: this.filteredCount,
      filterRate: this.processedCount > 0 
        ? ((this.filteredCount / this.processedCount) * 100).toFixed(1)
        : '0.0'
    };
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
    this.statsInterval = null;
  }

  start(wsManager) {
    console.log(`[ENGINE] Запуск перевірки кожні ${CONFIG.CHECK_INTERVAL_SEC}с`);
    
    this.checkInterval = setInterval(() => {
      this.checkAllWindows();
    }, CONFIG.CHECK_INTERVAL_SEC * 1000);

    // Статистика фільтрації кожну хвилину
    this.statsInterval = setInterval(() => {
      if (wsManager) {
        const stats = wsManager.getStats();
        console.log(`[STATS] Оброблено: ${stats.processed} | Відфільтровано: ${stats.filtered} (${stats.filterRate}%)`);
      }
    }, 60000);
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
      
      const interpretation = this.detector.interpretSignal(stats);
      console.log(`[🚨 ALERT] ${symbol} | ${interpretation.liquidatedSide} | ${(stats.totalVolumeUSD / 1e6).toFixed(2)}M | ${stats.dominance.toFixed(1)}% | Δ${stats.priceChange >= 0 ? '+' : ''}${stats.priceChange.toFixed(2)}%`);
      
      this.aggregator.reset(symbol);
      
    } catch (error) {
      console.error(`[ERROR] Помилка відправки алерту ${symbol}:`, error.message);
    }
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
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
    // Оновлення фільтра не потребує переподписки (фільтрація на рівні обробки)
    // Просто логуємо коли список оновлено
  }

  async start() {
    console.log('='.repeat(70));
    console.log('BINANCE FUTURES LIQUIDATION ALERT BOT');
    console.log('🎯 Глобальний стрім → Фільтрація по MCAP + Агресія');
    console.log('='.repeat(70));
    console.log(`Мін об'єм: ${(CONFIG.MIN_LIQUIDATION_USD / 1e6).toFixed(1)}M`);
    console.log(`Мін домінування: ${CONFIG.MIN_DOMINANCE}%`);
    console.log(`Агресивний об'єм: ${(CONFIG.AGGRESSIVE_VOLUME_USD / 1e6).toFixed(1)}M за ${CONFIG.AGGRESSIVE_VOLUME_WINDOW_SEC}с`);
    console.log(`Мін зміна ціни: ${CONFIG.MIN_PRICE_CHANGE_PERCENT}% за ${CONFIG.PRICE_CHANGE_WINDOW_SEC}с`);
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
        `✅ Мін об\'єм: ${(CONFIG.MIN_LIQUIDATION_USD / 1e6).toFixed(1)}M\n` +
        `✅ Мін домінування: ${CONFIG.MIN_DOMINANCE}%\n` +
        `🔥 Агресивний об\'єм: ${(CONFIG.AGGRESSIVE_VOLUME_USD / 1e6).toFixed(1)}M\n` +
        `📈 Мін зміна ціни: ${CONFIG.MIN_PRICE_CHANGE_PERCENT}%`
      );
      console.log('[TELEGRAM] ✅ Підключено\n');
    } catch (error) {
      console.error('[TELEGRAM] ❌ Помилка:', error.message);
      process.exit(1);
    }

    // Запуск WebSocket (глобальний стрім)
    this.wsManager.connect();

    // Запуск движка алертів
    this.alertEngine.start(this.wsManager);

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
