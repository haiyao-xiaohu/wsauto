import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 毒钱包模块
 *
 * 毒钱包买入的代币直接加入全局黑名单，任何人都不跟。
 * - 毒钱包列表: logs/poison-wallets.json
 * - 代币黑名单: logs/token-blacklist.json（持久化，带原因）
 */

const POISON_WALLETS_PATH = path.resolve("logs/poison-wallets.json");
const TOKEN_BLACKLIST_PATH = path.resolve("logs/token-blacklist.json");

// ── 毒钱包列表 ──

interface PoisonCache {
  data: Set<string>;
  mtimeMs: number;
}
let poisonCache: PoisonCache | null = null;

function ensureDir(): void {
  const dir = path.resolve("logs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadPoisonSet(): Set<string> {
  try {
    const stat = fs.statSync(POISON_WALLETS_PATH);
    if (poisonCache && stat.mtimeMs === poisonCache.mtimeMs) {
      return poisonCache.data;
    }
    const raw = fs.readFileSync(POISON_WALLETS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const data = new Set<string>(
      (Array.isArray(parsed) ? parsed : [])
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.toLowerCase()),
    );
    poisonCache = { data, mtimeMs: stat.mtimeMs };
    return data;
  } catch {
    return new Set();
  }
}

export function isPoisonWallet(address: string): boolean {
  return loadPoisonSet().has(address.toLowerCase());
}

export function getAllPoisonWallets(): string[] {
  return [...loadPoisonSet()].sort();
}

export function addPoisonWallet(address: string): boolean {
  ensureDir();
  const set = loadPoisonSet();
  const lower = address.toLowerCase();
  if (set.has(lower)) return false;
  set.add(lower);
  fs.writeFileSync(POISON_WALLETS_PATH, JSON.stringify([...set].sort(), null, 2));
  poisonCache = null;
  return true;
}

export function removePoisonWallet(address: string): boolean {
  ensureDir();
  const set = loadPoisonSet();
  const lower = address.toLowerCase();
  if (!set.has(lower)) return false;
  set.delete(lower);
  fs.writeFileSync(POISON_WALLETS_PATH, JSON.stringify([...set].sort(), null, 2));
  poisonCache = null;
  return true;
}

// ── 代币黑名单 ──

interface TokenBlacklistEntry {
  token: string;
  reason: string;
  addedAtMs: number;
}

interface BlacklistCache {
  data: Map<string, TokenBlacklistEntry>;
  mtimeMs: number;
}
let blacklistCache: BlacklistCache | null = null;

function loadBlacklistMap(): Map<string, TokenBlacklistEntry> {
  try {
    const stat = fs.statSync(TOKEN_BLACKLIST_PATH);
    if (blacklistCache && stat.mtimeMs === blacklistCache.mtimeMs) {
      return blacklistCache.data;
    }
    const raw = fs.readFileSync(TOKEN_BLACKLIST_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const map = new Map<string, TokenBlacklistEntry>();
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry && typeof entry.token === "string") {
          map.set(entry.token.toLowerCase(), entry);
        }
      }
    }
    blacklistCache = { data: map, mtimeMs: stat.mtimeMs };
    return map;
  } catch {
    return new Map();
  }
}

export function isTokenBlacklisted(token: string): boolean {
  return loadBlacklistMap().has(token.toLowerCase());
}

export function blacklistToken(token: string, reason: string): boolean {
  ensureDir();
  const map = loadBlacklistMap();
  const lower = token.toLowerCase();
  if (map.has(lower)) return false;
  const entry: TokenBlacklistEntry = {
    token: lower,
    reason,
    addedAtMs: Date.now(),
  };
  map.set(lower, entry);
  fs.writeFileSync(TOKEN_BLACKLIST_PATH, JSON.stringify([...map.values()], null, 2));
  blacklistCache = null;
  return true;
}

export function unblacklistToken(token: string): boolean {
  ensureDir();
  const map = loadBlacklistMap();
  const lower = token.toLowerCase();
  if (!map.has(lower)) return false;
  map.delete(lower);
  fs.writeFileSync(TOKEN_BLACKLIST_PATH, JSON.stringify([...map.values()], null, 2));
  blacklistCache = null;
  return true;
}

export function getTokenBlacklistEntries(): TokenBlacklistEntry[] {
  return [...loadBlacklistMap().values()].sort((a, b) => b.addedAtMs - a.addedAtMs);
}
