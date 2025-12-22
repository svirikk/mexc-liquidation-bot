// ============================================================================
// MEXC AGGRESSIVE VOLUME ALERT BOT
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
// - Слухаємо публічні угоди (push.deal)
// - Агрегуємо об'єми купівлі/продажу в часовому вікні
// - Визначаємо домінування однієї сторони
// - Підтверджуємо ціновим імпульсом
// - Інтерпретуємо це як "примусову ліквідацію"
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
  
  // Фільтри символів
  MIN_OPEN_INTEREST: parseInt(process.env.MIN_OPEN_INTEREST) || 10_000_000,
  MAX_OPEN_INTEREST: parseInt(process.env.MAX_OPEN_INTEREST) || 100_000_000,
  MIN_VOLUME_24H: parseInt(process.env.MIN_VOLUME_24H) || 5_000_000,
  
  // Режим відлагодження (моніторить всі символи)
  MONITOR_ALL_SYMBOLS: process.env.MONITOR_ALL_SYMBOLS === 'true',
  
  // Оновлення ринкових даних
  REFRESH_MARKETS_HOURS: parseInt(process.env.REFRESH_MARKETS_HOURS) || 2,
  
  // API ендпоінти
  MEXC_WS_FUTURES: 'wss://contract.mexc.com/edge',
  MEXC_REST_API: 'https://contract.mexc.com',
  
  // Telegram
  TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
};

// ============================================================================
// МЕНЕДЖЕР РИНКОВИХ ДАНИХ
// ============================================================================

class MarketDataManager {
  constructor() {
    this.markets = new Map(); // symbol -> { oi, price, volume24h, contractSize, lastUpdate }
    this.eligibleSymbols = new Set();
  }

  async fetchAllMarkets() {
    console.log('[API] 📊 Завантаження ринкових даних з MEXC...');
    
    try {
      // Отримуємо всі тікери
      const tickersRes = await axios.get(`${CONFIG.MEXC_REST_API}/api/v1/contract/ticker`, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json'
        },
        timeout: 15000
      });

      if (!tickersRes.data.success) {
        throw new Error(`MEXC API error: ${tickersRes.data.message || 'Unknown error'}`);
      }

      const tickers = tickersRes.data.data;
      let eligibleCount = 0;
      const allSymbols = [];

      for (const ticker of tickers) {
        const symbol = ticker.symbol;
        
        // Тільки USDT пари
        if (!symbol.endsWith('_USDT')) continue;

        const price = parseFloat(ticker.lastPrice) || 0;
        const volume24 = parseFloat(ticker.amount24) || 0; // amount24 - це об'єм в USD
        const holdVol = parseFloat(ticker.holdVol) || 0; // holdVol - це open interest в контрактах
        const contractSize = parseFloat(ticker.contractSize || 0.0001); // розмір контракту
        
        // OI в USD = holdVol * contractSize * price
        const oiValue = holdVol * contractSize * price;

        allSymbols.push({ symbol, oiValue, volume24h: volume24, price });

        this.markets.set(symbol, {
          oi: oiValue,
          price,
          volume24h: volume24,
          contractSize,
          holdVol,
          lastUpdate: Date.now()
        });

        // Перевірка придатності
        const isEligible = CONFIG.MONITOR_ALL_SYMBOLS || (
          oiValue >= CONFIG.MIN_OPEN_INTEREST &&
          oiValue <= CONFIG.MAX_OPEN_INTEREST &&
          volume24 >= CONFIG.MIN_VOLUME_24H
        );

        if (isEligible) {
          this.eligibleSymbols.add(symbol);
          eligibleCount++;
        }
      }

      console.log(`[API] ✅ Всього ринків: ${tickers.length}`);
      console.log(`[API] 🎯 Відібрано символів: ${eligibleCount}`);
      
      if (CONFIG.MONITOR_ALL_SYMBOLS) {
        console.log(`[API] 🔥 РЕЖИМ ВІДЛАГОДЖЕННЯ: Моніторинг ВСІХ символів`);
      } else {
        console.log(`[API] 📋 Фільтри:`);
        console.log(`      - OI: $${(CONFIG.MIN_OPEN_INTEREST / 1e6).toFixed(1)}M - $${(CONFIG.MAX_OPEN_INTEREST / 1e6).toFixed(1)}M`);
        console.log(`      - Мін 24h обсяг: $${(CONFIG.MIN_VOLUME_24H / 1e6).toFixed(1)}M`);
      }

