/**
 * GMGN 限价挂单引擎
 *
 * 封装 GMGN CLI 的 order strategy 命令，提供：
 *   - 创建止损/止盈挂单（异步，不阻塞主链路）
 *   - 查询挂单状态
 *   - 取消挂单
 *   - 默认配置持久化（logs/gmgn-config.json）
 *
 * 注意：check-price 和 open-price 单位是 USD/token（不是 BNB/token）。
 * 需要 GMGN_ALLOW_AUTOMATED_TRADES=1 + --yes 参数来跳过交互确认。
 */

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

// ── 配置 ──

const LOGS_DIR = path.resolve(process.cwd(), "logs");
const CONFIG_FILE = path.join(LOGS_DIR, "gmgn-config.json");
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";
const SLIPPAGE = "30";

export interface GmgnOrderConfig {
  enabled: boolean;
  stopLossPercent: number;     // 如 30 = 跌 30% 触发
  takeProfit1Percent: number;  // 如 100 = 涨 100%
  takeProfit1Ratio: number;    // 如 20 = 卖出 20%
  takeProfit2Percent: number;  // 如 400 = 涨 400%
  takeProfit2Ratio: number;    // 如 30 = 卖出 30%
}

export const DEFAULT_GMGN_CONFIG: GmgnOrderConfig = {
  enabled: true,
  stopLossPercent: 30,
  takeProfit1Percent: 100,
  takeProfit1Ratio: 25,
  takeProfit2Percent: 400,
  takeProfit2Ratio: 30,
};

export interface GmgnOrderResult {
  orderId: string;
  subOrderType: "stop_loss" | "take_profit" | "market_sell";
  label: string;
  checkPriceUsd: string;
  amount: string;
  sellPercent: number;
  status: "created" | "failed" | "triggered";
  error?: string;
}

export interface GmgnOrderInfo {
  orderId: string;
  type: "stop_loss" | "take_profit" | "market_sell";
  label: string;
  checkPriceUsd: string;
  amount: string;
  sellPercent: number;
  status: "open" | "prepare" | "triggered" | "cancelled" | "unknown";
  createdAtMs: number;
}

// ── CLI 执行 ──

// 全局限流：串行化所有 GMGN CLI 调用，确保间隔至少 1 秒（跨代币也限流）
let gmgnQueue: Promise<void> = Promise.resolve();
let lastGmgnCallMs = 0;
const GMGN_MIN_INTERVAL_MS = 1_000;

function execGmgnRaw(args: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GMGN_ALLOW_AUTOMATED_TRADES: "1",
    };

    // 将参数字符串拆分为数组，自动追加 --yes 以跳过交互确认
    const parts = args.split(/\s+/).filter(Boolean);
    parts.push("--yes");

    execFile("npx", ["gmgn-cli", ...parts], {
      env,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr?.trim() || stdout?.trim() || error.message;
        reject(new Error(detail));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * 限流版 GMGN CLI 调用：全局长列队串行化 + 1s 间隔，防止多代币共振时并发超限。
 */
function gmgnCli(args: string): Promise<string> {
  const run = gmgnQueue.then(async () => {
    // 确保距上次调用至少 1s
    const elapsed = Date.now() - lastGmgnCallMs;
    if (elapsed < GMGN_MIN_INTERVAL_MS) {
      await delay(GMGN_MIN_INTERVAL_MS - elapsed);
    }
    const result = await execGmgnRaw(args);
    lastGmgnCallMs = Date.now();
    return result;
  });
  // 链接队列，失败也不阻塞后续调用
  gmgnQueue = run.then(() => undefined, () => undefined);
  return run;
}

// ── BNB/USD 价格 ──

let cachedBnbUsd: { price: number; fetchedAt: number } | null = null;
const BNB_CACHE_MS = 30_000; // 30 秒缓存

async function getBnbUsdPrice(): Promise<number> {
  if (cachedBnbUsd && Date.now() - cachedBnbUsd.fetchedAt < BNB_CACHE_MS) {
    return cachedBnbUsd.price;
  }

  try {
    const resp = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT");
    const data = (await resp.json()) as { price: string };
    const price = parseFloat(data.price);
    cachedBnbUsd = { price, fetchedAt: Date.now() };
    return price;
  } catch {
    const resp = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd");
    const data = (await resp.json()) as { binancecoin: { usd: number } };
    const price = data.binancecoin.usd;
    cachedBnbUsd = { price, fetchedAt: Date.now() };
    return price;
  }
}

// ── 延迟 ──

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 配置持久化 ──

export function loadGmgnConfig(): GmgnOrderConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<GmgnOrderConfig>;
      return { ...DEFAULT_GMGN_CONFIG, ...parsed };
    }
  } catch (err) {
    console.error("[GmgnOrders] 配置加载失败:", err);
  }
  return { ...DEFAULT_GMGN_CONFIG };
}

