import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Dev 钱包管理模块（狙击模式）
 *
 * Dev 钱包买入时跳过共振检测，立即触发狙击买入。
 * 存储在 logs/dev-wallets.json，格式：["0x...", "0x..."]
 */

const DEV_WALLETS_PATH = path.resolve("logs/dev-wallets.json");

interface CachedData {
  data: Set<string>;
  mtimeMs: number;
}

let cached: CachedData | null = null;
const CACHE_MS = 2000;

function ensureDir(): void {
  const dir = path.dirname(DEV_WALLETS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load(): Set<string> {
  try {
    const stat = fs.statSync(DEV_WALLETS_PATH);
    if (cached && stat.mtimeMs === cached.mtimeMs) {
      const age = Date.now() - cached.mtimeMs;
      if (age < CACHE_MS) return cached.data;
    }
    const raw = fs.readFileSync(DEV_WALLETS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const data = new Set<string>(
      parsed
        .filter((s: unknown): s is string => typeof s === "string")
        .map((s: string) => s.toLowerCase()),
    );
    cached = { data, mtimeMs: stat.mtimeMs };
    return data;
  } catch {
    return new Set();
  }
}

function saveWallets(wallets: Set<string>): void {
  ensureDir();
  const arr = [...wallets];
  fs.writeFileSync(DEV_WALLETS_PATH, JSON.stringify(arr, null, 2));
  cached = null;
}

/**
 * 检查是否为 dev 钱包
 */
export function isDevWallet(address: string): boolean {
  return load().has(address.toLowerCase());
}

/**
 * 获取所有 dev 钱包列表
 */
export function getAllDevWallets(): string[] {
  return [...load()];
}

/**
 * 添加 dev 钱包
 */
export function addDevWallet(address: string): boolean {
  const wallets = load();
  const lower = address.toLowerCase();
  if (wallets.has(lower)) return false;
  wallets.add(lower);
  saveWallets(wallets);
  return true;
}

/**
 * 移除 dev 钱包
 */
export function removeDevWallet(address: string): boolean {
  const wallets = load();
  const lower = address.toLowerCase();
  if (!wallets.has(lower)) return false;
  wallets.delete(lower);
  saveWallets(wallets);
  return true;
}

/**
 * 替换所有 dev 钱包
 */
export function setDevWallets(addresses: string[]): void {
  const wallets = new Set(addresses.map((a) => a.toLowerCase()));
  saveWallets(wallets);
}

/**
 * 获取 dev 钱包数量
 */
export function getDevWalletCount(): number {
  return load().size;
}
