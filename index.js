// ============================================================================
// BINANCE FUTURES LIQUIDATION ALERT BOT
// Моніторинг масових ліквідацій для reversal-трейдингу
// Глобальний стрім → Фільтрація по MCAP + Зміна ціни + Агресивний об'єм
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
  // WebSocket - глобальний стрім всіх ліквідацій
  BINANCE_WS: 'wss://fstream.binance.com/ws/!forceOrder@arr',
  
  // Пороги алертів
  MIN_LIQUIDATION_USD: parseInt(process.env.MIN_LIQUIDATION_USD) || 1_000_000,
  MIN_DOMINANCE: parseFloat(process.env.MIN_DOMINANCE) || 65.0,
  
  // Додаткові фільтри агресії
  MIN_PRICE_CHANGE_PERCENT: parseFloat(process.env.MIN_PRICE_CHANGE_PERCENT) || 3.0,
  AGGRESSIVE_VOLUME_USD: parseInt(process.env.AGGRESSIVE_VOLUME_USD) || 1_000_000,
  AGGRESSIVE_VOLUME_WINDOW_SEC: parseInt(process.env.AGGRESSIVE_VOLUME_WINDOW_SEC) || 300, // 5 хв
  
  // Часове вікно агрегації ліквідацій (секунди)
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
// PRICE TRACKER (відстеження зміни ціни)
// ============================================================================

class PriceTracker {
  constructor(windowSeconds) {
    this.prices = new Map(); // symbol -> [{price, timestamp}]
    this.windowMs = windowSeconds * 1000;
  }

  addPrice(symbol, price) {
    if (!this.prices.has(symbol)) {
      this.prices.set(symbol, []);
    }

    const priceHistory = this.prices.get(symbol);
    priceHistory.push({
      price,
      timestamp: Date.now()
    });

    this.cleanup(symbol);
  }

  cleanup(symbol) {
    if (!this.prices.has(symbol)) return;

    const now = Date.now();
    const priceHistory = this.prices.get(symbol);
    
    const filtered = priceHistory.filter(p => now - p.timestamp < this.windowMs);

    if (filtered.length === 0) {
      this.prices.delete(symbol);
    } else {
      this.prices.set(symbol, filtered);
    }
  }

  getPriceChange(symbol) {
    if (!this.prices.has(symbol)) return null;

    const priceHistory = this.prices.get(symbol);
    if (priceHistory.length < 2) return null;

    const oldest = priceHistory[0].price;
    const newest = priceHistory[priceHistory.length - 1].price;
    
    const changePercent = ((newest - oldest) / oldest) * 100;
    const duration = (priceHistory[priceHistory.length - 1].timestamp - priceHistory[0].timestamp) / 1000;

    return {
      changePercent,
      duration,
      oldPrice: oldest,
      newPrice: newest,
      dataPoints: priceHistory.length
    };
  }

  reset(symbol) {
    this.prices.delete(symbol);
  }
}

// ============================================================================
// АГРЕГАТОР ЛІКВІДАЦІЙ (з відстеженням ціни та агресивного об'єму)
// ============================================================================

class LiquidationAggregator {
  constructor(windowSeconds, priceTracker) {
    this.windows = new Map();
    this.windowMs = windowSeconds * 1000;
    this.priceTracker = priceTracker;
    
    // Окреме вікно для агресивного об'єму (довше ніж основне)
    this.aggressiveWindowMs = CONFIG.AGGRESSIVE_VOLUME_WINDOW_SEC * 1000;
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
    
    // Додаємо ціну в price tracker
    this.priceTracker.addPrice(symbol, liquidation.price);
    
    this.cleanup(symbol);
  }

