/**
 * 运行时配置模块
 *
 * 从 logs/runtime-config.json 读取配置，支持热更新（不重启服务）。
 * 优先级：runtime-config.json > 环境变量 > 默认值
 *
 * 支持的配置项：
 *   - gasPriceGwei: 全局 gas price（默认 0.1 Gwei）
 *   - gasPriceByRoute: 按路由配置 gas price
 *   - maxGasCostBnb: 单笔最大 gas 费用上限
 *   - buySlippagePercent: 买入滑点（默认 5%）
 *   - sellSlippagePercent: 卖出滑点（默认 5%）
 *   - orderAmountBnb: 单笔买入金额
 *   - evmPrivateKey: 执行器私钥
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.resolve(process.cwd(), "logs/runtime-config.json");

interface RuntimeConfigData {
  gasPriceGwei?: string;
  gasPriceByRoute?: {
    fourmeme_inner?: string;
    flap_inner?: string;
    okx_dex?: string;
  };
  maxGasCostBnb?: string;
  buySlippagePercent?: string;
  sellSlippagePercent?: string;
  orderAmountBnb?: string;
  evmPrivateKey?: string;
  // 狙击模式配置
  sniperGasPriceGwei?: string;
  sniperSlippagePercent?: string;
  sniperOrderAmountBnb?: string;
  sniperCooldownSeconds?: number;
  // 二次买入冷却（秒），第1次→第2次间隔，默认 600（10分钟）
  secondBuyCooldownSeconds?: number;
  // 默认买入冷却（秒），第2次→第3次间隔，默认 600（10分钟）
  defaultCooldownSeconds?: number;
  // 共振触发限流（秒），全局限流，默认 4 秒内只触发一次买入
  resonanceTriggerThrottleSeconds?: number;
  // 信心检查（秒），共振买入后 N 秒内无其他钱包跟进则立即卖出，默认 10，0=禁用
  confidenceCheckSeconds?: number;
  [key: string]: unknown;
}

let cached: RuntimeConfigData | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 2_000; // 2 秒缓存

function load(): RuntimeConfigData {
  const now = Date.now();
  if (cached && now - cacheTime < CACHE_TTL_MS) return cached;
  try {
    if (existsSync(CONFIG_PATH)) {
      cached = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      cacheTime = now;
      return cached!;
    }
  } catch {
    // 配置损坏时用空对象
  }
  cached = {};
  cacheTime = now;
  return cached;
}

export function save(data: RuntimeConfigData): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
  cached = data;
  cacheTime = Date.now();
}

export function getAll(): RuntimeConfigData {
  return { ...load() };
}

export function getGasPriceGwei(route?: string): string {
  const cfg = load();
  // 先查路由级别
  if (route && cfg.gasPriceByRoute) {
    const routeKey = route as keyof NonNullable<RuntimeConfigData["gasPriceByRoute"]>;
    const routePrice = cfg.gasPriceByRoute[routeKey];
    if (routePrice) return routePrice;
  }
  // 再查全局
  return cfg.gasPriceGwei || "0.1";
}

export function getMaxGasCostBnb(): string {
  return load().maxGasCostBnb || "0.000084";
}

export function getBuySlippagePercent(): string {
  return load().buySlippagePercent || "5";
}

export function getSellSlippagePercent(): string {
  return load().sellSlippagePercent || "5";
}

export function getOrderAmountBnb(): string | undefined {
  return load().orderAmountBnb;
}

export function getEvmPrivateKey(): string | undefined {
  return load().evmPrivateKey?.trim();
}

// ── 狙击模式配置 ──

export function getSniperGasPriceGwei(route?: string): string {
  const cfg = load();
  // 狙击优先用狙击专用 gas，否则回退到普通 gas
  if (cfg.sniperGasPriceGwei) return cfg.sniperGasPriceGwei;
  return getGasPriceGwei(route);
}

export function getSniperSlippagePercent(): string {
  return load().sniperSlippagePercent || "30";
}

export function getSniperOrderAmountBnb(): string {
  return load().sniperOrderAmountBnb || load().orderAmountBnb || "0.01";
}

export function getSniperCooldownSeconds(): number {
  return load().sniperCooldownSeconds ?? 600;
}

export function getSecondBuyCooldownSeconds(): number {
  return load().secondBuyCooldownSeconds ?? 600;
}

export function getDefaultCooldownSeconds(): number {
  return load().defaultCooldownSeconds ?? 600;
}

export function getResonanceThrottleSeconds(): number {
  return load().resonanceTriggerThrottleSeconds ?? 4;
}

export function getConfidenceCheckSeconds(): number {
  return load().confidenceCheckSeconds ?? 10;
}
