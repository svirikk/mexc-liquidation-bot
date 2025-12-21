// ============================================================================
// BYBIT AGGRESSIVE VOLUME ALERT BOT
// Відстежування примусових ринкових рухів через агресивний об'єм
// ============================================================================
// 
// ⚠️ ЧОМУ НЕ ВИКОРИСТОВУЄМО LIQUIDATION STREAMS:
// 1. Більшість бірж не надають публічні liquidation events в реальному часі
// 2. Liquidation streams часто затримуються або неповні
// 3. Насправді важливі не самі ліквідації, а ТИХ НАСЛІДОК - агресивні угоди
// 4. Аналізуючи publicTrade ми бачимо РЕАЛЬНИЙ тиск на ринок
// 
// ✅ ЩО МИ РОБИМО:
// - Слухаємо публічні угоди (publicTrade)
// - Агрегуємо об'єми купівлі/продажу в часовому вікні
// - Визначаємо домінування однієї сторони
// - Підтверджуємо ціновим імпульсом
// - Інтерпретуємо це як "примусову ліквідацію"
//
// 📊 ПРО ЧАС У ВІКНІ (чому завжди ~300 секунд?):
// - Це НОРМАЛЬНО! Вікно агрегації = 300с (5 хв) або ваше налаштування
// - Бот чекає поки накопичиться достатній об'єм ($1M+)
// - Це зазвичай займає ВЕСЬ період вікна
// - Якщо хочете швидші алерти → зменшіть AGGREGATION_WINDOW_SECONDS до 60-120с
// - Але менше вікно = менше накопичується об'єм = менше якісних сигналів
// - Рекомендовано: 120-300 секунд для балансу швидкості та якості
//
// 🔇 КОНТРОЛЬ ЛОГУВАННЯ (Railway 500 logs/sec limit):
// - За замовчуванням: тільки важливі події (алерти, помилки, система)
// - SILENT_MODE=true → тільки алерти та помилки
// - LOG_PROGRESS=false → без прогресу накопичення
// - DEBUG_MODE=true → всі деталі (використовувати тільки для розробки!)
// ============================================================================

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ============================================================================
// КОНФІГУРАЦІЯ
// ============================================================================

const CONFIG = {
  // Пороги для алертів
  MIN_VOLUME_USD: parseInt(process.env.MIN_VOLUME_USD) || 500_000,        // Мін об'єм для алерту
  MIN_DOMINANCE: parseFloat(process.env.MIN_DOMINANCE) || 65.0,           // Мін домінування (%)
  MIN_PRICE_CHANGE: parseFloat(process.env.MIN_PRICE_CHANGE) || 0.5,      // Мін зміна ціни (%)
  
  // Часові вікна
  AGGREGATION_WINDOW_SECONDS: parseInt(process.env.AGGREGATION_WINDOW_SECONDS) || 180, // 3 хвилини
  COOLDOWN_MINUTES: parseInt(process.env.COOLDOWN_MINUTES) || 20,
  
  // Обмеження частоти алертів
  MAX_ALERTS_PER_MINUTE: parseInt(process.env.MAX_ALERTS_PER_MINUTE) || 5, // Максимум алертів за хвилину
  
  // Режим логування
  DEBUG_MODE: process.env.DEBUG_MODE === 'true',              // Детальні логи (для розробки)
  SILENT_MODE: process.env.SILENT_MODE === 'true',            // Тільки алерти та помилки
  LOG_PROGRESS: process.env.LOG_PROGRESS !== 'false',         // Логувати прогрес накопичення
  
  // Фільтри символів
  MIN_OPEN_INTEREST: parseInt(process.env.MIN_OPEN_INTEREST) || 10_000_000,
  MAX_OPEN_INTEREST: parseInt(process.env.MAX_OPEN_INTEREST) || 100_000_000,
  MIN_VOLUME_24H: parseInt(process.env.MIN_VOLUME_24H) || 5_000_000,
  
  // Режим відлагодження (моніторить всі символи)
  MONITOR_ALL_SYMBOLS: process.env.MONITOR_ALL_SYMBOLS === 'true',
  
  // Оновлення ринкових даних
  REFRESH_MARKETS_HOURS: parseInt(process.env.REFRESH_MARKETS_HOURS) || 2,
  
  // API ендпоінти
  BYBIT_WS_PUBLIC: 'wss://stream.bybit.com/v5/public/linear',
  BYBIT_REST_API: 'https://api.bybit.com',
  
  // Telegram
  TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
};

