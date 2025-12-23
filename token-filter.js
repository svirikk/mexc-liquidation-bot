// ============================================================================
// TOKEN FILTER MODULE
// Фільтрація токенів за Market Cap
// Альтернативний метод БЕЗ Binance API (для обходу HTTP 451)
// ============================================================================

const https = require('https');

class TokenFilter {
  constructor(config) {
    this.config = config;
    this.validTokens = new Set();
    this.tokenMetadata = new Map();
    this.updateInterval = null;
    this.isInitialized = false;
  }

  async initialize() {
    console.log('[FILTER] Ініціалізація фільтру токенів...');
    await this.updateValidTokens();
    this.startPeriodicUpdate();
    this.isInitialized = true;
    console.log(`[FILTER] ✅ Ініціалізовано. Валідних токенів: ${this.validTokens.size}`);
  }

  startPeriodicUpdate() {
    const updateIntervalMs = this.config.UPDATE_INTERVAL_HOURS * 60 * 60 * 1000;
    
    this.updateInterval = setInterval(async () => {
      console.log('[FILTER] Планове оновлення списку токенів...');
      await this.updateValidTokens();
    }, updateIntervalMs);
  }

  async updateValidTokens() {
    try {
      const startTime = Date.now();
      
      // Отримуємо токени з CoinGecko (вони мають інфу про futures)
      console.log('[FILTER] Отримання токенів та їх Market Cap з CoinGecko...');
      const tokensWithMcap = await this.fetchTokensFromCoinGecko();
      
      console.log(`[FILTER] Отримано ${tokensWithMcap.length} токенів з MCAP даними`);

      // Фільтруємо за діапазоном MCAP
      const oldTokens = new Set(this.validTokens);
      const newValidTokens = new Set();
      const newMetadata = new Map();

      let inRange = 0;

      for (const { symbol, mcap } of tokensWithMcap) {
        if (this.isValidMarketCap(mcap)) {
          inRange++;
          newValidTokens.add(symbol);
          newMetadata.set(symbol, {
            mcap,
            lastUpdate: Date.now()
          });
        }
      }

      this.validTokens = newValidTokens;
      this.tokenMetadata = newMetadata;

      const added = [...newValidTokens].filter(t => !oldTokens.has(t));
      const removed = [...oldTokens].filter(t => !newValidTokens.has(t));

      const duration = Date.now() - startTime;
      
      console.log('[FILTER] ═══════════════════════════════════════');
      console.log('[FILTER] Оновлення завершено:');
      console.log(`  • Всього токенів: ${tokensWithMcap.length}`);
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
        console.log(`[FILTER] Видалені: ${removed.join(', ')}`);
      } else if (removed.length > 10) {
        console.log(`[FILTER] Видалені: ${removed.slice(0, 10).join(', ')}... (+${removed.length - 10})`);
      }

      return { added, removed, total: this.validTokens.size };

    } catch (error) {
      console.error('[FILTER] Помилка оновлення:', error.message);
      return { added: [], removed: [], total: this.validTokens.size };
    }
  }

  /**
   * Отримання токенів з CoinGecko (обходимо Binance API)
   */
  async fetchTokensFromCoinGecko() {
    try {
      const tokens = [];
      const perPage = 250;
      
      // Отримуємо достатньо сторінок
      for (let page = 1; page <= 5; page++) {
        try {
          const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&sparkline=false`;
          const data = await this.httpsGet(url);

          if (!Array.isArray(data)) {
            console.error(`[FILTER] Некоректний формат (сторінка ${page})`);
            continue;
          }

          for (const coin of data) {
            if (coin.symbol && coin.market_cap) {
              // Конвертуємо в формат Binance USDT
              const symbol = coin.symbol.toUpperCase() + 'USDT';
              tokens.push({
                symbol,
                mcap: coin.market_cap
              });
            }
          }

          console.log(`[FILTER] CoinGecko сторінка ${page}: ${data.length} монет (всього: ${tokens.length})`);
          
          // Rate limit
          if (page < 5) {
            await this.sleep(1300);
          }
          
        } catch (error) {
          console.error(`[FILTER] Помилка сторінки ${page}:`, error.message);
        }
      }

      return tokens;

    } catch (error) {
      console.error('[FILTER] Помилка отримання токенів:', error.message);
      return [];
    }
  }

  /**
   * HTTPS GET запит
   */
  httpsGet(url, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  isValidMarketCap(mcap) {
    return mcap >= this.config.MIN_MCAP_USD && mcap <= this.config.MAX_MCAP_USD;
  }

  isValid(symbol) {
    return this.validTokens.has(symbol);
  }

  getValidTokens() {
    return Array.from(this.validTokens);
  }

  getTokenMetadata(symbol) {
    return this.tokenMetadata.get(symbol);
  }

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

  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
}

module.exports = { TokenFilter };