      if (eligibleCount === 0) {
        console.log(`\n[API] ⚠️ Жоден символ не відповідає критеріям. Топ-10 за OI:`);
        allSymbols
          .sort((a, b) => b.oiValue - a.oiValue)
          .slice(0, 10)
          .forEach((s, i) => {
            console.log(`      ${(i + 1).toString().padStart(2)}. ${s.symbol.padEnd(12)} | OI: $${(s.oiValue / 1e6).toFixed(1)}M`);
          });
      }
      console.log('');

      return Array.from(this.eligibleSymbols);
    } catch (error) {
      console.error('[API] ❌ Помилка завантаження:', error.message);
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

  cleanup(symbol) {
    const now = Date.now();
    const windowMs = CONFIG.AGGREGATION_WINDOW_SECONDS * 1000;

    if (!this.windows.has(symbol)) return;

    const window = this.windows.get(symbol);
    const filtered = window.trades.filter(t => now - t.timestamp < windowMs);

    if (filtered.length === 0) {
      this.windows.delete(symbol);
    } else {
      window.trades = filtered;
      window.startTime = filtered[0].timestamp;
      window.startPrice = filtered[0].price;
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
    
    const cleanSymbol = symbol.replace('_USDT', '');
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
  }

  async checkAndAlert(symbol, stats, tradeAggregator) {
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
      this.cooldownManager.recordAlert(symbol, stats);
      
      console.log(`[🚨 АЛЕРТ] ${symbol} - ${interpretation.type} - $${(stats.totalVolumeUSD / 1e6).toFixed(2)}M - ${stats.dominance.toFixed(1)}% - Δ${stats.priceChange.toFixed(2)}%`);
      
      // Скидаємо вікно після алерту
      tradeAggregator.reset(symbol);
    } catch (error) {
      console.error(`[ERROR] Помилка відправки алерту для ${symbol}:`, error.message);
    }
  }
}

// ============================================================================
// MEXC WEBSOCKET (PUSH.DEAL)
// ============================================================================
// Слухаємо публічні угоди через push.deal канал

