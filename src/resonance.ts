import type { BscBuySignal } from "./signals/bsc.js";
import type { RobBuySignal } from "./signals/rob.js";
import { hasExcludedCombo } from "./excluded-combos.js";
import { isDevWallet } from "./dev-wallets.js";

/** 通用买入信号类型，兼容 BSC 和 Rob 链 */
export type BuySignal = BscBuySignal | RobBuySignal;

export interface ResonanceOptions {
  threshold: number;
  windowMs: number;
  cooldownMs: number;
  watchedWallets?: ReadonlySet<string>;
  /** 返回当前代币的冷却倍数（基于买入次数等），默认 1 */
  cooldownMultiplier?: (tokenAddress: string) => number;
  /** 返回绝对冷却时间（ms），优先级高于 cooldownMultiplier */
  cooldownOverride?: (tokenAddress: string) => number | undefined;
  /** 狙击模式独立冷却时间（ms），默认同 cooldownMs */
  sniperCooldownMs?: number;
}

export interface ResonanceTrigger {
  /** chainId: 56=BSC, 4663=Rob链 */
  chainId: number;
  tokenAddress: string;
  triggeredAtMs: number;
  signals: BuySignal[];
  isSniper: boolean;
}

export interface ResonanceWindowSnapshot {
  tokenAddress: string;
  walletCount: number;
  signals: BuySignal[];
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  expiresAtMs: number;
}

export interface ResonanceEngineSnapshot {
  windows: ResonanceWindowSnapshot[];
  cooldowns: Array<{
    tokenAddress: string;
    cooldownUntilMs: number;
  }>;
}

export type ResonanceDecisionReason =
  | "accepted"
  | "blacklisted"
  | "blacklisted_token"
  | "cooldown"
  | "duplicate"
  | "not_watched"
  | "out_of_order_stale"
  | "excluded_combo"
  | "sniper"
  | "triggered";

export interface ResonanceDecision {
  reason: ResonanceDecisionReason;
  uniqueWalletCount: number;
  trigger?: ResonanceTrigger;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
}

function normalizeWallets(
  wallets: ReadonlySet<string> | undefined,
): Set<string> | undefined {
  if (!wallets) return undefined;
  return new Set([...wallets].map((wallet) => wallet.toLowerCase()));
}

export class ResonanceEngine {
  private watchedWallets: Set<string> | undefined;
  private blacklistedWallets = new Set<string>();
  private tokenBlacklist = new Set<string>();
  private readonly windows = new Map<string, Map<string, BuySignal>>();
  private readonly latestTokenTimestamp = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly seenEvents = new Map<string, number>();

  constructor(
    private readonly options: ResonanceOptions,
    private readonly chainId: number = 56,
  ) {
    assertPositiveInteger("threshold", options.threshold);
    assertPositiveInteger("windowMs", options.windowMs);
    assertPositiveInteger("cooldownMs", options.cooldownMs);
    if (options.threshold < 2) {
      throw new Error("共振阈值至少为 2");
    }
    this.watchedWallets = normalizeWallets(options.watchedWallets);
  }

  // ── 动态钱包管理 ──

  setWatchedWallets(wallets: Set<string>): void {
    this.watchedWallets = wallets.size > 0
      ? new Set([...wallets].map((w) => w.toLowerCase()))
      : undefined;
  }

  addWatchedWallets(wallets: Set<string>): void {
    const lower = new Set([...wallets].map((w) => w.toLowerCase()));
    if (this.watchedWallets) {
      for (const w of lower) this.watchedWallets.add(w);
    } else {
      this.watchedWallets = lower;
    }
  }

  getWatchedWallets(): Set<string> {
    return this.watchedWallets ? new Set(this.watchedWallets) : new Set();
  }

  setBlacklistedWallets(wallets: Set<string>): void {
    this.blacklistedWallets = new Set([...wallets].map((w) => w.toLowerCase()));
  }

  addBlacklistedWallets(wallets: Set<string>): void {
    for (const w of wallets) this.blacklistedWallets.add(w.toLowerCase());
  }

  getBlacklistedWallets(): Set<string> {
    return new Set(this.blacklistedWallets);
  }

  // ── 代币黑名单 ──

  setTokenBlacklist(tokens: Set<string>): void {
    this.tokenBlacklist = new Set([...tokens].map((t) => t.toLowerCase()));
  }

  addBlacklistedToken(token: string): void {
    this.tokenBlacklist.add(token.toLowerCase());
  }

  removeBlacklistedToken(token: string): void {
    this.tokenBlacklist.delete(token.toLowerCase());
  }

  isTokenBlacklisted(token: string): boolean {
    return this.tokenBlacklist.has(token.toLowerCase());
  }

  getBlacklistedTokens(): Set<string> {
    return new Set(this.tokenBlacklist);
  }

