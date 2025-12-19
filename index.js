/**
 * MEXC Liquidation Monitor (MVP)
 * Listens to FORCE LIQUIDATIONS via WebSocket
 */

require('dotenv').config();

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

// ================= CONFIG =================
const MEXC_WS_URL = 'wss://contract.mexc.com/edge';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// символи для моніторингу
const SYMBOLS = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT'];

// поріг алерта ($)
const LIQ_THRESHOLD_USD = 500_000;

// ================= TELEGRAM =================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// ================= STATE =================
const liquidationBuckets = {}; // symbol -> { long, short, startTs }

// ================= WS =================
const ws = new WebSocket(MEXC_WS_URL);

ws.on('open', () => {
  console.log('[WS] Connected to MEXC');

  SYMBOLS.forEach(symbol => {
    const subMsg = {
      method: 'sub',
      params: [`push.forceOrder.${symbol}`],
      id: Date.now()
    };

    ws.send(JSON.stringify(subMsg));
    console.log(`[WS] Subscribed to forceOrder ${symbol}`);
  });
});

ws.on('message', raw => {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  // тільки ліквідації
  if (!msg.c || !msg.c.startsWith('push.forceOrder')) return;

  const d = msg.d;
  if (!d || !d.p || !d.v) return;

  const symbol = d.s;
  const price = Number(d.p);
  const volume = Number(d.v);
  const usd = price * volume;

  // T: 1 = long liquidated, 2 = short liquidated
  const side = d.T === 1 ? 'LONG' : 'SHORT';

  if (!liquidationBuckets[symbol]) {
    liquidationBuckets[symbol] = {
      long: 0,
      short: 0,
      startTs: Date.now()
    };
  }

  if (side === 'LONG') liquidationBuckets[symbol].long += usd;
  else liquidationBuckets[symbol].short += usd;

  checkAlert(symbol);
});

ws.on('error', err => {
  console.error('[WS] Error:', err.message);
});

ws.on('close', () => {
  console.warn('[WS] Connection closed. Reconnecting in 5s...');
  setTimeout(() => reconnect(), 5000);
});

function reconnect() {
  console.log('[WS] Reconnecting...');
  process.exit(1); // Render/Railway перезапустить контейнер
}

// ================= ALERT LOGIC =================
function checkAlert(symbol) {
  const bucket = liquidationBuckets[symbol];
  if (!bucket) return;

  const total = bucket.long + bucket.short;
  const elapsed = (Date.now() - bucket.startTs) / 1000;

  if (total < LIQ_THRESHOLD_USD) return;

  const dominance =
    bucket.long > bucket.short
      ? `LONG ${((bucket.long / total) * 100).toFixed(1)}%`
      : `SHORT ${((bucket.short / total) * 100).toFixed(1)}%`;

  const text = `
🌊 ЛИКВИДАЦИЯ
🔥 ${symbol}
💥 Объем: $${total.toLocaleString()} за ${elapsed.toFixed(1)}с
📊 Доминирование: ${dominance}
`;

  console.log(text);
  sendTelegram(text);

  // reset bucket
  liquidationBuckets[symbol] = null;
}

// ================= TELEGRAM =================
function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;

  bot.sendMessage(TELEGRAM_CHAT_ID, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }).catch(() => {});
}