// ============================================================================
// МЕНЕДЖЕР РИНКОВИХ ДАНИХ
// ============================================================================

class MarketDataManager {
  constructor() {
    this.markets = new Map(); // symbol -> { oi, price, volume24h, lastUpdate }
    this.eligibleSymbols = new Set();
  }

  async fetchAllMarkets() {
    Logger.system('[API] 📊 Завантаження ринкових даних з Bybit...');
    
    try {
      const tickersRes = await axios.get(`${CONFIG.BYBIT_REST_API}/v5/market/tickers`, {
        params: { category: 'linear' },
        headers: {
          'User-Agent': 'Mozilla/5.0',
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
        
        // Тільки USDT пари
        if (!symbol.endsWith('USDT')) continue;

        const price = parseFloat(ticker.lastPrice) || 0;
        const volume24h = parseFloat(ticker.turnover24h) || 0;
        const oi = parseFloat(ticker.openInterest) || 0;
        const oiValue = oi * price;

        allSymbols.push({ symbol, oiValue, volume24h, price });

        this.markets.set(symbol, {
          oi: oiValue,
          price,
          volume24h,
          lastUpdate: Date.now()
        });

        // Перевірка придатності
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

      Logger.system(`[API] ✅ Всього ринків: ${tickers.length}`);
      Logger.system(`[API] 🎯 Відібрано символів: ${eligibleCount}`);
      
      if (CONFIG.MONITOR_ALL_SYMBOLS) {
        Logger.system(`[API] 🔥 РЕЖИМ ВІДЛАГОДЖЕННЯ: Моніторинг ВСІХ символів`);
      } else {
        Logger.info(`[API] 📋 Фільтри:`);
        Logger.info(`      - OI: ${(CONFIG.MIN_OPEN_INTEREST / 1e6).toFixed(1)}M - ${(CONFIG.MAX_OPEN_INTEREST / 1e6).toFixed(1)}M`);
        Logger.info(`      - Мін 24h обсяг: ${(CONFIG.MIN_VOLUME_24H / 1e6).toFixed(1)}M`);
      }

      if (eligibleCount === 0) {
        Logger.system(`\n[API] ⚠️ Жоден символ не відповідає критеріям. Топ-10 за OI:`);
        allSymbols
          .sort((a, b) => b.oiValue - a.oiValue)
          .slice(0, 10)
          .forEach((s, i) => {
            Logger.info(`      ${(i + 1).toString().padStart(2)}. ${s.symbol.padEnd(12)} | OI: ${(s.oiValue / 1e6).toFixed(1)}M`);
          });
      }
      Logger.info('');

      return Array.from(this.eligibleSymbols);
    } catch (error) {
      Logger.error('[API] ❌ Помилка завантаження: ' + error.message);
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
}

// ============================================================================
// АГРЕГАТОР УГОД (Trade Aggregator)
// ============================================================================
// Це серце системи: збирає угоди в часовому вікні та рахує домінування

class TradeAggregator {
  constructor() {
    this.windows = new Map(); // symbol -> { trades: [], startPrice, lastPrice, startTime }
    this.alertedSymbols = new Set(); // 🔥 ОКРЕМИЙ SET для відстежування алертів
    this.lastAlertTime = new Map(); // symbol -> timestamp останнього алерту
  }

  addTrade(symbol, trade) {
    if (!this.windows.has(symbol)) {
      this.windows.set(symbol, {
        trades: [],
        startPrice: trade.price,
        lastPrice: trade.price,
        startTime: trade.timestamp
      });
    }

    const window = this.windows.get(symbol);
    window.trades.push(trade);
    window.lastPrice = trade.price;

    // Видаляємо старі угоди
    this.cleanup(symbol);
  }

  hasAlerted(symbol) {
    return this.alertedSymbols.has(symbol);
  }

  markAsAlerted(symbol) {
    this.alertedSymbols.add(symbol);
    this.lastAlertTime.set(symbol, Date.now());
    Logger.debug(`${symbol} - заблоковано від дублікатів на 30 секунд`);
  }

  cleanup(symbol) {
    const now = Date.now();
    const windowMs = CONFIG.AGGREGATION_WINDOW_SECONDS * 1000;

    if (!this.windows.has(symbol)) return;

    const window = this.windows.get(symbol);
    const filtered = window.trades.filter(t => now - t.timestamp < windowMs);

    if (filtered.length === 0) {
      // Якщо вікно порожнє - видаляємо все
      this.windows.delete(symbol);
      // Але НЕ видаляємо з alertedSymbols! Це зробить окремий таймер
    } else {
      // Оновлюємо вікно
      window.trades = filtered;
      window.startTime = filtered[0].timestamp;
      window.startPrice = filtered[0].price;
    }

    // Очищаємо старі блокування (через 30 секунд після алерту)
    if (this.alertedSymbols.has(symbol)) {
      const lastAlert = this.lastAlertTime.get(symbol);
      if (lastAlert && (now - lastAlert > 30000)) {
        this.alertedSymbols.delete(symbol);
        this.lastAlertTime.delete(symbol);
        Logger.debug(`${symbol} - розблоковано, готовий до нових алертів`);
      }
    }
  }

  getWindowStats(symbol) {
    if (!this.windows.has(symbol)) return null;

    const window = this.windows.get(symbol);
    if (window.trades.length === 0) return null;

    let buyVolumeUSD = 0;
    let sellVolumeUSD = 0;

    // Агрегуємо об'єми
    for (const trade of window.trades) {
      if (trade.side === 'Buy') {
        buyVolumeUSD += trade.valueUSD;
      } else {
        sellVolumeUSD += trade.valueUSD;
      }
    }

    const totalVolumeUSD = buyVolumeUSD + sellVolumeUSD;
    if (totalVolumeUSD === 0) return null;

    // Рахуємо домінування
    const buyDominance = (buyVolumeUSD / totalVolumeUSD) * 100;
    const sellDominance = (sellVolumeUSD / totalVolumeUSD) * 100;
    
    const dominantSide = buyVolumeUSD > sellVolumeUSD ? 'buy' : 'sell';
    const dominance = Math.max(buyDominance, sellDominance);

    // Зміна ціни
    const priceChange = ((window.lastPrice - window.startPrice) / window.startPrice) * 100;

    // Тривалість
    const now = Date.now();
    const duration = (now - window.startTime) / 1000;

    return {
      buyVolumeUSD,
      sellVolumeUSD,
      totalVolumeUSD,
      dominantSide,
      dominance,
      buyDominance,
      sellDominance,
      priceChange,
      duration,
      tradeCount: window.trades.length,
      startPrice: window.startPrice,
      lastPrice: window.lastPrice
    };
  }

  reset(symbol) {
    this.windows.delete(symbol);
    // alertedSymbols очищається автоматично через 30 секунд у cleanup()
  }
}

// ============================================================================
// ДЕТЕКТОР СИГНАЛІВ
// ============================================================================
// Перевіряє чи виконані умови для алерту

class SignalDetector {
  shouldAlert(stats) {
    if (!stats) return false;

    // Перевірка мінімального об'єму
    if (stats.totalVolumeUSD < CONFIG.MIN_VOLUME_USD) {
      return false;
    }

    // Перевірка домінування
    if (stats.dominance < CONFIG.MIN_DOMINANCE) {
      return false;
    }

    // Перевірка зміни ціни (абсолютне значення)
    if (Math.abs(stats.priceChange) < CONFIG.MIN_PRICE_CHANGE) {
      return false;
    }

    // Додаткова перевірка: зміна ціни має відповідати напрямку домінування
    // Якщо купівля домінує, ціна має рости (і навпаки)
    if (stats.dominantSide === 'buy' && stats.priceChange < 0) {
      return false;
    }
    if (stats.dominantSide === 'sell' && stats.priceChange > 0) {
      return false;
    }

    return true;
  }

  interpretSignal(stats) {
    // BUY домінує = шорти ліквідуються (примусова купівля)
    // SELL домінує = лонги ліквідуються (примусовий продаж)
    
    if (stats.dominantSide === 'buy') {
      return {
        type: 'ШОРТІВ',
        emoji: '🔥',
        direction: 'купівля'
      };
    } else {
      return {
        type: 'ЛОНГІВ',
        emoji: '🌊',
        direction: 'продаж'
      };
    }
  }
}

// ============================================================================
// МЕНЕДЖЕР COOLDOWN
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
      // Дозволяємо новий алерт якщо об'єм значно більший або інша сторона
      const volumeIncrease = stats.totalVolumeUSD / lastAlert.volume;
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
      volume: stats.totalVolumeUSD,
      side: stats.dominantSide
    });
  }
}

// ============================================================================
// ФОРМАТЕР АЛЕРТІВ
// ============================================================================

class AlertFormatter {
  format(symbol, stats, interpretation, marketData) {
    const lines = [];
    
    lines.push(`${interpretation.emoji} ЛІКВІДАЦІЯ ${interpretation.type}`);
    lines.push(`Об'єм: $${this.formatNumber(stats.totalVolumeUSD)} (${this.formatDuration(stats.duration)})`);
    lines.push(`Домінування: ${stats.dominance.toFixed(1)}% ${interpretation.direction.toUpperCase()}`);
    lines.push('—————————————————');
    
    const cleanSymbol = symbol.replace('USDT', '');
    lines.push(`🔥 ${symbol} #${cleanSymbol}`);
    
    const priceChangeSign = stats.priceChange >= 0 ? '+' : '';
    lines.push(`⏱ Зміна ціни: ${priceChangeSign}${stats.priceChange.toFixed(2)}%`);
    
    lines.push('💥 Агресивний об\'єм:');
    lines.push(`🟢 Купівля: $${this.formatNumber(stats.buyVolumeUSD)}`);
    lines.push(`🔴 Продаж: $${this.formatNumber(stats.sellVolumeUSD)}`);
    
    if (marketData) {
      lines.push('—————————————————');
      lines.push(`💸 OI: $${this.formatNumber(marketData.oi)}`);
      lines.push(`📊 Поточна ціна: $${marketData.price.toFixed(4)}`);
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
    return `${mins}хв ${secs}с`;
  }
}

// ============================================================================
// ДВИЖОК АЛЕРТІВ
// ============================================================================

class AlertEngine {
  constructor(telegram, cooldownManager, marketDataManager, signalDetector) {
    this.telegram = telegram;
    this.cooldownManager = cooldownManager;
    this.marketDataManager = marketDataManager;
    this.signalDetector = signalDetector;
    this.formatter = new AlertFormatter();
    this.recentAlerts = []; // Для обмеження кількості алертів
  }

