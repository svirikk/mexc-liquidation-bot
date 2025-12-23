// ============================================================================
// TOKEN FILTER MODULE
// Фільтрація токенів за Market Cap
// 1. Отримати ВСІ токени з Binance Futures
// 2. Для кожного знайти MCAP на CoinGecko
// 3. Залишити тільки ті, що в діапазоні
// ============================================================================

const https = require('https');

class TokenFilter {
  constructor(config) {
    this.config = config;
    this.validTokens = new Set();
    this.tokenMetadata = new Map(); // symbol -> { mcap, lastUpdate }
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
      
      // ШАГ 1: Отримуємо ВСІ токени з Binance Futures
      console.log('[FILTER] Крок 1: Отримання списку всіх токенів з Binance Futures...');
      const binanceSymbols = await this.fetchBinanceFuturesSymbols();
      console.log(`[FILTER] Знайдено ${binanceSymbols.length} токенів на Binance Futures`);

      // ШАГ 2: Отримуємо MCAP для всіх монет з CoinGecko
      console.log('[FILTER] Крок 2: Отримання Market Cap з CoinGecko...');
      const mcapData = await this.fetchMarketCapForAll();
      console.log(`[FILTER] Отримано MCAP для ${Object.keys(mcapData).length} токенів`);

      // ШАГ 3: Фільтруємо токени Binance за MCAP
      console.log('[FILTER] Крок 3: Фільтрація токенів за MCAP...');
      const oldTokens = new Set(this.validTokens);
      const newValidTokens = new Set();
      const newMetadata = new Map();

      let foundMcap = 0;
      let inRange = 0;

      for (const symbol of binanceSymbols) {
        const mcap = mcapData[symbol];
        
        if (mcap) {
          foundMcap++;
          
          // Перевірка діапазону MCAP
          if (this.isValidMarketCap(mcap)) {
            inRange++;
            newValidTokens.add(symbol);
            newMetadata.set(symbol, {
              mcap,
              lastUpdate: Date.now()
            });
          }
        }
      }

      // Оновлюємо внутрішній стан
      this.validTokens = newValidTokens;
      this.tokenMetadata = newMetadata;

      // Визначаємо зміни
      const added = [...newValidTokens].filter(t => !oldTokens.has(t));
      const removed = [...oldTokens].filter(t => !newValidTokens.has(t));

      const duration = Date.now() - startTime;
      
      console.log('[FILTER] ═══════════════════════════════════════');
      console.log('[FILTER] Оновлення завершено:');
      console.log(`  • Токенів на Binance Futures: ${binanceSymbols.length}`);
      console.log(`  • Знайдено MCAP для: ${foundMcap}`);
      console.log(`  • В діапазоні MCAP: ${inRange}`);
      console.log(`  • Валідних токенів: ${this.validTokens.size}`);
      console.log(`  • Додано: ${added.length}`);
      console.log(`  • Видалено: ${removed.length}`);
      console.log(`  • Тривалість: ${(duration / 1000).toFixed(1)}с`);
      console.log('[FILTER] ═══════════════════════════════════════');

      if (added.length > 0 && added.length <= 10) {
        console.log(`[FILTER] Нові токени: ${added.join(', ')}`);
      } else if (added.length > 10) {
        console.log(`[FILTER] Нові токени: ${added.slice(0, 10).join(', ')}... (+${added.length - 10})`);
      }

      if (removed.length > 0 && removed.length <= 10) {
        console.log(`[FILTER] Видалені токени: ${removed.join(', ')}`);
      } else if (removed.length > 10) {
        console.log(`[FILTER] Видалені токени: ${removed.slice(0, 10).join(', ')}... (+${removed.length - 10})`);
      }

      return { added, removed, total: this.validTokens.size };

    } catch (error) {
      console.error('[FILTER] Помилка оновлення:', error.message);
      return { added: [], removed: [], total: this.validTokens.size };
    }
  }

  /**
   * Отримання ВСІХ токенів з Binance Futures
   */
  async fetchBinanceFuturesSymbols() {
    try {
      const data = await this.httpsGet('https://fapi.binance.com/fapi/v1/exchangeInfo');
      
      if (!data || !data.symbols) {
        throw new Error('Некоректний формат даних exchangeInfo');
      }

      const symbols = [];
      
      for (const item of data.symbols) {
        // Тільки активні USDT пари
        if (item.symbol && 
            item.symbol.endsWith('USDT') && 
            item.status === 'TRADING' &&
            item.contractType === 'PERPETUAL') {
          symbols.push(item.symbol);
        }
      }

      return symbols;

    } catch (error) {
      console.error('[FILTER] Помилка отримання токенів Binance:', error.message);
      return [];
    }
  }

  /**
   * Отримання Market Cap для ВСІХ монет з CoinGecko
   */
  async fetchMarketCapForAll() {
    try {
      const mcapMap = {};
      const perPage = 250;
      
      // Отримуємо достатньо сторінок щоб покрити весь можливий діапазон
      // Беремо перші 1000 монет (4 сторінки)
      for (let page = 1; page <= 4; page++) {
        try {
          const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&sparkline=false`;
          const data = await this.httpsGet(url);

          if (!Array.isArray(data)) {
            console.error(`[FILTER] Некоректний формат MCAP (сторінка ${page})`);
            continue;
          }

          for (const coin of data) {
            if (coin.symbol && coin.market_cap) {
              // Конвертуємо в формат Binance: btc -> BTCUSDT
              const symbol = coin.symbol.toUpperCase() + 'USDT';
              mcapMap[symbol] = coin.market_cap;
            }
          }

          console.log(`[FILTER] CoinGecko сторінка ${page}: ${data.length} монет`);
          
          // Rate limit - затримка між запитами
          if (page < 4) {
            await this.sleep(1300);
          }
          
        } catch (error) {
          console.error(`[FILTER] Помилка MCAP сторінки ${page}:`, error.message);
        }
      }

      return mcapMap;

    } catch (error) {
      console.error('[FILTER] Помилка отримання MCAP:', error.message);
      return {};
    }
  }

  /**
   * HTTPS GET запит
   */
  httpsGet(url, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 
          'User-Agent': 'Mozilla/5.0 (compatible; BinanceLiquidationBot/1.0)',
          'Accept': 'application/json'
        },
        timeout: timeout
      }, (res) => {
        let data = '';
        
        res.on('data', chunk => data += chunk);
        
        res.on('end', () => {
          if (res.statusCode === 429) {
            reject(new Error('Rate limit exceeded'));
            return;
          }
          
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error('Помилка парсингу JSON'));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  /**
   * Затримка
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    return {
      total: this.validTokens.size,
      config: {
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