  ingest(input: BuySignal): ResonanceDecision {
    const signal: BuySignal = {
      ...input,
      tokenAddress: input.tokenAddress.toLowerCase(),
      walletAddress: input.walletAddress.toLowerCase(),
      txHash: input.txHash.toLowerCase(),
    };
    const eventId = `${signal.txHash}:${signal.tokenAddress}`;

    if (this.seenEvents.has(eventId)) {
      return { reason: "duplicate", uniqueWalletCount: 0 };
    }

    this.seenEvents.set(eventId, signal.blockTimestampMs);
    this.pruneSeenEvents(signal.blockTimestampMs);

    if (this.tokenBlacklist.has(signal.tokenAddress)) {
      return { reason: "blacklisted_token", uniqueWalletCount: 0 };
    }

    if (
      this.watchedWallets &&
      !this.watchedWallets.has(signal.walletAddress)
    ) {
      return { reason: "not_watched", uniqueWalletCount: 0 };
    }

    if (this.blacklistedWallets.has(signal.walletAddress)) {
      return { reason: "blacklisted", uniqueWalletCount: 0 };
    }

    const latestTimestamp = Math.max(
      signal.blockTimestampMs,
      this.latestTokenTimestamp.get(signal.tokenAddress) ?? 0,
    );
    this.latestTokenTimestamp.set(signal.tokenAddress, latestTimestamp);

    if (signal.blockTimestampMs < latestTimestamp - this.options.windowMs) {
      return { reason: "out_of_order_stale", uniqueWalletCount: 0 };
    }

    const cooldownUntil = this.cooldownUntil.get(signal.tokenAddress) ?? 0;
    if (signal.blockTimestampMs < cooldownUntil) {
      return { reason: "cooldown", uniqueWalletCount: 0 };
    }

    const walletSignals =
      this.windows.get(signal.tokenAddress) ??
      new Map<string, BuySignal>();

    for (const [wallet, previous] of walletSignals) {
      if (previous.blockTimestampMs < latestTimestamp - this.options.windowMs) {
        walletSignals.delete(wallet);
      }
    }

    // 同一钱包重复买入只刷新时间，不增加共振计数。
    walletSignals.set(signal.walletAddress, signal);
    this.windows.set(signal.tokenAddress, walletSignals);

    // ── 狙击模式：dev 钱包买入立即触发，跳过阈值检查 ──
    if (isDevWallet(signal.walletAddress)) {
      const sniperSignals = [signal];
      const trigger: ResonanceTrigger = {
        chainId: this.chainId,
        tokenAddress: signal.tokenAddress,
        triggeredAtMs: signal.blockTimestampMs,
        signals: sniperSignals,
        isSniper: true,
      };

      // 狙击独立冷却
      const sniperBase = this.options.cooldownOverride?.(signal.tokenAddress)
        ?? (this.options.sniperCooldownMs ?? this.options.cooldownMs)
          * (this.options.cooldownMultiplier?.(signal.tokenAddress) ?? 1);
      this.cooldownUntil.set(
        signal.tokenAddress,
        signal.blockTimestampMs + sniperBase,
      );
      this.windows.delete(signal.tokenAddress);

      return {
        reason: "sniper",
        uniqueWalletCount: 1,
        trigger,
      };
    }

    if (walletSignals.size < this.options.threshold) {
      return {
        reason: "accepted",
        uniqueWalletCount: walletSignals.size,
      };
    }

    // 检查钱包组合是否被排除
    const participatingWallets = [...walletSignals.keys()];
    if (hasExcludedCombo(participatingWallets)) {
      return {
        reason: "excluded_combo",
        uniqueWalletCount: walletSignals.size,
      };
    }

    const resonanceSignals = [...walletSignals.values()]
      .sort((left, right) => left.blockTimestampMs - right.blockTimestampMs)
      .slice(0, this.options.threshold);
    const trigger: ResonanceTrigger = {
      chainId: this.chainId,
      tokenAddress: signal.tokenAddress,
      triggeredAtMs: signal.blockTimestampMs,
      signals: resonanceSignals,
      isSniper: false,
    };

    const finalCooldownMs = this.options.cooldownOverride?.(signal.tokenAddress)
      ?? this.options.cooldownMs * (this.options.cooldownMultiplier?.(signal.tokenAddress) ?? 1);
    this.cooldownUntil.set(
      signal.tokenAddress,
      signal.blockTimestampMs + finalCooldownMs,
    );
    this.windows.delete(signal.tokenAddress);

    return {
      reason: "triggered",
      uniqueWalletCount: resonanceSignals.length,
      trigger,
    };
  }

  snapshot(referenceTimestampMs = Date.now()): ResonanceEngineSnapshot {
    const windows: ResonanceWindowSnapshot[] = [];

    for (const [tokenAddress, walletSignals] of this.windows) {
      const activeSignals = [...walletSignals.values()]
        .filter(
          (signal) =>
            signal.blockTimestampMs >=
            referenceTimestampMs - this.options.windowMs,
        )
        .sort(
          (left, right) =>
            left.blockTimestampMs - right.blockTimestampMs,
        );
      const first = activeSignals[0];
      const last = activeSignals.at(-1);
      if (!first || !last) continue;

      windows.push({
        tokenAddress,
        walletCount: activeSignals.length,
        signals: activeSignals,
        firstSeenAtMs: first.blockTimestampMs,
        lastSeenAtMs: last.blockTimestampMs,
        expiresAtMs: first.blockTimestampMs + this.options.windowMs,
      });
    }

    const cooldowns = [...this.cooldownUntil]
      .filter(([, cooldownUntilMs]) => cooldownUntilMs > referenceTimestampMs)
      .map(([tokenAddress, cooldownUntilMs]) => ({
        tokenAddress,
        cooldownUntilMs,
      }))
      .sort(
        (left, right) => left.cooldownUntilMs - right.cooldownUntilMs,
      );

    return {
      windows: windows.sort(
        (left, right) => right.lastSeenAtMs - left.lastSeenAtMs,
      ),
      cooldowns,
    };
  }

  private pruneSeenEvents(referenceTimestampMs: number): void {
    const retentionMs = Math.max(
      this.options.windowMs,
      this.options.cooldownMs,
    );
    for (const [eventId, timestampMs] of this.seenEvents) {
      if (timestampMs < referenceTimestampMs - retentionMs) {
        this.seenEvents.delete(eventId);
      }
    }
  }
}
