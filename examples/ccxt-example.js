'use strict';

/**
 * Example: Integrating crypto-maker-bbo with CCXT (Binance / OKX / Bybit)
 * 
 * Install dependencies:
 * npm install ccxt crypto-maker-bbo
 */

const ccxt = require('ccxt');
const { createBboEngine } = require('../index');

async function main() {
  // 1. Initialize exchange via CCXT (using your own credentials or demo mode)
  const exchange = new ccxt.okx({
    apiKey: process.env.API_KEY || '',
    secret: process.env.API_SECRET || '',
    password: process.env.API_PASSPHRASE || '',
    enableRateLimit: true,
    options: { defaultType: 'swap' }
  });

  // Enable demo trading if needed
  if (process.env.DEMO_TRADING === 'true') {
    exchange.setSandboxMode(true);
  }

  // 2. Create the BBO execution engine by injecting standard adapter callbacks
  const engine = createBboEngine({
    caps: {
      maxDurationMs: 60000,    // 60 seconds limit
      maxReprices: 20,         // Max 20 reprices
      maxDrift: 0.003,         // Max 0.3% adverse drift circuit breaker
      pollIntervalMs: 800
    },

    // A. Fetch current Top of Book (BBO)
    async getOrderbook(symbol) {
      const ob = await exchange.fetchOrderBook(symbol, 5);
      return { bids: ob.bids, asks: ob.asks };
    },

    // B. Place Post-Only limit order (Maker only)
    async placePostOnly({ symbol, side, price, size, clientOrderId }) {
      try {
        const order = await exchange.createOrder(symbol, 'limit', side, size, price, {
          postOnly: true,
          clientOrderId
        });
        return { ok: true, orderId: order.id };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    // C. Cancel order
    async cancelOrder({ symbol, orderId }) {
      try {
        await exchange.cancelOrder(orderId, symbol);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    // D. Check order status & fills
    async getOrderStatus({ symbol, orderId }) {
      try {
        const ord = await exchange.fetchOrder(orderId, symbol);
        return {
          ok: true,
          filledSize: ord.filled,
          status: ord.status // 'open', 'closed', 'canceled'
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    // Precision rounding helpers
    snapPrice(price) { return Number(price.toFixed(2)); },
    alignSize(size) { return Number(size.toFixed(4)); }
  });

  console.log('--- Starting Maker BBO Chase ---');
  
  // Start chasing: Buy 0.01 BTC using Post-Only Maker order
  const res = await engine.start({
    symbol: 'BTC/USDT:USDT',
    side: 'buy',
    size: 0.01,
    dryRun: true // Default to true for risk-free sandbox testing!
  });

  console.log('Task started:', res);

  // Monitor status every 2 seconds
  const monitor = setInterval(() => {
    const st = engine.status();
    console.log('Engine Status:', JSON.stringify(st, null, 2));
    if (st.running.length === 0) {
      console.log('All tasks finished.');
      clearInterval(monitor);
      engine.destroy();
    }
  }, 2000);
}

main().catch(console.error);
