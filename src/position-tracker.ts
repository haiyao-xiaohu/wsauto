/**
 * 持仓管理模块
 *
 * 跟踪所有买入的代币仓位，供自动卖出模块使用。
 * 持仓持久化到 logs/positions.json，重启后自动恢复。
 * 交易日志追加到 logs/trades.jsonl，永久留存。
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { SwapRoute } from "./bsc-swap-builder.js";
import type { RobSwapRoute } from "./rob-swap-builder.js";
import type { GmgnOrderInfo } from "./gmgn-orders.js";

// ── 日志目录 ──

const LOGS_DIR = path.resolve(process.cwd(), "logs");
const POSITIONS_FILE = path.join(LOGS_DIR, "positions.json");
const TRADES_FILE = path.join(LOGS_DIR, "trades.jsonl");

function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
}

// ── 持仓类型 ──

export interface Position {
  /** 唯一标识 */
  id: string;
  /** 链标识: bsc 或 rob */
  chain?: "bsc" | "rob";
  /** 代币地址 */
  tokenAddress: string;
  /** 交易平台 */
  platform: "fourmeme" | "flap" | "okx_dex" | "flap_rob" | "uniswap_v3";
  /** 买入交易哈希 */
  buyTxHash: string;
  /** 买入时间 */
  boughtAtMs: number;
  /** 买入花费的 BNB (wei) */
  costBnb: bigint;
  /** 获得的代币数量 (wei) */
  tokenAmount: bigint;
  /** 当前剩余代币数量 (wei) */
  remainingAmount: bigint;
  /** 买入价格（每代币 BNB，wei） */
  entryPrice: bigint;
  /** 状态 */
  status: "active" | "take_profit_done" | "stop_loss_done" | "sold";
  /** 共振触发的钱包列表（按信号顺序） */
  resonanceWallets?: string[];
  /** 已执行的操作记录 */
  actions: PositionAction[];
  /** GMGN 挂单信息 */
  gmgnOrders?: GmgnOrderInfo[];
}

export interface PositionAction {
  type: "buy" | "take_profit" | "stop_loss" | "manual_sell";
  txHash?: string;
  amount: bigint;
  price?: bigint;
  executedAtMs: number;
}

// ── 序列化/反序列化（bigint ↔ string） ──

function serializePosition(p: Position): object {
  return {
    ...p,
    costBnb: p.costBnb.toString(),
    tokenAmount: p.tokenAmount.toString(),
    remainingAmount: p.remainingAmount.toString(),
    entryPrice: p.entryPrice.toString(),
    actions: p.actions.map((a) => ({
      ...a,
      amount: a.amount.toString(),
      ...(a.price !== undefined ? { price: a.price.toString() } : {}),
    })),
    ...(p.gmgnOrders ? { gmgnOrders: p.gmgnOrders } : {}),
  };
}

function deserializePosition(raw: Record<string, unknown>): Position {
  // 推断链: 如果没有 chain 字段，从 platform 推断
  const platform = raw.platform as string;
  const inferredChain = (raw.chain as string | undefined)
    ?? (platform === "flap_rob" || platform === "uniswap_v3" ? "rob" : "bsc");
  return {
    id: raw.id as string,
    chain: inferredChain as "bsc" | "rob",
    tokenAddress: raw.tokenAddress as string,
    platform: raw.platform as Position["platform"],
    buyTxHash: raw.buyTxHash as string,
    boughtAtMs: raw.boughtAtMs as number,
    costBnb: BigInt(raw.costBnb as string),
    tokenAmount: BigInt(raw.tokenAmount as string),
    remainingAmount: BigInt(raw.remainingAmount as string),
    entryPrice: BigInt(raw.entryPrice as string),
    status: raw.status as Position["status"],
    ...((raw.resonanceWallets as string[] | undefined)?.length
      ? { resonanceWallets: raw.resonanceWallets as string[] }
      : {}),
    actions: (raw.actions as Record<string, unknown>[]).map((a) => ({
      type: a.type as PositionAction["type"],
      ...(a.txHash ? { txHash: a.txHash as string } : {}),
      amount: BigInt(a.amount as string),
      ...(a.price !== undefined ? { price: BigInt(a.price as string) } : {}),
      executedAtMs: a.executedAtMs as number,
    })),
    ...(raw.gmgnOrders ? { gmgnOrders: raw.gmgnOrders as GmgnOrderInfo[] } : {}),
  };
}

// ── 持仓管理器 ──

export class PositionTracker {
  private readonly positions = new Map<string, Position>();
  private idCounter = 0;

