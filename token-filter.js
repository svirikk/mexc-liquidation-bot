// ============================================================================
// TOKEN FILTER MODULE
// Фільтрація токенів за Market Cap (тільки MCAP, без OI)
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
      
      // Отримуємо дані з CoinGecko
      const marketCapData = await this.fetchMarketCap();

      // Старий список для порівняння
      const oldTokens = new Set(this.validTokens);
      
      // Новий список
      const newValidTokens = new Set();
      const newMetadata = new Map();

      // Фільтруємо за MCAP
      for (const [symbol, mcap] of Object.entries(marketCapData)) {
        if (this.isValidMarketCap(mcap)) {
          newValidTokens.add(symbol);
          newMetadata.set(symbol, {
            mcap,
            lastUpdate: Date.now()
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
      if (removed.length > 0) {
        console.log(`  • Видалені токени: ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? '...' : ''}`);
      }

      return { added, removed, total: this.validTokens.size };

    } catch (error) {
      console.error('[FILTER] Помилка оновлення:', error.message);
      // При помилці зберігаємо старий список
      return { added: [], removed: [], total: this.validTokens.size };
    }
  }

  /**
   * Отримання Market Cap з CoinGecko
   * Отримуємо всі монети (не тільки top 250), щоб покрити весь діапазон $10M-$150M
   */
  async fetchMarketCap() {
    try {
      const mcapMap = {};
      const perPage = 250;
      
      // Отримуємо перші 4 сторінки (1000 монет) - цього достатньо для покриття $10M+
      for (let page = 1; page <= 4; page++) {
        try {
          const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&sparkline=false`;
          const data = await this.httpsGet(url);

          if (!Array.isArray(data)) {
            console.error(`[FILTER] Некоректний формат даних MCAP (сторінка ${page})`);
            continue;
          }

          for (const coin of data) {
            if (coin.symbol && coin.market_cap) {
              // Конвертуємо symbol в формат Binance (btc -> BTCUSDT)
              const symbol = coin.symbol.toUpperCase() + 'USDT';
              mcapMap[symbol] = coin.market_cap;
            }
          }

          console.log(`[FILTER] MCAP: отримано сторінку ${page} (${Object.keys(mcapMap).length} токенів загалом)`);
          
          // Затримка між запитами (CoinGecko rate limit)
          await this.sleep(1200);
          
        } catch (error) {
          console.error(`[FILTER] Помилка отримання MCAP сторінки ${page}:`, error.message);
        }
      }

      console.log(`[FILTER] MCAP: фінально отримано ${Object.keys(mcapMap).length} токенів`);
      return mcapMap;

    } catch (error) {
      console.error('[FILTER] Помилка отримання MCAP:', error.message);
      return {};
    }
  }

  /**
   * HTTPS GET запит з timeout
   */
  httpsGet(url, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 
          'User-Agent': 'Binance-Liquidation-Bot',
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
   * Затримка (для rate limiting)
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