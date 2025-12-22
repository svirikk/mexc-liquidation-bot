// ============================================================================
// TOKEN FILTER MODULE
// Фільтрація токенів за Market Cap та Open Interest
// ============================================================================

const https = require('https');

class TokenFilter {
  constructor(config) {
    this.config = config;
    this.validTokens = new Set();
    this.tokenMetadata = new Map(); // symbol -> { mcap, oi, lastUpdate }
    this.updateInterval = null;
    this.isInitialized = false;
  }

  /**
   * Ініціалізація фільтру та перше оновлення
   */
  async initialize() {
    console.log('[FILTER] Ініціалізація фільтру токенів...');
    await this.updateValidTokens();
    this.startPeriodicUpdate();
    this.isInitialized = true;
    console.log(`[FILTER] ✅ Ініціалізовано. Валідних токенів: ${this.validTokens.size}`);
  }

  /**
   * Запуск періодичного оновлення кожні 2 години
   */
  startPeriodicUpdate() {
    const updateIntervalMs = this.config.UPDATE_INTERVAL_HOURS * 60 * 60 * 1000;
    
    this.updateInterval = setInterval(async () => {
      console.log('[FILTER] Планове оновлення списку токенів...');
      await this.updateValidTokens();
    }, updateIntervalMs);
  }

  /**
   * Оновлення списку валідних токенів
   */
  async updateValidTokens() {
    try {
      const startTime = Date.now();
      
      // Отримуємо дані з обох джерел
      const [openInterestData, marketCapData] = await Promise.all([
        this.fetchOpenInterest(),
        this.fetchMarketCap()
      ]);

      // Старий список для порівняння
      const oldTokens = new Set(this.validTokens);
      
      // Новий список
      const newValidTokens = new Set();
      const newMetadata = new Map();

      // Об'єднуємо дані та фільтруємо
      const allSymbols = new Set([
        ...Object.keys(openInterestData),
        ...Object.keys(marketCapData)
      ]);

      for (const symbol of allSymbols) {
        const oi = openInterestData[symbol] || 0;
        const mcap = marketCapData[symbol] || 0;

        // Перевірка критеріїв
        const isValidByOI = this.isValidOpenInterest(oi);
        const isValidByMCAP = this.isValidMarketCap(mcap);

        // Токен валідний, якщо хоча б одна умова виконується
        if (isValidByOI || isValidByMCAP) {
          newValidTokens.add(symbol);
          newMetadata.set(symbol, {
            oi,
            mcap,
            lastUpdate: Date.now(),
            validByOI: isValidByOI,
            validByMCAP: isValidByMCAP
          });
        }
      }

      // Оновлюємо внутрішній стан
      this.validTokens = newValidTokens;
      this.tokenMetadata = newMetadata;

      // Визначаємо зміни
      const added = [...newValidTokens].filter(t => !oldTokens.has(t));
      const removed = [...oldTokens].filter(t => !newValidTokens.has(t));

      const duration = Date.now() - startTime;
      
      console.log('[FILTER] Оновлення завершено:');
      console.log(`  • Всього валідних: ${this.validTokens.size}`);
      console.log(`  • Додано: ${added.length}`);
      console.log(`  • Видалено: ${removed.length}`);
      console.log(`  • Тривалість: ${duration}ms`);

      if (added.length > 0) {
        console.log(`  • Нові токени: ${added.slice(0, 5).join(', ')}${added.length > 5 ? '...' : ''}`);
      }

      return { added, removed, total: this.validTokens.size };

    } catch (error) {
      console.error('[FILTER] Помилка оновлення:', error.message);
      // При помилці зберігаємо старий список
      return { added: [], removed: [], total: this.validTokens.size };
    }
  }