  cleanup(symbol) {
    if (!this.windows.has(symbol)) return;

    const window = this.windows.get(symbol);
    const now = Date.now();
    
    // Очищаємо за ДОВШИМ вікном (для агресивного об'єму)
    window.liquidations = window.liquidations.filter(
      liq => now - liq.timestamp < this.aggressiveWindowMs
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

    const now = Date.now();
    
    // Рахуємо об'єми для ОСНОВНОГО вікна (AGGREGATION_WINDOW_SEC)
    let longVolumeUSD = 0;
    let shortVolumeUSD = 0;
    let mainWindowCount = 0;

    for (const liq of window.liquidations) {
      if (now - liq.timestamp < this.windowMs) {
        if (liq.side === 'LONG') {
          longVolumeUSD += liq.volumeUSD;
        } else {
          shortVolumeUSD += liq.volumeUSD;
        }
        mainWindowCount++;
      }
    }

    const totalVolumeUSD = longVolumeUSD + shortVolumeUSD;
    if (totalVolumeUSD === 0) return null;

    const longDominance = (longVolumeUSD / totalVolumeUSD) * 100;
    const shortDominance = (shortVolumeUSD / totalVolumeUSD) * 100;
    
    const dominantSide = longVolumeUSD > shortVolumeUSD ? 'LONG' : 'SHORT';
    const dominance = Math.max(longDominance, shortDominance);

    const durationSec = (now - window.startTime) / 1000;

    // Отримуємо зміну ціни
    const priceChange = this.priceTracker.getPriceChange(symbol);

    // НОВЕ: Рахуємо агресивний об'єм домінуючої сторони
    // За ДОВШИМ вікном (AGGRESSIVE_VOLUME_WINDOW_SEC)
    let aggressiveLongVolume = 0;
    let aggressiveShortVolume = 0;

    for (const liq of window.liquidations) {
      // Всі ліквідації (вже відфільтровані за aggressiveWindowMs)
      if (liq.side === 'LONG') {
        aggressiveLongVolume += liq.volumeUSD;
      } else {
        aggressiveShortVolume += liq.volumeUSD;
      }
    }

    const aggressiveDominantVolume = dominantSide === 'LONG' 
      ? aggressiveLongVolume 
      : aggressiveShortVolume;

    return {
      symbol,
      longVolumeUSD,
      shortVolumeUSD,
      totalVolumeUSD,
      dominantSide,
      dominance,
      longDominance,
      shortDominance,
      count: mainWindowCount,
      durationSec,
      timestamp: now,
      priceChange,
      // НОВЕ: агресивний об'єм домінуючої сторони
      aggressiveDominantVolume,
      aggressiveLongVolume,
      aggressiveShortVolume
    };
  }

  getAllActiveSymbols() {
    return Array.from(this.windows.keys());
  }

  reset(symbol) {
    this.windows.delete(symbol);
    this.priceTracker.reset(symbol);
  }
}

// ============================================================================
// ДЕТЕКТОР СИГНАЛІВ (з усіма фільтрами)
// ============================================================================

class SignalDetector {
  shouldAlert(stats) {
    if (!stats) return false;

    // 1. Перевірка мінімального об'єму ліквідацій
    if (stats.totalVolumeUSD < CONFIG.MIN_LIQUIDATION_USD) {
      return false;
    }

    // 2. Перевірка домінування
    if (stats.dominance < CONFIG.MIN_DOMINANCE) {
      return false;
    }

    // 3. НОВИЙ ФІЛЬТР: Перевірка зміни ціни
    if (stats.priceChange) {
      const absChange = Math.abs(stats.priceChange.changePercent);
      
      if (absChange < CONFIG.MIN_PRICE_CHANGE_PERCENT) {
        return false;
      }

      // Напрямок зміни ціни має відповідати домінуванню:
      // LONG домінує (шорти ліквідуються) → ціна має рости
      // SHORT домінує (лонги ліквідуються) → ціна має падати
      if (stats.dominantSide === 'LONG' && stats.priceChange.changePercent < 0) {
        return false;
      }
      if (stats.dominantSide === 'SHORT' && stats.priceChange.changePercent > 0) {
        return false;
      }
    }

    // 4. НОВИЙ ФІЛЬТР: Перевірка агресивного об'єму домінуючої сторони
    // Об'єм домінуючої сторони за довше вікно має бути >= AGGRESSIVE_VOLUME_USD
    if (stats.aggressiveDominantVolume < CONFIG.AGGRESSIVE_VOLUME_USD) {
      return false;
    }

    return true;
  }

  getSignature(stats) {
    return `${stats.symbol}:${stats.dominantSide}:${Math.floor(stats.totalVolumeUSD / 100000)}`;
  }

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
    lines.push(`Объем: $${volumeStr} (за ${durationStr})`);
    
    const dominanceText = stats.dominantSide === 'LONG' ? 'ЛОНГІВ' : 'ШОРТІВ';
    lines.push(`Доминирование: ${stats.dominance.toFixed(1)}% ${dominanceText}`);
    
    lines.push('————————————————————');
    
    const cleanSymbol = stats.symbol.replace('USDT', '');
    lines.push(`🔥 ${stats.symbol} #${cleanSymbol}`);
    
    // Зміна ціни
    if (stats.priceChange) {
      const sign = stats.priceChange.changePercent >= 0 ? '+' : '';
      const priceEmoji = stats.priceChange.changePercent >= 0 ? '📈' : '📉';
      lines.push(`${priceEmoji} Зміна ціни: ${sign}${stats.priceChange.changePercent.toFixed(2)}%`);
    }
    