  canSendAlert() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    // Очищаємо старі записи
    this.recentAlerts = this.recentAlerts.filter(t => t > oneMinuteAgo);
    
    // Перевіряємо ліміт
    if (this.recentAlerts.length >= CONFIG.MAX_ALERTS_PER_MINUTE) {
      Logger.debug(`Досягнуто максимум ${CONFIG.MAX_ALERTS_PER_MINUTE} алертів за хвилину`);
      return false;
    }
    
    return true;
  }

  recordAlertSent() {
    this.recentAlerts.push(Date.now());
  }

  async checkAndAlert(symbol, stats, tradeAggregator) {
    // 🔥 КРИТИЧНО: Перевіряємо чи вже відправили алерт для цього вікна
    if (tradeAggregator.hasAlerted(symbol)) {
      return; // Вже відправляли - пропускаємо
    }

    // Перевіряємо умови
    if (!this.signalDetector.shouldAlert(stats)) {
      return;
    }

    // Перевіряємо cooldown
    if (!this.cooldownManager.canAlert(symbol, stats)) {
      return;
    }

    // Отримуємо інтерпретацію
    const interpretation = this.signalDetector.interpretSignal(stats);

    // Отримуємо ринкові дані
    const marketData = this.marketDataManager.getMarketData(symbol);

    // Форматуємо та відправляємо
    const message = this.formatter.format(symbol, stats, interpretation, marketData);
    
    try {
      await this.telegram.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message);
      
      // ✅ ВАЖЛИВО: Встановлюємо флаг ЩО ВІДПРАВИЛИ для цього вікна
      tradeAggregator.markAsAlerted(symbol);
      
      // Записуємо cooldown
      this.cooldownManager.recordAlert(symbol, stats);
      
      console.log(`[🚨 АЛЕРТ] ${symbol} - ${interpretation.type} - ${(stats.totalVolumeUSD / 1e6).toFixed(2)}M - ${stats.dominance.toFixed(1)}% - Δ${stats.priceChange.toFixed(2)}%`);
      
      // Скидаємо вікно через 10 секунд (дає час завершити поточну подію)
      setTimeout(() => {
        tradeAggregator.reset(symbol);
        console.log(`[RESET] ${symbol} - вікно очищено, готовий до нової події`);
      }, 10000);
      
    } catch (error) {
      console.error(`[ERROR] Помилка відправки алерту для ${symbol}:`, error.message);
    }
  }
}