  constructor() {
    this.loadFromDisk();
  }

  /**
   * 添加新持仓，并持久化。
   */
  addPosition(params: {
    tokenAddress: string;
    platform: SwapRoute | RobSwapRoute;
    tokenPlatform: string | null;
    buyTxHash: string;
    costBnb: bigint;
    tokenAmount: bigint;
    resonanceWallets?: string[];
    chain?: "bsc" | "rob";
  }): Position {
    const id = `pos_${++this.idCounter}_${Date.now()}`;
    const entryPrice = params.tokenAmount > 0n
      ? (params.costBnb * 10n ** 18n) / params.tokenAmount
      : 0n;

    const platform = this.normalizePlatform(params.platform, params.tokenPlatform);

    const now = Date.now();
    const position: Position = {
      id,
      tokenAddress: params.tokenAddress.toLowerCase(),
      ...(params.chain ? { chain: params.chain } : {}),
      platform,
      buyTxHash: params.buyTxHash,
      boughtAtMs: now,
      costBnb: params.costBnb,
      tokenAmount: params.tokenAmount,
      remainingAmount: params.tokenAmount,
      entryPrice,
      status: "active",
      ...(params.resonanceWallets?.length ? { resonanceWallets: params.resonanceWallets } : {}),
      actions: [
        {
          type: "buy",
          txHash: params.buyTxHash,
          amount: params.tokenAmount,
          price: entryPrice,
          executedAtMs: now,
        },
      ],
    };

    this.positions.set(id, position);
    this.saveToDisk();
    this.appendTrade({
      time: new Date(now).toISOString(),
      type: "buy",
      positionId: id,
      tokenAddress: position.tokenAddress,
      platform,
      txHash: params.buyTxHash,
      costBnb: params.costBnb.toString(),
      tokenAmount: params.tokenAmount.toString(),
      entryPrice: entryPrice.toString(),
    });
    return position;
  }

  /**
   * 获取所有持仓（包括已卖出的）。
   */
  getPositions(): Position[] {
    return [...this.positions.values()];
  }

  /**
   * 获取所有活跃持仓。
   */
  getActivePositions(): Position[] {
    return [...this.positions.values()].filter((p) => p.status === "active");
  }

  /**
   * 根据代币地址获取活跃持仓。
   */
  getActivePositionByToken(tokenAddress: string): Position | undefined {
    const target = tokenAddress.toLowerCase();
    return [...this.positions.values()].find(
      (p) => p.tokenAddress === target && p.status === "active",
    );
  }

  /**
   * 统计某个代币的总买入次数（包括已卖出的）。
   */
  getBuyCount(tokenAddress: string): number {
    const target = tokenAddress.toLowerCase();
    return [...this.positions.values()].filter(
      (p) => p.tokenAddress === target,
    ).length;
  }

  /**
   * 获取某个代币的最后一次买入时间。
   */
  getLastBuyTime(tokenAddress: string): number | null {
    const target = tokenAddress.toLowerCase();
    const positions = [...this.positions.values()]
      .filter((p) => p.tokenAddress === target)
      .sort((a, b) => b.boughtAtMs - a.boughtAtMs);
    return positions[0]?.boughtAtMs ?? null;
  }

  /**
   * 根据 ID 获取持仓。
   */
  getPosition(id: string): Position | undefined {
    return this.positions.get(id);
  }

  /**
   * 记录止盈操作（卖出 50%）。
   */
  recordTakeProfit(id: string, txHash: string, amount: bigint, price: bigint): void {
    const position = this.positions.get(id);
    if (!position) return;

    position.remainingAmount -= amount;
    position.actions.push({
      type: "take_profit",
      txHash,
      amount,
      price,
      executedAtMs: Date.now(),
    });
    position.status = "take_profit_done";
    this.saveToDisk();
    this.appendTrade({
      time: new Date().toISOString(),
      type: "take_profit",
      positionId: id,
      tokenAddress: position.tokenAddress,
      platform: position.platform,
      txHash,
      amount: amount.toString(),
      price: price.toString(),
    });
  }

  /**
   * 记录止损操作（全部卖出）。
   */
  recordStopLoss(id: string, txHash: string, amount: bigint, price: bigint): void {
    const position = this.positions.get(id);
    if (!position) return;

    position.remainingAmount = 0n;
    position.actions.push({
      type: "stop_loss",
      txHash,
      amount,
      price,
      executedAtMs: Date.now(),
    });
    position.status = "stop_loss_done";
    this.saveToDisk();
    this.appendTrade({
      time: new Date().toISOString(),
      type: "stop_loss",
      positionId: id,
      tokenAddress: position.tokenAddress,
      platform: position.platform,
      txHash,
      amount: amount.toString(),
      price: price.toString(),
    });
  }

