/**
 * 端到端测试：生产链路买入 + GMGN 挂单卖出
 *
 * 流程：
 *   1. buildBscSwapUnified → broadcastSwap（生产链路买入）
 *   2. 等待链上确认，拿到买入价格
 *   3. 通过 gmgn-cli order strategy create 创建 3 个挂单：
 *      - 止损 1 个（-30% 全卖）
 *      - 止盈 2 个（+100% 卖 20%，+400% 卖 30%）
 *
 * 用法：
 *   npx tsx test/e2e-buy-and-limit-orders.ts
 *
 * 可选环境变量：
 *   TOKEN_ADDRESS  代币地址（默认测试币）
 *   BUY_AMOUNT_BNB 买入金额 BNB（默认 0.0017 ≈ $1）
 *   SLIPPAGE       滑点百分比（默认 30）
 *   SKIP_BUY       设为 1 跳过买入，只挂单（需已有持仓）
 *   SKIP_ORDERS    设为 1 跳过挂单，只买入
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import { buildBscSwapUnified } from "../src/bsc-swap-builder.js";
import { broadcastSwap, waitForTx } from "../src/broadcast.js";

// 跳过失效的 Ankr key（401 API key disabled）
function patchRpc(): void {
  const urls = (process.env.BSC_RPC_URL || "").split(",");
  const working = urls.filter((u) => !u.includes("ankr"));
  if (working.length > 0 && working.length !== urls.length) {
    process.env.BSC_RPC_URL = working.join(",");
    console.log(`[INFO] 跳过失效 Ankr RPC，剩余 ${working.length} 个节点`);
  }
}
patchRpc();

// ── 配置 ──
const TOKEN_ADDRESS =
  process.env.TOKEN_ADDRESS || (() => { throw new Error("请配置 TOKEN_ADDRESS"); })();
const BUY_AMOUNT_BNB = process.env.BUY_AMOUNT_BNB || "0.0017";
const SLIPPAGE = process.env.SLIPPAGE || "30";
const SKIP_BUY = process.env.SKIP_BUY === "1";
const SKIP_ORDERS = process.env.SKIP_ORDERS === "1";

// 挂单配置：[类型, 涨跌幅百分比, 卖出比例]
const ORDERS: Array<{
  label: string;
  subOrderType: "stop_loss" | "take_profit";
  pctChange: number; // 如 -30 表示跌 30%，+100 表示涨 100%
  sellPercent: number; // 卖出持仓的百分比
}> = [
  { label: "止损 -30%", subOrderType: "stop_loss", pctChange: -30, sellPercent: 100 },
  { label: "止盈 +100%", subOrderType: "take_profit", pctChange: 100, sellPercent: 20 },
  { label: "止盈 +400%", subOrderType: "take_profit", pctChange: 400, sellPercent: 30 },
];

// ── 工具 ──
function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

function gmgnCli(args: string): string {
  const env = {
    ...process.env,
    GMGN_ALLOW_AUTOMATED_TRADES: "1",
  };
  const cmd = `npx gmgn-cli ${args}`;
  log(`  gmgn-cli ${args.split(" ").slice(0, 4).join(" ")} ...`);
  try {
    return execSync(cmd, {
      env,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: unknown) {
    // execSync 失败时提取 stderr（GMGN 实际错误信息）
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const detail = err.stderr?.trim() || err.stdout?.trim() || err.message || String(e);
    throw new Error(detail);
  }
}

// ── Step 1: 买入 ──
async function doBuy(): Promise<{ buyPrice: string }> {
  const walletAddress = process.env.EVM_WALLET_ADDRESS || "";
  log(`买入 ${BUY_AMOUNT_BNB} BNB → ${TOKEN_ADDRESS}`);
  log(`钱包: ${walletAddress}`);

  const result = await buildBscSwapUnified({
    tokenAddress: TOKEN_ADDRESS,
    amount: BUY_AMOUNT_BNB,
    slippagePercent: SLIPPAGE,
    walletAddress,
    options: { buildTx: true },
  });

  log(`路由: ${result.route} | 平台: ${result.tokenMarket.platform} | 进度: ${result.tokenMarket.progress?.toFixed(1)}%`);

  if (result.flapQuote) {
    const tokens = Number(BigInt(result.flapQuote.estimatedOutput) / BigInt(1e12)) / 1e6;
    log(`预估获得: ~${tokens.toLocaleString()} 枚`);
  }

  if (!result.tx) throw new Error("没有交易数据");

  log("广播交易...");
  const t0 = Date.now();
  const broadcastResult = await broadcastSwap(result);
  log(`已广播: ${broadcastResult.txHash} (${Date.now() - t0}ms)`);
  log(`BscScan: https://bscscan.com/tx/${broadcastResult.txHash}`);

  log("等待确认...");
  try {
    const receipt = await waitForTx(broadcastResult.txHash);
    log(`确认: ${receipt.status} | Block: ${receipt.blockNumber}`);
  } catch (e) {
    log(`等待超时（交易已发出）: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 计算买入价格 = inputAmount / estimatedOutput（BNB/token）
  let buyPrice = "0";
  let estimatedOutput = "0"; // 预估获得的代币数量（最小单位）
  if (result.flapQuote && result.flapQuote.estimatedOutput !== "0") {
    const inputBnb = Number(BigInt(result.flapQuote.inputAmount)) / 1e18;
    const outputTokens = Number(BigInt(result.flapQuote.estimatedOutput)) / 1e18;
    buyPrice = (inputBnb / outputTokens).toFixed(18);
    estimatedOutput = result.flapQuote.estimatedOutput;
    log(`买入价格: ${buyPrice} BNB/token (flap)`);
  } else if (result.fourmemeQuote && result.fourmemeQuote.estimatedAmount !== "0") {
    const inputBnb = Number(BigInt(result.fourmemeQuote.amountMsgValue)) / 1e18;
    const outputTokens = Number(BigInt(result.fourmemeQuote.estimatedAmount)) / 1e18;
    buyPrice = (inputBnb / outputTokens).toFixed(18);
    estimatedOutput = result.fourmemeQuote.estimatedAmount;
    log(`买入价格: ${buyPrice} BNB/token (fourmeme)`);
  } else if (result.okxResult && result.okxResult.toTokenAmount !== "0") {
    const inputBnb = parseFloat(BUY_AMOUNT_BNB);
    const outputTokens = Number(BigInt(result.okxResult.toTokenAmount)) / 1e18;
    buyPrice = (inputBnb / outputTokens).toFixed(18);
    estimatedOutput = result.okxResult.toTokenAmount;
    log(`买入价格: ${buyPrice} BNB/token (okx_dex)`);
  }

  return { buyPrice, estimatedOutput };
}

// 获取 BNB/USD 价格
async function getBnbUsdPrice(): Promise<number> {
  try {
    const resp = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT",
    );
    const data = (await resp.json()) as { price: string };
    return parseFloat(data.price);
  } catch {
    // fallback: CoinGecko
    const resp = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd",
    );
    const data = (await resp.json()) as { binancecoin: { usd: number } };
    return data.binancecoin.usd;
  }
}

// ── Step 2: 挂单 ──
async function doLimitOrders(buyPriceBnb: string, tokenBalance: string) {
  const walletAddress = process.env.EVM_WALLET_ADDRESS || "";
  const nativeToken = "0x0000000000000000000000000000000000000000";
  const buyPriceBnbNum = parseFloat(buyPriceBnb);

  if (buyPriceBnbNum <= 0) {
    log("⚠️  无法计算买入价格，跳过挂单");
    return;
  }

  const balance = BigInt(tokenBalance);
  if (balance === 0n) {
    log("⚠️  预估代币数量为 0，无法挂单");
    return;
  }

  // 获取 BNB/USD 价格，转换为 USD/token（GMGN check-price 要求 USD）
  const bnbUsd = await getBnbUsdPrice();
  const buyPriceUsd = buyPriceBnbNum * bnbUsd;
  log(`BNB 价格: $${bnbUsd.toFixed(2)}`);
  log(`开仓价: ${buyPriceBnb} BNB/token = $${buyPriceUsd.toFixed(12)} USD/token`);
  log(`预估代币数量: ${balance.toString()} (最小单位)`);

  log(`\n创建 ${ORDERS.length} 个挂单...`);
  const results: Array<{ label: string; ok: boolean; msg: string }> = [];

  for (let i = 0; i < ORDERS.length; i++) {
    const order = ORDERS[i];
    // 计算 USD 触发价格
    const multiplier = 1 + order.pctChange / 100;
    const checkPriceUsd = buyPriceUsd * multiplier;
    const checkPriceStr = checkPriceUsd.toFixed(12);
    const openPriceStr = buyPriceUsd.toFixed(12);

    // 方向校验
    if (order.subOrderType === "take_profit" && checkPriceUsd <= buyPriceUsd) {
      log(`  ⚠️ ${order.label}: 止盈价必须高于开仓价，跳过`);
      results.push({ label: order.label, ok: false, msg: "止盈价 <= 开仓价" });
      continue;
    }
    if (order.subOrderType === "stop_loss" && checkPriceUsd >= buyPriceUsd) {
      log(`  ⚠️ ${order.label}: 止损价必须低于开仓价，跳过`);
      results.push({ label: order.label, ok: false, msg: "止损价 >= 开仓价" });
      continue;
    }

    // 计算精确卖出数量 = 余额 × sellPercent%
    const sellAmount = (balance * BigInt(order.sellPercent)) / 100n;

    // 所有订单统一用 --amount-in（止损=全部预估量，止盈=按比例）
    const args = [
      "order strategy create",
      "--chain bsc",
      `--from ${walletAddress}`,
      `--base-token ${TOKEN_ADDRESS}`,
      `--quote-token ${nativeToken}`,
      "--order-type limit_order",
      `--sub-order-type ${order.subOrderType}`,
      `--open-price ${openPriceStr}`,
      `--check-price ${checkPriceStr}`,
      `--amount-in ${sellAmount.toString()}`,
      `--slippage ${SLIPPAGE}`,
      "--gas-price 0.1",
      "--yes",
      "--raw",
    ].join(" ");

    log(`  [${order.label}] open=$${openPriceStr} check=$${checkPriceStr} amount=${sellAmount.toString()}`);
    try {
      const output = gmgnCli(args);
      const parsed = JSON.parse(output.trim());
      const orderId = parsed.order_id || "unknown";
      log(`  ✅ ${order.label}: order_id=${orderId}`);
      results.push({ label: order.label, ok: true, msg: output.trim() });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // 检查是否 GMGN 实际已成功（order_id 在 stdout 里）
      if (errMsg.includes("order_id")) {
        log(`  ⚠️ ${order.label}: GMGN 已创建但本地解析出错: ${errMsg.slice(0, 200)}`);
        results.push({ label: order.label, ok: true, msg: "created_but_parse_error" });
      } else {
        log(`  ❌ ${order.label}: ${errMsg.slice(0, 300)}`);
        results.push({ label: order.label, ok: false, msg: errMsg });
      }
    }

    // 避免触发 GMGN 限速（token-bucket: capacity=20, weight=5）
    // 每个请求消耗 5 weight，间隔 2s 让 bucket 恢复
    if (i < ORDERS.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // 汇总
  log(`\n挂单结果: ${results.filter((r) => r.ok).length}/${results.length} 成功`);
  for (const r of results) {
    log(`  ${r.ok ? "✅" : "❌"} ${r.label}`);
  }
}

// ── Step 3: 查挂单 ──
function listOrders() {
  const walletAddress = process.env.EVM_WALLET_ADDRESS || "";
  log("\n查询当前挂单...");
  try {
    const output = gmgnCli(
      `order strategy list --chain bsc --from ${walletAddress} --group-tag LimitOrder --raw`,
    );
    const parsed = JSON.parse(output.trim());
    if (parsed.list?.length) {
      for (const o of parsed.list) {
        log(`  挂单: ${o.base_token_symbol || o.base_token?.slice(0, 10)} | 类型: ${o.sub_order_type || o.order_type} | 状态: ${o.status}`);
      }
    } else {
      log("  无挂单");
    }
  } catch (e) {
    log(`  查询失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Main ──
(async () => {
  log("========== E2E 测试：买入 + GMGN 挂单 ==========");
  log(`Token: ${TOKEN_ADDRESS}`);
  log(`Amount: ${BUY_AMOUNT_BNB} BNB`);
  log(`Skip buy: ${SKIP_BUY} | Skip orders: ${SKIP_ORDERS}`);

  let buyPrice = "0";
  let estimatedOutput = "0";

  if (!SKIP_BUY) {
    const result = await doBuy();
    buyPrice = result.buyPrice;
    estimatedOutput = result.estimatedOutput;
  } else {
    log("跳过买入，使用 tokenMarket 价格...");
    const result = await buildBscSwapUnified({
      tokenAddress: TOKEN_ADDRESS,
      amount: BUY_AMOUNT_BNB,
      slippagePercent: SLIPPAGE,
      walletAddress: process.env.EVM_WALLET_ADDRESS || "",
      options: { buildTx: false },
    });
    if (result.tokenMarket?.price) {
      buyPrice = result.tokenMarket.price;
      log(`参考价格 (USD): ${buyPrice}`);
    }
    // SKIP_BUY 时也需要预估值
    if (result.flapQuote?.estimatedOutput) {
      estimatedOutput = result.flapQuote.estimatedOutput;
    } else if (result.fourmemeQuote?.estimatedAmount) {
      estimatedOutput = result.fourmemeQuote.estimatedAmount;
    } else if (result.okxResult?.toTokenAmount) {
      estimatedOutput = result.okxResult.toTokenAmount;
    }
  }

  if (!SKIP_ORDERS) {
    await doLimitOrders(buyPrice, estimatedOutput);
    listOrders();
  }

  log("\n========== 完成 ==========");
})().catch((e) => {
  console.error("❌ 测试失败:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
