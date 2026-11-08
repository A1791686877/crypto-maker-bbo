'use strict';

/**
 * crypto-maker-bbo
 * Universal Maker Best-Bid-Offer (BBO) execution engine for crypto & quantitative trading.
 * Maximizes Maker rebates (Post Only) and eliminates Taker penalty fees with robust state-machine protections.
 */

const crypto = require('crypto');

const DEFAULT_CAPS = Object.freeze({
  maxDurationMs: 60000,      // Max chasing duration (ms). Set to 0 for unlimited.
  maxReprices: 20,           // Max reprice attempts before giving up.
  maxDrift: 0.003,           // Max adverse price drift (0.3% default) before circuit breaker stops task.
  maxPostOnlyRetries: 6,     // Consecutive Post-Only rejections before aborting.
  pollIntervalMs: 750        // Polling interval in milliseconds.
});

function createBboEngine(options = {}) {
  const caps = Object.assign({}, DEFAULT_CAPS, options.caps || {});
  const deps = {
    getOrderbook: options.getOrderbook,
    placePostOnly: options.placePostOnly,
    cancelOrder: options.cancelOrder,
    getOrderStatus: options.getOrderStatus,
    snapPrice: options.snapPrice || ((p) => p),
    alignSize: options.alignSize || ((s) => s),
    now: options.now || (() => Date.now()),
    logger: options.logger || null
  };

  if (typeof deps.getOrderbook !== 'function') throw new Error('[BBO] getOrderbook function must be provided');
  if (typeof deps.placePostOnly !== 'function') throw new Error('[BBO] placePostOnly function must be provided');
  if (typeof deps.cancelOrder !== 'function') throw new Error('[BBO] cancelOrder function must be provided');

  const tasks = new Map(); // symbol -> task
  const doneHistory = [];  // recent completed tasks (max 50)
  let tickerTimer = null;
  let clSeq = 0;

  const log = (lvl, ...args) => {
    if (deps.logger && typeof deps.logger[lvl] === 'function') {
      deps.logger[lvl]('[MakerBBO]', ...args);
    }
  };

  const genClOrdId = () => ('bbo' + Date.now().toString(36) + (++clSeq).toString(36) + crypto.randomBytes(2).toString('hex')).slice(0, 32);

  function getBestPrice(book, side) {
    if (!book) return 0;
    const list = side === 'buy' ? (book.bids || []) : (book.asks || []);
    if (!list.length) return 0;
    const top = list[0];
    return Array.isArray(top) ? Number(top[0]) : Number(top.price || 0);
  }

  async function start(param) {
    const symbol = String(param.symbol || '').trim();
    const side = String(param.side || '').toLowerCase();
    const totalSize = Number(param.size);

    if (!symbol) return { ok: false, error: 'Symbol is required' };
    if (side !== 'buy' && side !== 'sell') return { ok: false, error: 'Side must be "buy" or "sell"' };
    if (!(totalSize > 0)) return { ok: false, error: 'Size must be greater than 0' };
    if (tasks.has(symbol)) return { ok: false, error: `A chasing task for ${symbol} is already active` };

    const task = {
      symbol,
      side,
      totalSize: deps.alignSize(totalSize),
      filledSize: 0,
      childStartSize: 0,
      currentOrderId: '',
      currentClOrdId: '',
      currentPrice: 0,
      baseRefPrice: 0,
      reprices: 0,
      postOnlyRetries: 0,
      startedAt: deps.now(),
      state: 'starting',
      lastMessage: 'Initializing BBO chase...',
      stopRequested: false,
      stopReason: '',
      busy: false,
      dryRun: param.dryRun === true,
      reduceOnly: param.reduceOnly === true,
      extra: param.extra || {}
    };

    tasks.set(symbol, task);
    log('info', `Task started: ${side.toUpperCase()} ${task.totalSize} ${symbol} (dryRun=${task.dryRun})`);

    // Ensure loop is running
    ensureLoop();
    return { ok: true, symbol, dryRun: task.dryRun };
  }

  function requestStop(symbol, reason = 'User requested stop') {
    const t = tasks.get(symbol);
    if (!t || t.state === 'done') return { ok: false, error: 'Task not found or already completed' };
    t.stopRequested = true;
    t.stopReason = reason;
    t.lastMessage = `${reason} (cancelling active orders...)`;
    return { ok: true };
  }

  function status() {
    const fmt = (t) => ({
      symbol: t.symbol,
      side: t.side,
      totalSize: t.totalSize,
      filledSize: t.filledSize,
      remainingSize: Math.max(0, t.totalSize - t.filledSize),
      currentPrice: t.currentPrice,
      baseRefPrice: t.baseRefPrice,
      reprices: t.reprices,
      state: t.state,
      lastMessage: t.lastMessage,
      elapsedMs: deps.now() - t.startedAt,
      dryRun: t.dryRun,
      reduceOnly: t.reduceOnly
    });
    return {
      running: [...tasks.values()].filter(t => t.state !== 'done').map(fmt),
      history: doneHistory.slice(0, 50).map(fmt)
    };
  }

  function finish(t, msg) {
    t.state = 'done';
    t.lastMessage = msg;
    tasks.delete(t.symbol);
    doneHistory.unshift(t);
    if (doneHistory.length > 50) doneHistory.pop();
    log('info', `Task finished: ${t.symbol} -> ${msg}`);
  }

  async function placeChild(t, price, size) {
    t.currentPrice = deps.snapPrice(price);
    t.baseRefPrice = t.baseRefPrice || t.currentPrice;
    t.currentClOrdId = genClOrdId();
    t.childStartSize = t.filledSize;

    if (t.dryRun) {
      t.currentOrderId = 'DRY_RUN_' + t.currentClOrdId;
      t.state = 'chasing';
      t.lastMessage = `[DryRun] Posted ${t.side} ${size} @ ${t.currentPrice}`;
      return { ok: true };
    }

    try {
      const res = await deps.placePostOnly({
        symbol: t.symbol,
        side: t.side,
        price: t.currentPrice,
        size,
        clientOrderId: t.currentClOrdId,
        reduceOnly: t.reduceOnly,
        extra: t.extra
      });

      if (!res || !res.ok) {
        const errMsg = (res && res.error) ? res.error : 'Unknown placement rejection';
        // Post only rejected: market moved across
        if (/post[_\s-]?only|cross/i.test(errMsg)) {
          t.postOnlyRetries++;
          t.lastMessage = `Post-Only crossed (${t.postOnlyRetries}/${caps.maxPostOnlyRetries}): ${errMsg}`;
          if (t.postOnlyRetries >= caps.maxPostOnlyRetries) {
            finish(t, `Aborted: Exceeded max consecutive Post-Only rejects (${caps.maxPostOnlyRetries})`);
          }
          return { ok: false, retryImmediately: true };
        }
        finish(t, `Placement rejected: ${errMsg}`);
        return { ok: false };
      }

      t.currentOrderId = res.orderId || t.currentClOrdId;
      t.postOnlyRetries = 0;
      t.state = 'chasing';
      t.lastMessage = `Chasing: Posted ${t.side} ${size} @ ${t.currentPrice}`;
      return { ok: true };
    } catch (err) {
      finish(t, `Placement network error: ${err.message}`);
      return { ok: false };
    }
  }

  async function cancelActiveChild(t) {
    if (!t.currentOrderId || t.dryRun) {
      t.currentOrderId = '';
      return { ok: true };
    }
    try {
      await deps.cancelOrder({
        symbol: t.symbol,
        orderId: t.currentOrderId,
        clientOrderId: t.currentClOrdId
      });
      t.currentOrderId = '';
      return { ok: true };
    } catch (err) {
      log('warn', `Cancel failed for ${t.symbol}:`, err.message);
      return { ok: false, error: err.message };
    }
  }

  async function tickTask(target) {
    const t = typeof target === 'string' ? tasks.get(target) : target;
    if (!t || t.busy || t.state === 'done') return;
    t.busy = true;

    try {
      // 1. Check user cancellation
      if (t.stopRequested) {
        await cancelActiveChild(t);
        finish(t, t.stopReason || 'User requested stop');
        return;
      }

      // 2. Check timeout
      const elapsed = deps.now() - t.startedAt;
      if (caps.maxDurationMs > 0 && elapsed > caps.maxDurationMs) {
        await cancelActiveChild(t);
        finish(t, `Timeout: Reached max duration ${caps.maxDurationMs / 1000}s`);
        return;
      }

      // 3. Inspect existing active child fill status
      if (t.currentOrderId && typeof deps.getOrderStatus === 'function' && !t.dryRun) {
        const statusRes = await deps.getOrderStatus({
          symbol: t.symbol,
          orderId: t.currentOrderId,
          clientOrderId: t.currentClOrdId
        });

        if (statusRes && statusRes.ok) {
          const childFilled = Number(statusRes.filledSize || 0);
          t.filledSize = deps.alignSize(t.childStartSize + childFilled);

          if (t.filledSize >= t.totalSize || statusRes.status === 'filled') {
            finish(t, `Complete: 100% Filled (${t.filledSize}/${t.totalSize})`);
            return;
          }
        }
      }

      // 4. Calculate remaining quantity
      const remSize = deps.alignSize(t.totalSize - t.filledSize);
      if (!(remSize > 0)) {
        finish(t, `Complete: All ${t.totalSize} filled`);
        return;
      }

      // 5. Fetch fresh orderbook BBO
      let book;
      try {
        book = await deps.getOrderbook(t.symbol);
      } catch (e) {
        t.lastMessage = `Orderbook fetch error: ${e.message}`;
        return;
      }

      const bestPx = getBestPrice(book, t.side);
      if (!(bestPx > 0)) {
        t.lastMessage = 'No liquidity on best same-side orderbook';
        return;
      }

      // First order placement
      if (!t.currentOrderId) {
        // Check adverse drift before first placement
        if (t.baseRefPrice > 0) {
          const drift = t.side === 'buy' ? (bestPx - t.baseRefPrice) / t.baseRefPrice : (t.baseRefPrice - bestPx) / t.baseRefPrice;
          if (drift > caps.maxDrift) {
            finish(t, `Circuit breaker: Adverse drift ${(drift * 100).toFixed(2)}% > ${(caps.maxDrift * 100).toFixed(2)}%`);
            return;
          }
        }
        await placeChild(t, bestPx, remSize);
        return;
      }

      // 6. Check if price moved away from our active child
      const priceDiff = Math.abs(bestPx - t.currentPrice);
      if (priceDiff > 1e-9) {
        // Reprice limit check
        if (t.reprices >= caps.maxReprices) {
          await cancelActiveChild(t);
          finish(t, `Aborted: Reached max reprice count (${caps.maxReprices})`);
          return;
        }

        // Adverse drift circuit breaker
        const drift = t.side === 'buy' ? (bestPx - t.baseRefPrice) / t.baseRefPrice : (t.baseRefPrice - bestPx) / t.baseRefPrice;
        if (drift > caps.maxDrift) {
          await cancelActiveChild(t);
          finish(t, `Circuit breaker: Adverse drift ${(drift * 100).toFixed(2)}% > ${(caps.maxDrift * 100).toFixed(2)}%`);
          return;
        }

        // Price outpaced: Cancel active child then re-place
        t.reprices++;
        await cancelActiveChild(t);
        await placeChild(t, bestPx, remSize);
      }
    } finally {
      t.busy = false;
    }
  }

  function ensureLoop() {
    if (tickerTimer) return;
    tickerTimer = setInterval(async () => {
      if (tasks.size === 0) {
        clearInterval(tickerTimer);
        tickerTimer = null;
        return;
      }
      for (const task of tasks.values()) {
        try {
          await tickTask(task);
        } catch (err) {
          log('error', `Tick error for ${task.symbol}:`, err);
        }
      }
    }, caps.pollIntervalMs);
  }

  function destroy() {
    if (tickerTimer) {
      clearInterval(tickerTimer);
      tickerTimer = null;
    }
    for (const t of tasks.values()) {
      requestStop(t.symbol, 'Engine shutdown');
    }
  }

  return {
    start,
    requestStop,
    status,
    destroy,
    _tickTask: tickTask,
    DEFAULT_CAPS
  };
}

module.exports = {
  createBboEngine,
  DEFAULT_CAPS
};