  /**
   * 记录手动卖出。
   */
  recordManualSell(id: string, txHash: string, amount: bigint, price?: bigint): void {
    const position = this.positions.get(id);
    if (!position) return;

    position.remainingAmount -= amount;
    if (position.remainingAmount <= 0n) {
      position.remainingAmount = 0n;
      position.status = "sold";
    }
    position.actions.push({
      type: "manual_sell",
      txHash,
      amount,
      ...(price !== undefined ? { price } : {}),
      executedAtMs: Date.now(),
    });
    this.saveToDisk();
    this.appendTrade({
      time: new Date().toISOString(),
      type: "manual_sell",
      positionId: id,
      tokenAddress: position.tokenAddress,
      platform: position.platform,
      txHash,
      amount: amount.toString(),
      ...(price !== undefined ? { price: price.toString() } : {}),
    });
  }

  /**
   * 获取所有持仓快照（用于 dashboard）。
   */
  snapshot(): Position[] {
    return [...this.positions.values()].sort(
      (a, b) => b.boughtAtMs - a.boughtAtMs,
    );
  }

  /**
   * 根据链上余额同步持仓剩余数量。
   * 余额为 0 时标记 sold，余额不足时修正 remainingAmount。
   * 返回该持仓是否仍然有效（未 sold）。
   */
  syncBalance(id: string, balance: bigint): boolean {
    const position = this.positions.get(id);
    if (!position) return false;
    if (balance === 0n) {
      position.remainingAmount = 0n;
      position.status = "sold";
    } else if (balance < position.remainingAmount) {
      position.remainingAmount = balance;
    }
    this.saveToDisk();
    return position.status !== "sold";
  }

  /**
   * 保存 GMGN 挂单信息到持仓。
   */
  setGmgnOrders(positionId: string, orders: GmgnOrderInfo[]): void {
    const position = this.positions.get(positionId);
    if (!position) return;
    position.gmgnOrders = orders;
    this.saveToDisk();
  }

  /**
   * 更新某个挂单的状态。
   */
  updateGmgnOrderStatus(positionId: string, orderId: string, status: GmgnOrderInfo["status"]): void {
    const position = this.positions.get(positionId);
    if (!position?.gmgnOrders) return;
    const order = position.gmgnOrders.find((o) => o.orderId === orderId);
    if (order) {
      order.status = status;
      this.saveToDisk();
    }
  }

  // ── 持久化 ──

  private saveToDisk(): void {
    try {
      ensureLogsDir();
      const data = [...this.positions.values()].map(serializePosition);
      writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.error("[PositionTracker] 持仓保存失败:", err);
    }
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(POSITIONS_FILE)) return;
      const raw = readFileSync(POSITIONS_FILE, "utf8").trim();
      if (!raw) return;
      const data = JSON.parse(raw) as Record<string, unknown>[];
      for (const item of data) {
        const pos = deserializePosition(item);
        this.positions.set(pos.id, pos);
        // 同步 idCounter，避免 ID 冲突
        const num = parseInt(pos.id.split("_")[1] ?? "0", 10);
        if (num > this.idCounter) this.idCounter = num;
      }
      console.log(`[PositionTracker] 从磁盘恢复 ${this.positions.size} 条持仓`);
    } catch (err) {
      console.error("[PositionTracker] 持仓加载失败:", err);
    }
  }

  private appendTrade(record: Record<string, unknown>): void {
    try {
      ensureLogsDir();
      appendFileSync(TRADES_FILE, JSON.stringify(record) + "\n", "utf8");
    } catch (err) {
      console.error("[PositionTracker] 交易日志写入失败:", err);
    }
  }

  private normalizePlatform(route: SwapRoute | RobSwapRoute, _tokenPlatform: string | null): "fourmeme" | "flap" | "okx_dex" | "flap_rob" | "uniswap_v3" {
    // 卖出路由由买入路由决定：走哪个 router 买入，就走哪个 router 卖出
    switch (route) {
      case "fourmeme_inner":
        return "fourmeme";
      case "flap_inner":
        return "flap";
      case "flap_rob_inner":
        return "flap_rob";
      case "uniswap_v3":
        return "uniswap_v3";
      default:
        return "okx_dex";
    }
  }
}

// ── 全局单例 ──

export const positionTracker = new PositionTracker();