// ============================================================================
// BYBIT WEBSOCKET (PUBLICТRADE)
// ============================================================================
// Слухаємо публічні угоди, а не ліквідації!

class BybitWebSocketListener {
  constructor(tradeAggregator, alertEngine, marketDataManager) {
    this.tradeAggregator = tradeAggregator;
    this.alertEngine = alertEngine;
    this.marketDataManager = marketDataManager;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.pingInterval = null;
    this.subscribedSymbols = new Set();
    this.lastLogTime = new Map(); // Для дебаунсу логів
  }

  async connect() {
    Logger.system('[WS] 🔌 Підключення до Bybit WebSocket...');
    
    this.ws = new WebSocket(CONFIG.BYBIT_WS_PUBLIC);

    this.ws.on('open', () => {
      Logger.system('[WS] ✅ Підключено успішно');
      this.reconnectAttempts = 0;
      this.startPingInterval();
      this.subscribeToTrades();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (error) => {
      Logger.error('[WS] Помилка: ' + error.message);
    });

    this.ws.on('close', () => {
      Logger.system('[WS] З\'єднання закрито');
      this.stopPingInterval();
      this.reconnect();
    });
  }

  subscribeToTrades() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const eligibleSymbols = this.marketDataManager.getEligibleSymbols();
    
    if (eligibleSymbols.length === 0) {
      Logger.system('[WS] ⚠️ Немає придатних символів для підписки');
      return;
    }

    Logger.system(`[WS] 📡 Підписка на ${eligibleSymbols.length} символів (publicTrade)...`);

    // Підписуємося батчами по 10
    const batchSize = 10;
    for (let i = 0; i < eligibleSymbols.length; i += batchSize) {
      const batch = eligibleSymbols.slice(i, i + batchSize);
      const topics = batch.map(symbol => `publicTrade.${symbol}`);
      
      this.ws.send(JSON.stringify({
        op: 'subscribe',
        args: topics
      }));

      batch.forEach(symbol => this.subscribedSymbols.add(symbol));
    }

    Logger.system(`[WS] ✅ Підписано на ${eligibleSymbols.length} символів`);
    
    if (CONFIG.DEBUG_MODE) {
      Logger.debug('Перші 15 символів:');
      eligibleSymbols.slice(0, 15).forEach(symbol => {
        const data = this.marketDataManager.getMarketData(symbol);
        if (data) {
          Logger.debug(`  ${symbol.padEnd(15)} | OI: ${(data.oi / 1e6).toFixed(1)}M`);
        }
      });
      if (eligibleSymbols.length > 15) {
        Logger.debug(`  ... та ще ${eligibleSymbols.length - 15}`);
      }
    }
    
    Logger.system(`\n[STATUS] 🎯 Моніторинг активний | Поріг: ${(CONFIG.MIN_VOLUME_USD / 1e6).toFixed(1)}M | ${CONFIG.MIN_DOMINANCE}% | ${CONFIG.MIN_PRICE_CHANGE}%`);
    if (CONFIG.SILENT_MODE) {
      Logger.system('[STATUS] 🔇 SILENT MODE - тільки алерти та помилки\n');
    } else if (!CONFIG.LOG_PROGRESS) {
      Logger.system('[STATUS] 🤫 Прогрес вимкнено - тільки алерти\n');
    } else {
      Logger.system('[STATUS] 📊 Логування прогресу увімкнено\n');
    }
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      
      // Pong
      if (message.op === 'pong') {
        return;
      }

      // Підтвердження підписки
      if (message.success === true) {
        return;
      }

      // Публічні угоди
      if (message.topic && message.topic.startsWith('publicTrade.')) {
        const symbol = message.topic.replace('publicTrade.', '');
        
        // Тільки придатні символи
        if (!this.marketDataManager.isEligible(symbol)) {
          return;
        }

        // Обробляємо кожну угоду в масиві data
        const trades = Array.isArray(message.data) ? message.data : [message.data];
        
        for (const rawTrade of trades) {
          const price = parseFloat(rawTrade.p);
          const size = parseFloat(rawTrade.v);
          const side = rawTrade.S; // 'Buy' або 'Sell'
          const timestamp = parseInt(rawTrade.T);
          const valueUSD = price * size;

          const trade = {
            price,
            size,
            side,
            timestamp,
            valueUSD
          };

          // Додаємо угоду в агрегатор
          this.tradeAggregator.addTrade(symbol, trade);

          // Логуємо тільки дуже великі угоди (>$100K)
          if (valueUSD >= 100000) {
            const sideEmoji = side === 'Buy' ? '🟢' : '🔴';
            console.log(`[TRADE] ${symbol.padEnd(12)} | ${sideEmoji} ${side.padEnd(4)} | ${(valueUSD / 1000).toFixed(1)}K @ ${price.toFixed(4)}`);
          }

          // Перевіряємо статистику вікна
          const stats = this.tradeAggregator.getWindowStats(symbol);
          if (stats && stats.totalVolumeUSD >= CONFIG.MIN_VOLUME_USD * 0.5) {
            // Логуємо прогрес
            const domType = stats.dominantSide === 'buy' ? '🟢 BUY' : '🔴 SELL';
            console.log(`[WINDOW] ${symbol.padEnd(12)} | Всього: $${(stats.totalVolumeUSD / 1000).toFixed(1)}K | ${domType} ${stats.dominance.toFixed(1)}% | Ціна: ${stats.priceChange >= 0 ? '+' : ''}${stats.priceChange.toFixed(2)}% | ${stats.duration.toFixed(0)}с`);
            
            // Перевіряємо чи готові до алерту
            this.alertEngine.checkAndAlert(symbol, stats, this.tradeAggregator);
          }
        }
      }
      
    } catch (error) {
      console.error('[ERROR] Помилка обробки повідомлення:', error.message);
    }
  }

  startPingInterval() {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, 20000);
  }

  stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Досягнуто максимум спроб переподключення');
      return;
    }

    this.reconnectAttempts++;
    console.log(`[WS] Переподключення через ${this.reconnectDelay / 1000}с... (спроба ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
  }

  async resubscribe() {
    console.log('[WS] Оновлення підписок...');
    this.subscribedSymbols.clear();
    
    await this.marketDataManager.fetchAllMarkets();
    this.subscribeToTrades();
  }

  close() {
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close();
    }
  }
}

// ============================================================================
// ГОЛОВНИЙ ДОДАТОК
// ============================================================================

class AggressiveVolumeBot {
  constructor() {
    this.telegram = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });
    this.marketDataManager = new MarketDataManager();
    this.tradeAggregator = new TradeAggregator();
    this.signalDetector = new SignalDetector();
    this.cooldownManager = new CooldownManager(CONFIG.COOLDOWN_MINUTES);
    this.alertEngine = new AlertEngine(
      this.telegram,
      this.cooldownManager,
      this.marketDataManager,
      this.signalDetector
    );
    this.wsListener = new BybitWebSocketListener(
      this.tradeAggregator,
      this.alertEngine,
      this.marketDataManager
    );
    this.refreshInterval = null;
  }

  async start() {
    console.log('='.repeat(60));
    console.log('BYBIT AGGRESSIVE VOLUME ALERT BOT');
    console.log('Відстеження примусових рухів через агресивні угоди');
    console.log('='.repeat(60));
    console.log(`Мін об'єм для алерту: $${(CONFIG.MIN_VOLUME_USD / 1e6).toFixed(1)}M`);
    console.log(`Мін домінування: ${CONFIG.MIN_DOMINANCE}%`);
    console.log(`Мін зміна ціни: ${CONFIG.MIN_PRICE_CHANGE}%`);
    console.log(`Вікно агрегації: ${CONFIG.AGGREGATION_WINDOW_SECONDS}с`);
    console.log(`OI діапазон: $${(CONFIG.MIN_OPEN_INTEREST / 1e6).toFixed(1)}M - $${(CONFIG.MAX_OPEN_INTEREST / 1e6).toFixed(1)}M`);
    console.log(`Min 24h обсяг: ${(CONFIG.MIN_VOLUME_24H / 1e6).toFixed(1)}M`);
    console.log(`Cooldown: ${CONFIG.COOLDOWN_MINUTES} хвилин`);
    console.log(`Макс алертів за хвилину: ${CONFIG.MAX_ALERTS_PER_MINUTE}`);
    console.log(`Оновлення ринків: кожні ${CONFIG.REFRESH_MARKETS_HOURS} години`);
    console.log('='.repeat(60));
    console.log('📌 ВАЖЛИВО: Час у сповіщеннях (~2-5 хвилин) - це НОРМАЛЬНО!');
    console.log('   Бот чекає поки накопичиться достатній об\'єм у вікні.');
    console.log('   Для швидших алертів → зменшіть AGGREGATION_WINDOW_SECONDS');
    console.log('   Але менше вікно = менше якісних сигналів');
    console.log('='.repeat(60));

    // Тест Telegram
    try {
      await this.telegram.sendMessage(
        CONFIG.TELEGRAM_CHAT_ID,
        '🚀 Bybit Aggressive Volume Bot Запущено\n\n✅ Відстеження агресивних ринкових угод активне!'
      );
      console.log('[TELEGRAM] ✅ З\'єднання успішне\n');
    } catch (error) {
      console.error('[TELEGRAM] ❌ Помилка підключення:', error.message);
      process.exit(1);
    }

    // Завантажуємо ринкові дані
    await this.marketDataManager.fetchAllMarkets();

    // Підключаємо WebSocket
    await this.wsListener.connect();

    // Запускаємо періодичне оновлення
    this.startMarketRefresh();

    // Обробники завершення
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  startMarketRefresh() {
    this.refreshInterval = setInterval(async () => {
      console.log('\n[REFRESH] 🔄 Оновлення ринкових даних...');
      await this.wsListener.resubscribe();
    }, CONFIG.REFRESH_MARKETS_HOURS * 60 * 60 * 1000);
  }

  async shutdown() {
    console.log('\n[SHUTDOWN] Зупинка бота...');
    
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    
    this.wsListener.close();
    
    await this.telegram.sendMessage(
      CONFIG.TELEGRAM_CHAT_ID,
      '⛔ Bybit Aggressive Volume Bot Зупинено'
    );
    
    process.exit(0);
  }
}

// ============================================================================
// ЗАПУСК БОТА
// ============================================================================

if (require.main === module) {
  const bot = new AggressiveVolumeBot();
  bot.start().catch(error => {
    Logger.error('[FATAL ERROR] ' + error.message);
    if (CONFIG.DEBUG_MODE) {
      Logger.error(error.stack);
    }
    process.exit(1);
  });
}

module.exports = { AggressiveVolumeBot };