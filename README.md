# ⚡ crypto-maker-bbo

> **Universal Maker Best-Bid-Offer (BBO) Execution Engine for Crypto Trading.**  
> 专门面向加密货币与量化交易的 **Maker BBO 智能追价挂单引擎** —— 强制 `Post Only` 挂单，享受负费率/零费率返佣，彻底告别 Taker 惩罚性吃单手续费！

---

### ⚠️ 风险提示与免责声明 (Risk Disclaimer)

> **请在使用前务必仔细阅读以下条款：**
> 1. **仅供学习与量化交流**：本项目完全开源，仅作为量化挂单算法、订单簿状态机及执行逻辑的技术交流与参考，**绝不构成任何投资建议、操盘指令或收益承诺**。
> 2. **交易损失自负**：数字资产与加密货币衍生品交易具备极高的市场风险。因网络延迟、交易所撮合异常、API 变更、滑点或算法策略未达预期导致的**任何直接或间接资金损失，本项目作者与所有贡献者概不承担任何法律与经济责任**。
> 3. **必须充分演练**：在接入真实资金前，**请务必使用本项目自带的 `dryRun: true` 沙盒模式，或在各交易所模拟盘（Demo / Paper Trading）中进行充分测试**！

---

## 💡 为什么需要 Maker BBO？（省下巨额手续费）

在加密衍生品与现货交易中，**手续费是吞噬策略利润的第一杀手**：

| 交易方式 | 费率类型 | 常见费率 | 100,000 USDT 成交费用 | 影响 |
| :--- | :--- | :--- | :--- | :--- |
| **Taker（市价吃单）** | 惩罚性手续费 | `0.050% ~ 0.060%` | **$50.0 ~ $60.0** | 频繁调仓/网格/波段时，手续费极易吃光全部毛利 |
| **Maker（限价挂单）** | 奖励性极低 / 负费率 | `0.000% ~ -0.010%` | **$0.0 ~ -$10.0（平台返佣）** | **单次节省 100% 费率，甚至反向赚钱！** |

### 传统限价单的死穴：
- **挂单不成交**：行情单边一拉，限价单被远远甩在身后；
- **被迫换市价**：等不及了改成市价单，直接被收高额 Taker 费并承受严重滑点。

### `crypto-maker-bbo` 的解决方案：
动态将订单挂在盘口**第一买价 / 第一卖价（Top of Book）**，并强制 `Post Only`。当盘口价格向上或向下跳变时，引擎毫秒级自动撤销未成交部分，并按**剩余数量**重新咬合最新最优价，兼顾**高成交率**与 **100% 纯 Maker 费率**！

---

## 🛡️ 五重工业级风控保护体系

为了防止恶劣行情下失控，引擎内置了严格的状态机断路器：

1. **不利偏移熔断（Max Drift Circuit Breaker）**  
   若最新盘口价格相比开单时的基准价向**不利方向**偏离超过预设阈值（默认 `0.30%`），引擎立即撤单断路停机，**防止单边暴跌被动追高建仓**。
2. **追价次数上限（Max Reprices）**  
   限制单次任务最大追价次数（默认 `20次`），防止极端高频抖动行情导致交易所 API 请求频控（Rate Limit）封禁。
3. **撤单确认屏障（Cancel Barrier）**  
   在上一张子单撤单得到明确确认前，**绝不盲目发出新子单**；严格根据真实未成交量增量重挂，**从算法根源杜绝超买超卖**。
4. **超时自动收尾（Max Duration）**  
   支持配置任务最长生存时间（默认 `60秒`，可设为 0 不限时），超时自动撤回残单，不留死单。
5. **原生沙盒演练模式（Dry Run）**  
   开箱支持 `dryRun: true`，在完全不触碰真实 API 的情况下模拟订单生命周期与盘口跳动。

---

## 🚀 5 分钟快速嵌入指南

本引擎采用**纯依赖注入架构（Dependency Injection）**，零外部重依赖，可轻松塞入任何现有的交易脚本、CCXT 机器人或自有终端中。

### 1. 安装
```bash
npm install crypto-maker-bbo
```

### 2. 结合 CCXT 使用示例
```javascript
const ccxt = require('ccxt');
const { createBboEngine } = require('crypto-maker-bbo');

// 1. 初始化你的交易所连接
const exchange = new ccxt.okx({
  apiKey: 'YOUR_API_KEY',
  secret: 'YOUR_SECRET',
  password: 'YOUR_PASSWORD'
});

// 2. 注入 4 个基础交易动作
const engine = createBboEngine({
  caps: {
    maxDurationMs: 60000, // 60秒限时
    maxDrift: 0.003,      // 最大 0.3% 不利滑点熔断
    maxReprices: 20       // 最多追价 20 次
  },

  // 查盘口 BBO
  async getOrderbook(symbol) {
    const ob = await exchange.fetchOrderBook(symbol, 5);
    return { bids: ob.bids, asks: ob.asks };
  },

  // 挂 Post-Only 订单（只挂单不吃单）
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

  // 撤单
  async cancelOrder({ symbol, orderId }) {
    try {
      await exchange.cancelOrder(orderId, symbol);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  // 查询成交状态
  async getOrderStatus({ symbol, orderId }) {
    try {
      const ord = await exchange.fetchOrder(orderId, symbol);
      return { ok: true, filledSize: ord.filled, status: ord.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
});

// 3. 一键启动追价任务
async function run() {
  const result = await engine.start({
    symbol: 'BTC/USDT:USDT',
    side: 'buy',
    size: 0.1,
    dryRun: false // 设为 true 可先进行无损沙盒模拟
  });

  console.log('BBO 追价任务启动:', result);
}

run();
```

---

## ⚙️ 配置参数详解 (Options)

| 参数名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `maxDurationMs` | `60000` | 追价最大时长（毫秒）。设为 `0` 则表示不限时追价 |
| `maxReprices` | `20` | 单次任务最大改单/重挂次数，防频繁操作被交易所限频 |
| `maxDrift` | `0.003` (0.3%) | 不利价格最大允许偏移率。超过立即撤单停机 |
| `maxPostOnlyRetries` | `6` | 连续 Post-Only 被拒最大容忍次数（例如盘口急速反转） |
| `pollIntervalMs` | `750` | 订单簿检查与状态机轮询间隔（毫秒） |

---

## 🧪 单元测试

本项目自带 100% 确定性离线模拟测试，涵盖状态转移、价格跳变、熔断断路与增量记账验证：

```bash
npm test
```

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 开源协议。
