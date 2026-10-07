import type {
  ResonanceDecisionReason,
  ResonanceEngine,
  ResonanceTrigger,
} from "./resonance.js";
import type { BscBuySignal } from "./signals/bsc.js";
import type { RobBuySignal } from "./signals/rob.js";
import {
  insertTrigger,
  updateSwapBuilt,
  updateBroadcasted,
  updateRejected,
} from "./trigger-store.js";

/** 通用信号类型（BSC 或 Rob 链） */
type BuySignal = BscBuySignal | RobBuySignal;

const MAX_RECENT_SIGNALS = 80;
const MAX_RECENT_TRIGGERS = 40;

/** Swap build result (flexible type for dashboard display) */
export interface SwapBuildResult {
  route: string; // 接受任何路由类型字符串
  tokenAddress?: string;
  reason: string;
  platform?: string | null;
  status?: string;
  progress?: number;
  chain?: string; // 标识是 bsc 还是 rob
  okx?: {
    fromToken?: string;
    toToken?: string;
    expectedToAmount?: string;
    priceImpact?: string;
    dexProtocol?: string;
    router?: string;
    latencyMs?: number;
  };
  fourmeme?: {
    estimatedAmount?: string;
    estimatedCost?: string;
    amountMsgValue?: string;
  };
  flap?: {
    estimatedOutput?: string;
    inputAmount?: string;
  };
  uniswap?: {
    amountIn?: string;
    tokenIn?: string;
    tokenOut?: string;
  };
  mode?: string;
  broadcast?: {
    txHash: string;
    fromAddress: string;
  };
}

export interface DashboardConfig {
  threshold: number;
  windowSeconds: number;
  cooldownSeconds: number;
  maxSignalAgeSeconds: number;
  walletFilter: string;
  signatureVerification: boolean;
  okxBuildOnTrigger: boolean;
  transactionBroadcast?: boolean;
  orderAmountBnb?: string;
  watchedWalletCount?: number;
  blacklistedWalletCount?: number;
  executorAddress?: string;
  autoSell?: {
    enabled: boolean;
    takeProfitPercent: number;
    takeProfitRatio: number;
    stopLossPercent: number;
    checkIntervalMs: number;
  };
  /** Rob 链配置（可选） */
  robConfig?: {
    threshold: number;
    windowSeconds: number;
    cooldownSeconds: number;
    transactionBroadcast: boolean;
    orderAmountEth?: string;
  };
}

export interface WalletBookEntry {
  name?: string;
  emoji?: string;
  groups?: string[];
}

type SignalRecord = BuySignal & {
  receivedAtMs: number;
  decision: ResonanceDecisionReason | "stale";
  chain: "bsc" | "rob";
}

interface TriggerRecord {
  id: string;
  tokenAddress: string;
  triggeredAtMs: number;
  deltaSeconds: number;
  wallets: string[];
  txHashes: string[];
  status: "detected" | "building" | "built" | "broadcasting" | "broadcasted" | "rejected";
  swap?: SwapBuildResult;
  error?: string;
  chain: "bsc" | "rob";
}

/** Position summary for dashboard (serializable) */
export interface PositionSnapshot {
  id: string;
  tokenAddress: string;
  platform: string;
  buyTxHash: string;
  boughtAtMs: number;
  costBnb: string;
  tokenAmount: string;
  remainingAmount: string;
  status: string;
  chain?: string;
  actions: Array<{
    type: string;
    txHash?: string | undefined;
    amount?: string | undefined;
    executedAtMs: number;
  }>;
  currentPricePercentChange?: number;
}

export class DashboardState {
  private readonly startedAtMs = Date.now();
  private webhookDeliveries = 0;
  private extractedSignals = 0;
  private acceptedSignals = 0;
  private staleSignals = 0;
  private triggerCount = 0;
  private okxBuiltCount = 0;
  private okxRejectedCount = 0;
  private lastWebhookAtMs: number | null = null;
  private readonly signals: SignalRecord[] = [];
  private readonly triggers: TriggerRecord[] = [];
  private positionsProvider: (() => PositionSnapshot[]) | null = null;

  constructor(
    private readonly config: DashboardConfig,
    private readonly engine: ResonanceEngine,
    private readonly walletBook: Record<string, WalletBookEntry> = {},
    private readonly displayWallets?: ReadonlySet<string>,
  ) {}

  /** Register a callback that returns current positions */
  setPositionsProvider(provider: () => PositionSnapshot[]): void {
    this.positionsProvider = provider;
  }

  recordSignal(
    signal: BuySignal,
    decision: ResonanceDecisionReason | "stale",
    receivedAtMs: number,
    chain: "bsc" | "rob" = "bsc",
  ): void {
    this.extractedSignals += 1;
    if (decision === "stale") this.staleSignals += 1;
    if (
      decision === "accepted" ||
      decision === "triggered" ||
      decision === "cooldown" ||
      decision === "duplicate"
    ) {
      this.acceptedSignals += 1;
    }
    // 如果配置了 displayWallets，只显示这些钱包的信号
    if (
      this.displayWallets &&
      !this.displayWallets.has(signal.walletAddress.toLowerCase())
    ) {
      return;
    }
    this.signals.unshift({ ...signal, receivedAtMs, decision, chain });
    this.signals.splice(MAX_RECENT_SIGNALS);
  }