  /**
   * Отримання Open Interest з Binance
   */
  async fetchOpenInterest() {
    try {
      const data = await this.httpsGet('https://fapi.binance.com/fapi/v1/openInterest');
      
      if (!Array.isArray(data)) {
        throw new Error('Некоректний формат даних OI');
      }

      const oiMap = {};
      
      for (const item of data) {
        if (item.symbol && item.openInterest && item.symbol.endsWith('USDT')) {
          // Open Interest в контрактах, потрібно помножити на ціну
          const symbol = item.symbol;
          const oi = parseFloat(item.openInterest);
          
          // Отримуємо ціну для перерахунку в USD
          const price = await this.getSymbolPrice(symbol);
          const oiUSD = oi * price;
          
          oiMap[symbol] = oiUSD;
        }
      }

      console.log(`[FILTER] OI: отримано ${Object.keys(oiMap).length} токенів`);
      return oiMap;

    } catch (error) {
      console.error('[FILTER] Помилка отримання OI:', error.message);
      return {};
    }
  }

  /**
   * Отримання ціни символу
   */
  async getSymbolPrice(symbol) {
    try {
      const data = await this.httpsGet(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
      return parseFloat(data.price) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Отримання Market Cap з CoinGecko
   */
  async fetchMarketCap() {
    try {
      // Отримуємо список всіх монет з ринковими даними
      const data = await this.httpsGet(
        'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false'
      );

      if (!Array.isArray(data)) {
        throw new Error('Некоректний формат даних MCAP');
      }

      const mcapMap = {};

      for (const coin of data) {
        if (coin.symbol && coin.market_cap) {
          // Конвертуємо symbol в формат Binance (BTC -> BTCUSDT)
          const symbol = coin.symbol.toUpperCase() + 'USDT';
          mcapMap[symbol] = coin.market_cap;
        }
      }

      console.log(`[FILTER] MCAP: отримано ${Object.keys(mcapMap).length} токенів`);
      return mcapMap;

    } catch (error) {
      console.error('[FILTER] Помилка отримання MCAP:', error.message);
      return {};
    }
  }

  /**
   * HTTPS GET запит
   */
  httpsGet(url) {
    return new Promise((resolve, reject) => {
      https.get(url, {
        headers: { 'User-Agent': 'Binance-Liquidation-Bot' }
      }, (res) => {
        let data = '';
        
        res.on('data', chunk => data += chunk);
        
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error('Помилка парсингу JSON'));
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * Перевірка валідності Open Interest
   */
  isValidOpenInterest(oi) {
    return oi >= this.config.MIN_OI_USD && oi <= this.config.MAX_OI_USD;
  }

  /**
   * Перевірка валідності Market Cap
   */
  isValidMarketCap(mcap) {
    return mcap >= this.config.MIN_MCAP_USD && mcap <= this.config.MAX_MCAP_USD;
  }

  /**
   * Перевірка чи токен валідний
   */
  isValid(symbol) {
    return this.validTokens.has(symbol);
  }

  /**
   * Отримання списку валідних токенів
   */
  getValidTokens() {
    return Array.from(this.validTokens);
  }

  /**
   * Отримання метаданих токену
   */
  getTokenMetadata(symbol) {
    return this.tokenMetadata.get(symbol);
  }

  /**
   * Отримання статистики
   */
  getStats() {
    const validByOI = Array.from(this.tokenMetadata.values())
      .filter(m => m.validByOI).length;
    const validByMCAP = Array.from(this.tokenMetadata.values())
      .filter(m => m.validByMCAP).length;
    const validByBoth = Array.from(this.tokenMetadata.values())
      .filter(m => m.validByOI && m.validByMCAP).length;

    return {
      total: this.validTokens.size,
      validByOI,
      validByMCAP,
      validByBoth,
      config: {
        oiRange: `$${this.formatNumber(this.config.MIN_OI_USD)} - $${this.formatNumber(this.config.MAX_OI_USD)}`,
        mcapRange: `$${this.formatNumber(this.config.MIN_MCAP_USD)} - $${this.formatNumber(this.config.MAX_MCAP_USD)}`
      }
    };
  }

  formatNumber(num) {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    }
    return `${(num / 1_000).toFixed(0)}K`;
  }

  /**
   * Зупинка періодичного оновлення
   */
  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
}

module.exports = { TokenFilter };