    const windowMin = Math.floor(stats.durationSec / 60);
    lines.push(`⏱️ Окно: ${windowMin} мин`);
    
    lines.push(`📊 Кол-во ликвидаций: ${stats.count}`);
    
    // НОВЕ: Агресивний об'єм по сторонах
    lines.push(`💥 Агресивний об'єм (${CONFIG.AGGRESSIVE_VOLUME_WINDOW_SEC / 60}хв):`);
    lines.push(`   🟢 LONG: $${this.formatVolume(stats.aggressiveLongVolume)}`);
    lines.push(`   🔴 SHORT: $${this.formatVolume(stats.aggressiveShortVolume)}`);
    
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
// WEBSOCKET МЕНЕДЖЕР (глобальний стрім всіх ліквідацій)
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

      // DEBUG: Логуємо вікна що мають значний об'єм
      if (stats.totalVolumeUSD >= CONFIG.MIN_LIQUIDATION_USD * 0.3) {
        const domSide = stats.dominantSide === 'LONG' ? '🟢' : '🔴';
        const priceInfo = stats.priceChange ? ` | Δ${stats.priceChange.changePercent >= 0 ? '+' : ''}${stats.priceChange.changePercent.toFixed(2)}%` : '';
        console.log(`[DEBUG] ${symbol.padEnd(12)} | ${domSide} $${(stats.totalVolumeUSD / 1000).toFixed(0)}K | Dom: ${stats.dominance.toFixed(0)}%${priceInfo} | Aggr: $${(stats.aggressiveDominantVolume / 1000).toFixed(0)}K`);
      }

      if (!this.detector.shouldAlert(stats)) {
        // DEBUG: Чому не пройшов
        if (stats.totalVolumeUSD >= CONFIG.MIN_LIQUIDATION_USD * 0.5) {
          const reasons = [];
          if (stats.totalVolumeUSD < CONFIG.MIN_LIQUIDATION_USD) reasons.push(`vol<${CONFIG.MIN_LIQUIDATION_USD / 1e6}M`);
          if (stats.dominance < CONFIG.MIN_DOMINANCE) reasons.push(`dom<${CONFIG.MIN_DOMINANCE}%`);
          if (stats.priceChange && Math.abs(stats.priceChange.changePercent) < CONFIG.MIN_PRICE_CHANGE_PERCENT) {
            reasons.push(`price<${CONFIG.MIN_PRICE_CHANGE_PERCENT}%`);
          }
          if (stats.aggressiveDominantVolume < CONFIG.AGGRESSIVE_VOLUME_USD) {
            reasons.push(`aggr<${CONFIG.AGGRESSIVE_VOLUME_USD / 1e6}M`);
          }
          if (reasons.length > 0) {
            console.log(`[SKIP] ${symbol} - ${reasons.join(', ')}`);
          }
        }
        continue;
      }

      const signature = this.detector.getSignature(stats);
      if (!this.cooldownManager.canAlert(symbol, stats, signature)) {
        console.log(`[COOLDOWN] ${symbol} - в cooldown`);
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
      const priceInfo = stats.priceChange ? ` | Δ${stats.priceChange.changePercent >= 0 ? '+' : ''}${stats.priceChange.changePercent.toFixed(2)}%` : '';
      
      console.log(`[🚨 ALERT] ${symbol} | ${interpretation.liquidatedSide} | $${(stats.totalVolumeUSD / 1e6).toFixed(2)}M | ${stats.dominance.toFixed(1)}%${priceInfo} | Aggr: $${(stats.aggressiveDominantVolume / 1e6).toFixed(2)}M`);
      
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
    this.priceTracker = new PriceTracker(CONFIG.AGGREGATION_WINDOW_SEC);
    this.aggregator = new LiquidationAggregator(
      CONFIG.AGGREGATION_WINDOW_SEC,
      this.priceTracker
    );
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
    console.log('🎯 Глобальний стрім → Фільтрація по MCAP + Ціна + Агресія');
    console.log('='.repeat(70));
    console.log(`Мін об'єм: $${(CONFIG.MIN_LIQUIDATION_USD / 1e6).toFixed(1)}M`);
    console.log(`Мін домінування: ${CONFIG.MIN_DOMINANCE}%`);
    console.log(`Мін зміна ціни: ${CONFIG.MIN_PRICE_CHANGE_PERCENT}%`);
    console.log(`Агресивний об'єм: $${(CONFIG.AGGRESSIVE_VOLUME_USD / 1e6).toFixed(1)}M за ${CONFIG.AGGRESSIVE_VOLUME_WINDOW_SEC / 60}хв`);
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

    const stats = this.tokenFilter