  recordWebhook(receivedAtMs: number): void {
    this.webhookDeliveries += 1;
    this.lastWebhookAtMs = receivedAtMs;
  }

  recordTrigger(trigger: ResonanceTrigger, willBuildSwap: boolean, chain: "bsc" | "rob" = "bsc"): string {
    const signals = [...trigger.signals].sort(
      (left, right) => left.blockTimestampMs - right.blockTimestampMs,
    );
    const first = signals[0];
    const last = signals.at(-1);
    const id = `${trigger.tokenAddress}:${trigger.triggeredAtMs}`;
    this.triggerCount += 1;
    this.triggers.unshift({
      id,
      tokenAddress: trigger.tokenAddress,
      triggeredAtMs: trigger.triggeredAtMs,
      deltaSeconds:
        first && last
          ? (last.blockTimestampMs - first.blockTimestampMs) / 1_000
          : 0,
      wallets: signals.map((signal) => signal.walletAddress),
      txHashes: signals.map((signal) => signal.txHash),
      status: willBuildSwap ? "building" : "detected",
      chain,
    });
    this.triggers.splice(MAX_RECENT_TRIGGERS);
    // 持久化到 SQLite
    insertTrigger({
      id,
      chain,
      tokenAddress: trigger.tokenAddress,
      triggeredAtMs: trigger.triggeredAtMs,
      deltaSeconds:
        first && last
          ? (last.blockTimestampMs - first.blockTimestampMs) / 1_000
          : 0,
      wallets: signals.map((s) => s.walletAddress),
      txHashes: signals.map((s) => s.txHash),
      willBuildSwap,
    });
    return id;
  }

  recordSwapBuilt(id: string, swap: SwapBuildResult): void {
    const trigger = this.triggers.find((item) => item.id === id);
    if (!trigger) return;
    trigger.status = "built";
    trigger.swap = swap;
    this.okxBuiltCount += 1;
    updateSwapBuilt(id, swap);
  }

  recordSwapRejected(id: string, error: string): void {
    const trigger = this.triggers.find((item) => item.id === id);
    if (!trigger) return;
    trigger.status = "rejected";
    trigger.error = error;
    this.okxRejectedCount += 1;
    updateRejected(id, error);
  }

  recordBroadcasting(id: string): void {
    const trigger = this.triggers.find((item) => item.id === id);
    if (!trigger) return;
    trigger.status = "broadcasting";
  }

  recordBroadcasted(id: string, swap: SwapBuildResult): void {
    const trigger = this.triggers.find((item) => item.id === id);
    if (!trigger) return;
    trigger.status = "broadcasted";
    trigger.swap = swap;
    updateBroadcasted(id, swap);
  }

  snapshot(nowMs = Date.now()) {
    const engine = this.engine.snapshot(nowMs);
    const isLive = Boolean(this.config.transactionBroadcast);
    const positions = this.positionsProvider ? this.positionsProvider() : [];
    const watchedWallets = this.engine.getWatchedWallets();
    const blacklistedWallets = this.engine.getBlacklistedWallets();
    return {
      generatedAtMs: nowMs,
      startedAtMs: this.startedAtMs,
      mode: isLive ? "LIVE" : "DRY_RUN",
      chain: {
        id: 56,
        name: "BNB Smart Chain",
      },
      config: this.config,
      walletBook: this.walletBook,
      settings: {
        watchedWallets: [...watchedWallets],
        watchedWalletCount: watchedWallets.size,
        blacklistedWallets: [...blacklistedWallets],
        blacklistedWalletCount: blacklistedWallets.size,
        orderAmountBnb: this.config.orderAmountBnb || "0.01",
        executorAddress: this.config.executorAddress || "",
      },
      autoSell: this.config.autoSell
        ? {
            enabled: this.config.autoSell.enabled,
            takeProfitPercent: this.config.autoSell.takeProfitPercent,
            stopLossPercent: this.config.autoSell.stopLossPercent,
          }
        : null,
      robConfig: this.config.robConfig || null,
      metrics: {
        webhookDeliveries: this.webhookDeliveries,
        extractedSignals: this.extractedSignals,
        acceptedSignals: this.acceptedSignals,
        staleSignals: this.staleSignals,
        triggerCount: this.triggerCount,
        okxBuiltCount: this.okxBuiltCount,
        okxRejectedCount: this.okxRejectedCount,
        activeWindows: engine.windows.length,
        cooldownTokens: engine.cooldowns.length,
        lastWebhookAtMs: this.lastWebhookAtMs,
      },
      activeWindows: engine.windows,
      cooldowns: engine.cooldowns,
      recentSignals: this.signals,
      triggers: this.triggers,
      positions,
    };
  }
}
