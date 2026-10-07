/**
 * trigger-store.ts
 *
 * 把每次共振触发及其后续状态变更持久化到 SQLite。
 * 目的：积累历史数据，用于分析哪些钱包组合是好/坏信号，
 *       方便后期评测并决定是否加入排除组合。
 *
 * 文件路径：logs/triggers.db
 * 所有写入操作均通过 setImmediate 异步执行，不阻塞共振→下单主链路。
 */

import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const LOGS_DIR = path.resolve(process.cwd(), "logs");
const DB_FILE = path.join(LOGS_DIR, "triggers.db");

// ── 初始化 ──

function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  ensureLogsDir();
  _db = new Database(DB_FILE);
  // WAL 模式：写入不阻塞读取
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  initSchema(_db);
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id              TEXT PRIMARY KEY,          -- "tokenAddress:triggeredAtMs"
      chain           TEXT NOT NULL DEFAULT 'bsc',
      token_address   TEXT NOT NULL,
      triggered_at_ms INTEGER NOT NULL,
      delta_seconds   REAL NOT NULL DEFAULT 0,   -- 首尾信号时间差（秒）
      wallet_count    INTEGER NOT NULL DEFAULT 0,
      wallets         TEXT NOT NULL DEFAULT '[]', -- JSON 数组
      tx_hashes       TEXT NOT NULL DEFAULT '[]', -- JSON 数组，原始链上 tx
      status          TEXT NOT NULL DEFAULT 'detected',
      route           TEXT,                       -- fourmeme_inner / okx_dex / ...
      broadcast_tx    TEXT,                       -- 最终广播的 tx hash
      error           TEXT,
      swap_detail     TEXT,                       -- JSON，完整 swap 结果
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 按钱包组合分析用的索引
    CREATE INDEX IF NOT EXISTS idx_triggers_chain     ON triggers(chain);
    CREATE INDEX IF NOT EXISTS idx_triggers_token     ON triggers(token_address);
    CREATE INDEX IF NOT EXISTS idx_triggers_status    ON triggers(status);
    CREATE INDEX IF NOT EXISTS idx_triggers_ts        ON triggers(triggered_at_ms DESC);
  `);
}

// ── 写入操作（全部通过 setImmediate 异步执行，不阻塞主链路）──

/**
 * 新共振触发时插入一条记录。
 * 由 DashboardState.recordTrigger() 调用。
 */
export function insertTrigger(params: {
  id: string;
  chain: "bsc" | "rob";
  tokenAddress: string;
  triggeredAtMs: number;
  deltaSeconds: number;
  wallets: string[];
  txHashes: string[];
  willBuildSwap: boolean;
}): void {
  setImmediate(() => {
    try {
      const db = getDb();
      db.prepare(`
        INSERT OR IGNORE INTO triggers
          (id, chain, token_address, triggered_at_ms, delta_seconds,
           wallet_count, wallets, tx_hashes, status)
        VALUES
          (@id, @chain, @tokenAddress, @triggeredAtMs, @deltaSeconds,
           @walletCount, @wallets, @txHashes, @status)
      `).run({
        id: params.id,
        chain: params.chain,
        tokenAddress: params.tokenAddress.toLowerCase(),
        triggeredAtMs: params.triggeredAtMs,
        deltaSeconds: params.deltaSeconds,
        walletCount: params.wallets.length,
        wallets: JSON.stringify(params.wallets.map((w) => w.toLowerCase())),
        txHashes: JSON.stringify(params.txHashes),
        status: params.willBuildSwap ? "building" : "detected",
      });
    } catch (err) {
      console.error("[TriggerStore] insertTrigger failed:", err);
    }
  });
}

/**
 * 路由构建成功时更新状态和 swap 详情。
 * 由 DashboardState.recordSwapBuilt() 调用。
 */
export function updateSwapBuilt(id: string, swap: object): void {
  setImmediate(() => {
    try {
      const db = getDb();
      const route = (swap as Record<string, unknown>).route as string | undefined;
      db.prepare(`
        UPDATE triggers
        SET status = 'built', route = @route, swap_detail = @swapDetail
        WHERE id = @id
      `).run({
        id,
        route: route ?? null,
        swapDetail: JSON.stringify(swap),
      });
    } catch (err) {
      console.error("[TriggerStore] updateSwapBuilt failed:", err);
    }
  });
}

/**
 * 交易广播成功时更新 tx hash 和状态。
 * 由 DashboardState.recordBroadcasted() 调用。
 */
export function updateBroadcasted(id: string, swap: object): void {
  setImmediate(() => {
    try {
      const db = getDb();
      const broadcast = (swap as Record<string, unknown>).broadcast as
        | { txHash?: string }
        | undefined;
      const route = (swap as Record<string, unknown>).route as string | undefined;
      db.prepare(`
        UPDATE triggers
        SET status = 'broadcasted',
            route = @route,
            broadcast_tx = @broadcastTx,
            swap_detail = @swapDetail
        WHERE id = @id
      `).run({
        id,
        route: route ?? null,
        broadcastTx: broadcast?.txHash ?? null,
        swapDetail: JSON.stringify(swap),
      });
    } catch (err) {
      console.error("[TriggerStore] updateBroadcasted failed:", err);
    }
  });
}

/**
 * 路由构建/广播失败时记录错误。
 * 由 DashboardState.recordSwapRejected() 调用。
 */
export function updateRejected(id: string, error: string): void {
  setImmediate(() => {
    try {
      const db = getDb();
      db.prepare(`
        UPDATE triggers
        SET status = 'rejected', error = @error
        WHERE id = @id
      `).run({ id, error });
    } catch (err) {
      console.error("[TriggerStore] updateRejected failed:", err);
    }
  });
}

// ── 查询操作（供后期评测脚本使用）──

/** 查询最近 N 条触发记录 */
export function queryRecent(limit = 100, chain?: string): unknown[] {
  try {
    const db = getDb();
    if (chain) {
      return db.prepare(
        "SELECT * FROM triggers WHERE chain = ? ORDER BY triggered_at_ms DESC LIMIT ?"
      ).all(chain, limit);
    }
    return db.prepare(
      "SELECT * FROM triggers ORDER BY triggered_at_ms DESC LIMIT ?"
    ).all(limit);
  } catch (err) {
    console.error("[TriggerStore] queryRecent failed:", err);
    return [];
  }
}

/** 按钱包地址查询它参与的所有触发 */
export function queryByWallet(wallet: string): unknown[] {
  try {
    const db = getDb();
    const w = wallet.toLowerCase();
    // wallets 字段是 JSON 数组，用 LIKE 模糊匹配
    return db.prepare(
      "SELECT * FROM triggers WHERE wallets LIKE ? ORDER BY triggered_at_ms DESC"
    ).all(`%${w}%`);
  } catch (err) {
    console.error("[TriggerStore] queryByWallet failed:", err);
    return [];
  }
}
