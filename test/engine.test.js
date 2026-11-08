'use strict';

const assert = require('assert');
const { createBboEngine } = require('../index');

async function runTests() {
  console.log('--- 开始 crypto-maker-bbo 单元测试 ---');

  // Test 1: 正常挂单与咬合买一价
  {
    let currentBook = { bids: [[100, 10]], asks: [[101, 10]] };
    let placed = [];
    let cancelled = [];

    const engine = createBboEngine({
      caps: { pollIntervalMs: 50 },
      async getOrderbook() { return currentBook; },
      async placePostOnly(p) { placed.push(p); return { ok: true, orderId: 'ord_1' }; },
      async cancelOrder(p) { cancelled.push(p); return { ok: true }; }
    });

    const res = await engine.start({ symbol: 'BTC-USDT', side: 'buy', size: 1 });
    assert.strictEqual(res.ok, true);

    // 手动执行一轮 tick
    await engine._tickTask('BTC-USDT');

    assert.strictEqual(placed.length, 1);
    assert.strictEqual(placed[0].price, 100);
    assert.strictEqual(placed[0].size, 1);
    assert.strictEqual(engine.status().running[0].state, 'chasing');

    engine.destroy();
    console.log('✓ Test 1: 首次挂单成功咬合最优买一价 PASS');
  }

  // Test 2: 盘口超越触发撤单重挂 (Reprice)
  {
    let currentBook = { bids: [[100, 10]], asks: [[101, 10]] };
    let placed = [];
    let cancelled = [];

    const engine = createBboEngine({
      caps: { pollIntervalMs: 50, maxDrift: 0.05 },
      async getOrderbook() { return currentBook; },
      async placePostOnly(p) { placed.push(p); return { ok: true, orderId: 'ord_' + placed.length }; },
      async cancelOrder(p) { cancelled.push(p); return { ok: true }; }
    });

    await engine.start({ symbol: 'BTC-USDT', side: 'buy', size: 2 });
    await engine._tickTask('BTC-USDT'); // 第 1 挂: 100

    // 盘口跳到 100.1
    currentBook = { bids: [[100.1, 10]], asks: [[101, 10]] };
    await engine._tickTask('BTC-USDT'); // 触发撤改单

    assert.strictEqual(cancelled.length, 1);
    assert.strictEqual(placed.length, 2);
    assert.strictEqual(placed[1].price, 100.1);
    assert.strictEqual(engine.status().running[0].reprices, 1);

    engine.destroy();
    console.log('✓ Test 2: 盘口跳动自动撤销旧单并以新最优价重挂 PASS');
  }

  // Test 3: 不利价格偏移触发熔断断路器 (Max Drift Circuit Breaker)
  {
    let currentBook = { bids: [[100, 10]], asks: [[101, 10]] };
    let cancelled = [];

    const engine = createBboEngine({
      caps: { pollIntervalMs: 50, maxDrift: 0.003 }, // 允许 0.3%
      async getOrderbook() { return currentBook; },
      async placePostOnly() { return { ok: true, orderId: 'ord_1' }; },
      async cancelOrder(p) { cancelled.push(p); return { ok: true }; }
    });

    await engine.start({ symbol: 'BTC-USDT', side: 'buy', size: 1 });
    await engine._tickTask('BTC-USDT'); // 首价 100

    // 价格暴涨到 100.5 (涨幅 0.5% > 0.3%)，追多会导致成本恶化
    currentBook = { bids: [[100.5, 10]], asks: [[101, 10]] };
    await engine._tickTask('BTC-USDT');

    const s = engine.status();
    assert.strictEqual(s.running.length, 0);
    assert.strictEqual(s.history.length, 1);
    assert(s.history[0].lastMessage.includes('Circuit breaker'));
    assert.strictEqual(cancelled.length, 1);

    engine.destroy();
    console.log('✓ Test 3: 不利价格偏离超过阈值立即自动熔断停机 PASS');
  }

  // Test 4: 部分成交 + 剩余数量重挂 (Incremental Accounting)
  {
    let currentBook = { bids: [[100, 10]], asks: [[101, 10]] };
    let placed = [];
    let childStatus = { ok: true, filledSize: 0.4, status: 'partially_filled' };

    const engine = createBboEngine({
      caps: { pollIntervalMs: 50, maxDrift: 0.05 },
      async getOrderbook() { return currentBook; },
      async placePostOnly(p) { placed.push(p); return { ok: true, orderId: 'ord_' + placed.length }; },
      async cancelOrder() { return { ok: true }; },
      async getOrderStatus() { return childStatus; }
    });

    await engine.start({ symbol: 'ETH-USDT', side: 'buy', size: 1 });
    await engine._tickTask('ETH-USDT'); // 挂 1.0 @ 100

    // 价格变为 100.2，且上一张子单已成交 0.4
    currentBook = { bids: [[100.2, 10]], asks: [[101, 10]] };
    await engine._tickTask('ETH-USDT');

    assert.strictEqual(placed.length, 2);
    assert.strictEqual(placed[1].size, 0.6); // 剩余 0.6 重挂
    assert.strictEqual(placed[1].price, 100.2);

    engine.destroy();
    console.log('✓ Test 4: 部分成交智能识别并仅对剩余量重挂 PASS');
  }

  // Test 5: 全部成交自动归档 (100% Filled)
  {
    let currentBook = { bids: [[100, 10]], asks: [[101, 10]] };

    const engine = createBboEngine({
      caps: { pollIntervalMs: 50 },
      async getOrderbook() { return currentBook; },
      async placePostOnly() { return { ok: true, orderId: 'ord_1' }; },
      async cancelOrder() { return { ok: true }; },
      async getOrderStatus() { return { ok: true, filledSize: 1, status: 'filled' }; }
    });

    await engine.start({ symbol: 'SOL-USDT', side: 'buy', size: 1 });
    await engine._tickTask('SOL-USDT'); // 挂单
    await engine._tickTask('SOL-USDT'); // 查单 -> 满额成交

    const s = engine.status();
    assert.strictEqual(s.running.length, 0);
    assert.strictEqual(s.history.length, 1);
    assert(s.history[0].lastMessage.includes('100% Filled'));

    engine.destroy();
    console.log('✓ Test 5: 100% 满额成交自动完成归档 PASS');
  }

  // Test 6: 演练模式 (Dry Run) 安全隔离
  {
    let placed = false;
    const engine = createBboEngine({
      async getOrderbook() { return { bids: [[100, 1]], asks: [[101, 1]] }; },
      async placePostOnly() { placed = true; return { ok: true }; },
      async cancelOrder() { return { ok: true }; }
    });

    await engine.start({ symbol: 'BTC-USDT', side: 'buy', size: 1, dryRun: true });
    await engine._tickTask('BTC-USDT');

    assert.strictEqual(placed, false, 'Dry Run 绝不调用真如下单函数');
    assert.strictEqual(engine.status().running[0].dryRun, true);

    engine.destroy();
    console.log('✓ Test 6: 演练模式零网络零真实交易 PASS');
  }

  console.log('\n🎉 ALL TESTS PASSED! crypto-maker-bbo 算法状态机与五重风控断言全部通过！\n');
}

runTests().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