class MexcWebSocketListener {
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
  }

  async connect() {
    console.log('[WS] 🔌 Підключення до MEXC WebSocket...');
    
    this.ws = new WebSocket(CONFIG.MEXC_WS_FUTURES);

    this.ws.on('open', () => {
      console.log('[WS] ✅ Підключено успішно');
      this.reconnectAttempts = 0;
      this.startPingInterval();
      this.subscribeToTrades();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (error) => {
      console.error('[WS] Помилка:', error.message);
    });

    this.ws.on('close', () => {
      console.log('[WS] З\'єднання закрито');
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
      console.log('[WS] ⚠️ Немає придатних символів для підписки');
      return;
    }

    console.log(`[WS] 📡 Підписка на ${eligibleSymbols.length} символів (push.deal)...`);

    // Підписуємося на кожен символ окремо
    for (const symbol of eligibleSymbols) {
      const subscribeMessage = {
        method: 'sub.deal',
        param: {
          symbol: symbol
        }
      };
      
      this.ws.send(JSON.stringify(subscribeMessage));
      this.subscribedSymbols.add(symbol);
    }

    console.log(`[WS] ✅ Підписано на ${eligibleSymbols.length} символів`);
    console.log('[WS] 📊 Перші 15 символів:');
    
    eligibleSymbols.slice(0, 15).forEach(symbol => {
      const data = this.marketDataManager.getMarketData(symbol);
      if (data) {
        console.log(`     ${symbol.padEnd(15)} | OI: $${(data.oi / 1e6).toFixed(1)}M`);
      }
    });
    
    if (eligibleSymbols.length > 15) {
      console.log(`     ... та ще ${eligibleSymbols.length - 15}`);
    }
    
    console.log('\n[STATUS] 🎯 Моніторинг агресивних угод...');
    console.log(`[STATUS] 💰 Поріг: $${(CONFIG.MIN_VOLUME_USD / 1e6).toFixed(1)}M обсяг, ${CONFIG.MIN_DOMINANCE}% домінування, ${CONFIG.MIN_PRICE_CHANGE}% зміна ціни`);
    console.log('[STATUS] ⏳ Очікування угод...\n');
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      
      // Pong відповідь
      if (message.channel === 'pong') {
        return;
      }

      // Підтвердження підписки
      if (message.channel === 'rs.sub.deal') {
        return;
      }

      // Публічні угоди - канал push.deal
      if (message.channel === 'push.deal' && message.data) {
        const symbol = message.symbol;
        
        // Тільки придатні символи
        if (!this.marketDataManager.isEligible(symbol)) {
          return;
        }

        // Обробляємо кожну угоду в масиві data
        const trades = Array.isArray(message.data) ? message.data : [message.data];
        
        for (const rawTrade of trades) {
          const price = parseFloat(rawTrade.p);
          const size = parseFloat(rawTrade.v);
          // T: 1 = Buy (taker buy), 2 = Sell (taker sell)
          const side = rawTrade.T === 1 ? 'Buy' : 'Sell';
          const timestamp = parseInt(rawTrade.t);
          
          // Отримуємо розмір контракту для розрахунку USD вартості
          const marketData = this.marketDataManager.getMarketData(symbol);
          const contractSize = marketData ? marketData.contractSize : 0.0001;
          const valueUSD = price * size * contractSize;

          const trade = {
            price,
            size,
            side,
            timestamp,
            valueUSD
          };

          // Додаємо угоду в агрегатор
          this.tradeAggregator.addTrade(symbol, trade);

          // Логуємо тільки великі угоди
          if (valueUSD >= 50000) {
            const sideEmoji = side === 'Buy' ? '🟢' : '🔴';
            console.log(`[TRADE] ${symbol.padEnd(12)} | ${sideEmoji} ${side.padEnd(4)} | $${(valueUSD / 1000).toFixed(1)}K @ $${price.toFixed(2)}`);
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
        this.ws.send(JSON.stringify({ method: 'ping' }));
      }
    }, 15000); // MEXC розриває з'єднання через 1 хв без ping
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
    this.wsListener = new MexcWebSocketListener(
      this.tradeAggregator,
      this.alertEngine,
      this.marketDataManager
    );
    this.refreshInterval = null;
  }

  async start() {
    console.log('='.repeat(60));
    console.log('MEXC AGGRESSIVE VOLUME ALERT BOT');
    console.log('Відстеження примусових рухів через агресивні угоди');
    console.log('='.repeat(60));
    console.log(`Мін об'єм для алерту: $${(CONFIG.MIN_VOLUME_USD / 1e6).toFixed(1)}M`);
    console.log(`Мін домінування: ${CONFIG.MIN_DOMINANCE}%`);
    console.log(`Мін зміна ціни: ${CONFIG.MIN_PRICE_CHANGE}%`);
    console.log(`Вікно агрегації: ${CONFIG.AGGREGATION_WINDOW_SECONDS}с`);
    console.log(`OI діапазон: $${(CONFIG.MIN_OPEN_INTEREST / 1e6).toFixed(1)}M - $${(CONFIG.MAX_OPEN_INTEREST / 1e6).toFixed(1)}M`);
    console.log(`Мін 24h обсяг: $${(CONFIG.MIN_VOLUME_24H / 1e6).toFixed(1)}M`);
    console.log(`Cooldown: ${CONFIG.COOLDOWN_MINUTES} хвилин`);
    console.log(`Оновлення ринків: кожні ${CONFIG.REFRESH_MARKETS_HOURS} години`);
    console.log('='.repeat(60));

    // Тест Telegram
    try {
      await this.telegram.sendMessage(
        CONFIG.TELEGRAM_CHAT_ID,
        '🚀 MEXC Aggressive Volume Bot Запущено\n\n✅ Відстеження агресивних ринкових угод активне!'
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
      '⛔ MEXC Aggressive Volume Bot Зупинено'
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
    console.error('[FATAL ERROR]', error);
    process.exit(1);
  });
}

module.exports = { AggressiveVolumeBot };