export function saveGmgnConfig(config: GmgnOrderConfig): void {
  try {
    if (!existsSync(LOGS_DIR)) {
      const { mkdirSync } = require("node:fs");
      mkdirSync(LOGS_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  } catch (err) {
    console.error("[GmgnOrders] 配置保存失败:", err);
  }
}

// ── 挂单引擎 ──

export class GmgnOrderEngine {
  private config: GmgnOrderConfig;

  constructor(config?: GmgnOrderConfig) {
    this.config = config ?? loadGmgnConfig();
  }

  getConfig(): GmgnOrderConfig {
    return { ...this.config };
  }

  setConfig(config: GmgnOrderConfig): void {
    this.config = config;
    saveGmgnConfig(config);
  }

  /**
   * 创建 3 个挂单（1 止损 + 2 止盈），异步执行，不阻塞主链路。
   */
  async createOrders(params: {
    tokenAddress: string;
    walletAddress: string;
    buyPriceBnb: string;
    tokenBalance: string;
    config?: GmgnOrderConfig;
  }): Promise<GmgnOrderResult[]> {
    const cfg = params.config ?? this.config;
    const buyPriceBnbNum = parseFloat(params.buyPriceBnb);
    const balance = BigInt(params.tokenBalance);

    if (buyPriceBnbNum <= 0 || balance === 0n) {
      console.log("[GmgnOrders] 跳过：价格或余额为零");
      return [];
    }

    // 获取 BNB/USD 价格
    const bnbUsd = await getBnbUsdPrice();
    const buyPriceUsd = buyPriceBnbNum * bnbUsd;
    const openPriceStr = buyPriceUsd.toFixed(12);

    console.log(`[GmgnOrders] BNB=$${bnbUsd.toFixed(2)} | 开仓价=$${openPriceStr} USD/token`);

    // 构建订单列表
    const orders = [
      {
        label: `止损 -${cfg.stopLossPercent}%`,
        subOrderType: "stop_loss" as const,
        multiplier: 1 - cfg.stopLossPercent / 100,
        sellPercent: 100,
      },
      {
        label: `止盈 +${cfg.takeProfit1Percent}%`,
        subOrderType: "take_profit" as const,
        multiplier: 1 + cfg.takeProfit1Percent / 100,
        sellPercent: cfg.takeProfit1Ratio,
      },
      {
        label: `止盈 +${cfg.takeProfit2Percent}%`,
        subOrderType: "take_profit" as const,
        multiplier: 1 + cfg.takeProfit2Percent / 100,
        sellPercent: cfg.takeProfit2Ratio,
      },
    ];

    const results: GmgnOrderResult[] = [];

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i]!;
      const checkPriceUsd = buyPriceUsd * order.multiplier;
      const checkPriceStr = checkPriceUsd.toFixed(12);
      const sellAmount = (balance * BigInt(order.sellPercent)) / 100n;

      // 方向校验
      if (order.subOrderType === "take_profit" && checkPriceUsd <= buyPriceUsd) {
        results.push({
          orderId: "", subOrderType: order.subOrderType, label: order.label,
          checkPriceUsd: checkPriceStr, amount: sellAmount.toString(),
          sellPercent: order.sellPercent, status: "failed", error: "止盈价 <= 开仓价",
        });
        continue;
      }
      if (order.subOrderType === "stop_loss" && checkPriceUsd >= buyPriceUsd) {
        results.push({
          orderId: "", subOrderType: order.subOrderType, label: order.label,
          checkPriceUsd: checkPriceStr, amount: sellAmount.toString(),
          sellPercent: order.sellPercent, status: "failed", error: "止损价 >= 开仓价",
        });
        continue;
      }

      const args = [
        "order", "strategy", "create",
        "--chain", "bsc",
        "--from", params.walletAddress,
        "--base-token", params.tokenAddress,
        "--quote-token", NATIVE_TOKEN,
        "--order-type", "limit_order",
        "--sub-order-type", order.subOrderType,
        "--open-price", openPriceStr,
        "--check-price", checkPriceStr,
        "--amount-in", sellAmount.toString(),
        "--slippage", SLIPPAGE,
        "--gas-price", "0.1",
        "--raw",
      ].join(" ");

      try {
        const output = await gmgnCli(args);
        const parsed = JSON.parse(output);
        const orderId = parsed.order_id || parsed.id || "unknown";
        console.log(`[GmgnOrders] ✅ ${order.label}: order_id=${orderId}`);
        results.push({
          orderId, subOrderType: order.subOrderType, label: order.label,
          checkPriceUsd: checkPriceStr, amount: sellAmount.toString(),
          sellPercent: order.sellPercent, status: "created",
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        // 检查是否 GMGN 实际已成功
        if (errMsg.includes("order_id")) {
          console.log(`[GmgnOrders] ⚠️ ${order.label}: 已创建但解析出错`);
          results.push({
            orderId: "unknown", subOrderType: order.subOrderType, label: order.label,
            checkPriceUsd: checkPriceStr, amount: sellAmount.toString(),
            sellPercent: order.sellPercent, status: "created",
          });
        } else {
          console.error(`[GmgnOrders] ❌ ${order.label}: ${errMsg.slice(0, 200)}`);
          results.push({
            orderId: "", subOrderType: order.subOrderType, label: order.label,
            checkPriceUsd: checkPriceStr, amount: sellAmount.toString(),
            sellPercent: order.sellPercent, status: "failed", error: errMsg.slice(0, 300),
          });
        }
      }

      // 限速已由 gmgnCli 全局队列处理（1s 间隔），无需额外延迟
    }

    return results;
  }

  /**
   * 查询当前挂单列表。
   */
  async listOrders(walletAddress: string): Promise<GmgnOrderInfo[]> {
    try {
      const output = await gmgnCli(
        `order strategy list --chain bsc --from ${walletAddress} --group-tag LimitOrder --raw`
      );
      const parsed = JSON.parse(output);
      if (!parsed.list?.length) return [];

      return parsed.list.map((o: Record<string, unknown>) => ({
        orderId: (o.order_id || o.id || "") as string,
        type: (o.sub_order_type || o.order_type || "unknown") as GmgnOrderInfo["type"],
        label: "",
        checkPriceUsd: (o.check_price || "") as string,
        amount: (o.amount_in || "") as string,
        sellPercent: 0,
        status: (o.status || "unknown") as GmgnOrderInfo["status"],
        createdAtMs: (o.created_at ? new Date(o.created_at as string).getTime() : Date.now()),
      }));
    } catch (e) {
      console.error("[GmgnOrders] 查询挂单失败:", e instanceof Error ? e.message : String(e));
      return [];
    }
  }

  /**
   * 取消单个挂单。
   */
  async cancelOrder(walletAddress: string, orderId: string): Promise<void> {
    try {
      await gmgnCli(
        `order strategy cancel --chain bsc --from ${walletAddress} --order-id ${orderId} --raw`
      );
      console.log(`[GmgnOrders] 已取消: ${orderId}`);
    } catch (e) {
      console.error(`[GmgnOrders] 取消失败 ${orderId}:`, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /**
   * 信心检查失败后的立即卖出：取消所有挂单 + 直接市价 swap 卖出 100%
   */
  async immediateSell(params: {
    tokenAddress: string;
    walletAddress: string;
    buyPriceBnb: string;
    tokenBalance: string;
    existingOrderIds: string[];
  }): Promise<GmgnOrderResult | null> {
    // 1. 取消所有现有挂单
    for (const oid of params.existingOrderIds) {
      try {
        await this.cancelOrder(params.walletAddress, oid);
      } catch { /* 可能已触发或已过期 */ }
    }

    if (params.existingOrderIds.length > 0) {
      await delay(1000); // 等待 GMGN 处理取消
    }

    // 2. 直接市价 swap 卖出 100%（立即执行，不等条件）
    const nativeToken = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"; // BNB
    const args = `swap --chain bsc --from ${params.walletAddress} --input-token ${params.tokenAddress} --output-token ${nativeToken} --percent 100 --slippage 20 --gas-price 0.5 --raw`;

    try {
      const output = await gmgnCli(args);
      const parsed = JSON.parse(output);
      // swap 返回的是交易信息，不是 order_id
      const txHash = parsed.tx_hash || parsed.hash || "";
      console.log(`[GmgnOrders] ✅ 信心检查市价卖出已执行: tx=${txHash}`);
      return {
        orderId: txHash || "swap_executed",
        subOrderType: "market_sell",
        label: "信心检查市价卖出",
        checkPriceUsd: "market",
        amount: params.tokenBalance,
        sellPercent: 100,
        status: "triggered", // 已执行
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[GmgnOrders] ❌ 信心检查市价卖出失败: ${errMsg.slice(0, 200)}`);
      return null;
    }
  }

  /**
   * 取消指定持仓的所有挂单，然后用新参数重建。
   */
  async replaceOrders(params: {
    positionId: string;
    tokenAddress: string;
    walletAddress: string;
    buyPriceBnb: string;
    tokenBalance: string;
    config: GmgnOrderConfig;
    existingOrderIds: string[];
  }): Promise<GmgnOrderResult[]> {
    // 先取消旧单
    for (const oid of params.existingOrderIds) {
      try {
        await this.cancelOrder(params.walletAddress, oid);
      } catch { /* 可能已触发或已过期 */ }
    }

    // 等待 GMGN 处理取消
    await delay(1000);

    // 用新参数创建
    return this.createOrders({
      tokenAddress: params.tokenAddress,
      walletAddress: params.walletAddress,
      buyPriceBnb: params.buyPriceBnb,
      tokenBalance: params.tokenBalance,
      config: params.config,
    });
  }
}

// ── 全局单例 ──

export const gmgnOrderEngine = new GmgnOrderEngine();
