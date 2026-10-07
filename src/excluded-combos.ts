import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 共振钱包组合排除模块
 *
 * 当特定的钱包组合触发共振后表现不佳，可以排除该组合，
 * 下次同样的钱包组合不再触发共振。
 *
 * 存储格式: [["0xaaa...", "0xbbb..."], ...]
 * 每对钱包按字典序排列，确保唯一性。
 */

const EXCLUDED_COMBOS_PATH = path.resolve("logs/excluded-combos.json");

interface CachedData {
  data: string[][];
  mtimeMs: number;
}

let cached: CachedData | null = null;
const CACHE_MS = 2000;

function ensureDir(): void {
  const dir = path.dirname(EXCLUDED_COMBOS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load(): string[][] {
  try {
    const stat = fs.statSync(EXCLUDED_COMBOS_PATH);
    if (cached && stat.mtimeMs === cached.mtimeMs) {
      const age = Date.now() - cached.mtimeMs;
      if (age < CACHE_MS) return cached.data;
    }
    const raw = fs.readFileSync(EXCLUDED_COMBOS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const data = parsed.filter(
      (item: unknown): item is string[] =>
        Array.isArray(item) && item.length >= 2 && item.every((s) => typeof s === "string"),
    );
    cached = { data, mtimeMs: stat.mtimeMs };
    return data;
  } catch {
    return [];
  }
}

/**
 * 规范化钱包对：仅小写，保留方向（A→B 与 B→A 视为不同）。
 */
function normalizePair(a: string, b: string): [string, string] {
  return [a.toLowerCase(), b.toLowerCase()];
}

/**
 * 检查钱包对是否被排除（严格按顺序）。
 */
export function isExcluded(walletA: string, walletB: string): boolean {
  const combos = load();
  const [a, b] = normalizePair(walletA, walletB);
  return combos.some((pair) => pair[0] === a && pair[1] === b);
}

/**
 * 检查一组钱包中是否存在被排除的有序组合。
 * wallets 数组按触发时间升序排列，检查是否存在排除组合 (X,Y) 满足 X 在 Y 之前出现。
 */
export function hasExcludedCombo(wallets: string[]): boolean {
  if (wallets.length < 2) return false;
  const combos = load();
  if (combos.length === 0) return false;

  // 检查每个排除组合：是否存在 X 在 Y 之前触发
  for (const [x, y] of combos) {
    const xi = wallets.findIndex((w) => w.toLowerCase() === x);
    if (xi === -1) continue;
    const yi = wallets.findIndex((w, idx) => idx > xi && w.toLowerCase() === y);
    if (yi !== -1) return true;
  }
  return false;
}

/**
 * 添加排除组合
 */
export function addExcluded(walletA: string, walletB: string): boolean {
  ensureDir();
  const combos = load();
  const [a, b] = normalizePair(walletA, walletB);

  // 已存在则跳过
  if (combos.some((pair) => pair[0] === a && pair[1] === b)) {
    return false;
  }

  combos.push([a, b]);
  fs.writeFileSync(EXCLUDED_COMBOS_PATH, JSON.stringify(combos, null, 2));
  cached = null;
  return true;
}

/**
 * 移除排除组合
 */
export function removeExcluded(walletA: string, walletB: string): boolean {
  ensureDir();
  const combos = load();
  const [a, b] = normalizePair(walletA, walletB);

  const idx = combos.findIndex((pair) => pair[0] === a && pair[1] === b);
  if (idx === -1) return false;

  combos.splice(idx, 1);
  fs.writeFileSync(EXCLUDED_COMBOS_PATH, JSON.stringify(combos, null, 2));
  cached = null;
  return true;
}

/**
 * 获取所有排除组合
 */
export function getAllExcluded(): Array<{ walletA: string; walletB: string }> {
  return load().map((pair) => ({ walletA: pair[0] ?? "", walletB: pair[1] ?? "" }));
}

/**
 * 替换所有排除组合
 */
export function setAllExcluded(pairs: Array<[string, string]>): void {
  ensureDir();
  const normalized = pairs.map(([a, b]) => normalizePair(a, b));
  // 去重
  const seen = new Set<string>();
  const unique = normalized.filter(([a, b]) => {
    const key = `${a}|${b}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  fs.writeFileSync(EXCLUDED_COMBOS_PATH, JSON.stringify(unique, null, 2));
  cached = null;
}
