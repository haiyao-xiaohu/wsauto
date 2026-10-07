import { readFileSync } from "node:fs";
import path from "node:path";

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

function positiveNumberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} 必须是正数`);
  }
  return value;
}

export function parseWalletList(raw: string | undefined, envName = "WALLET_LIST"): Set<string> {
  if (!raw?.trim()) return new Set();
  const wallets = raw
    .split(/[\s,;]+/)
    .map((wallet) => wallet.trim().toLowerCase())
    .filter(Boolean);
  for (const wallet of wallets) {
    if (!ADDRESS_PATTERN.test(wallet)) {
      throw new Error(`${envName} 包含无效地址：${wallet}`);
    }
  }
  return new Set(wallets);
}

export function getResonanceConfig() {
  // 支持两种方式配置监控錢包：
  // 1. BSC_WATCH_WALLETS — 逗号/空格分隔的地址字符串
  // 2. WALLET_LIST_PATH  — 指向一个每行一个地址的文本文件
  // 两者同时配置时会合并。
  const watchedWallets = parseWalletList(process.env.BSC_WATCH_WALLETS, "BSC_WATCH_WALLETS");
  const walletListPath = process.env.WALLET_LIST_PATH?.trim();
  if (walletListPath) {
    const filePath = path.resolve(process.cwd(), walletListPath);
    const raw = readFileSync(filePath, "utf8");
    const fileWallets = raw
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean);
    const beforeSize = watchedWallets.size;
    for (const wallet of fileWallets) {
      if (!ADDRESS_PATTERN.test(wallet)) {
        throw new Error(`WALLET_LIST_PATH 文件包含无效地址：${wallet}`);
      }
      watchedWallets.add(wallet);
    }
    const added = watchedWallets.size - beforeSize;
    console.log(
      `WALLET_LIST_PATH: loaded ${added} wallets (${fileWallets.length - added} duplicates skipped) from ${filePath}`,
    );
  }

  return {
    threshold: positiveIntegerFromEnv("RESONANCE_THRESHOLD", 2),
    windowMs:
      positiveIntegerFromEnv("RESONANCE_WINDOW_SECONDS", 30) * 1_000,
    cooldownMs:
      positiveIntegerFromEnv("RESONANCE_COOLDOWN_SECONDS", 600) * 1_000,
    secondBuyCooldownMs:
      positiveIntegerFromEnv("RESONANCE_SECOND_COOLDOWN_SECONDS", 600) * 1_000,
    maxSignalAgeMs:
      positiveIntegerFromEnv("MAX_SIGNAL_AGE_SECONDS", 15) * 1_000,
    watchedWallets,
    buildSwapOnTrigger: process.env.RESONANCE_BUILD_SWAP === "true",
    orderAmountBnb: process.env.RESONANCE_ORDER_AMOUNT_BNB?.trim() || "0.001",
    slippagePercent:
      process.env.RESONANCE_SLIPPAGE_PERCENT?.trim() || "1",
    webhookHost: process.env.WEBHOOK_HOST?.trim() || "127.0.0.1",
    webhookPort: positiveIntegerFromEnv("WEBHOOK_PORT", 8080),
    maxBodyBytes: positiveIntegerFromEnv(
      "WEBHOOK_MAX_BODY_BYTES",
      5 * 1024 * 1024,
    ),
    maxOrderAmountBnb: positiveNumberFromEnv(
      "RESONANCE_MAX_ORDER_AMOUNT_BNB",
      0.01,
    ),
    maxBuyCount: positiveIntegerFromEnv("MAX_BUY_COUNT", 3),
  };
}

/**
 * Rob 链独立共振引擎配置。
 * 读取 ROB_WATCH_WALLETS / ROB_WALLET_LIST_PATH，以及独立的阈値/窗口/冷却参数。
 */
export function getRobResonanceConfig() {
  // 1. ROB_WATCH_WALLETS — 逗号/空格分隔的地址字符串
  // 2. ROB_WALLET_LIST_PATH — 指向文本文件（每行一个地址）
  const watchedWallets = parseWalletList(process.env.ROB_WATCH_WALLETS, "ROB_WATCH_WALLETS");
  const walletListPath = process.env.ROB_WALLET_LIST_PATH?.trim();
  if (walletListPath) {
    const filePath = path.resolve(process.cwd(), walletListPath);
    const raw = readFileSync(filePath, "utf8");
    const fileWallets = raw
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean);
    const beforeSize = watchedWallets.size;
    for (const wallet of fileWallets) {
      if (!ADDRESS_PATTERN.test(wallet)) {
        throw new Error(`ROB_WALLET_LIST_PATH 文件包含无效地址：${wallet}`);
      }
      watchedWallets.add(wallet);
    }
    const added = watchedWallets.size - beforeSize;
    console.log(
      `ROB_WALLET_LIST_PATH: loaded ${added} wallets (${fileWallets.length - added} duplicates skipped) from ${filePath}`,
    );
  }

  return {
    threshold: positiveIntegerFromEnv("ROB_RESONANCE_THRESHOLD", 2),
    windowMs:
      positiveIntegerFromEnv("ROB_RESONANCE_WINDOW_SECONDS", 30) * 1_000,
    cooldownMs:
      positiveIntegerFromEnv("ROB_RESONANCE_COOLDOWN_SECONDS", 600) * 1_000,
    maxSignalAgeMs:
      positiveIntegerFromEnv("MAX_SIGNAL_AGE_SECONDS", 15) * 1_000, // 共用
    watchedWallets,
    buildSwapOnTrigger: process.env.WEBHOOK_ROB_LIVE_TRADING === "true",
    orderAmountEth: process.env.ROB_RESONANCE_ORDER_AMOUNT_ETH?.trim() || "0.0001",
    maxBuyCount: positiveIntegerFromEnv("MAX_BUY_COUNT", 3), // 共用
  };
}
