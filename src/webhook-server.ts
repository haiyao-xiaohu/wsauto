import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import crypto from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { enableFileLogging } from "./logger.js";
enableFileLogging();

import { buildBscSwapUnified, type BscSwapBuildResult } from "./bsc-swap-builder.js";
import { buildRobSwapUnified, type RobSwapBuildResult } from "./rob-swap-builder.js";
import { DashboardState, type WalletBookEntry } from "./dashboard-state.js";
import { getResonanceConfig, getRobResonanceConfig } from "./resonance-config.js";
import { ResonanceEngine, type ResonanceTrigger } from "./resonance.js";
import * as runtimeConfig from "./runtime-config.js";
import { verifyQuickNodeWebhook } from "./quicknode-signature.js";
import { extractBscBuySignals } from "./signals/bsc.js";
import { extractRobBuySignals } from "./signals/rob.js";
import { getRuntimeConfig } from "./config.js";
import { broadcastSwap, broadcastRobSwap, broadcastPreSigned, preSignBuyTx, prepareBuyTx, executePreparedTx, waitForTx, waitForRobTx, WaitForTxTimeoutError, getBscClients, getRobClients, type BroadcastResult, type PreSignResult, type PreparedTransaction } from "./broadcast.js";
import { positionTracker } from "./position-tracker.js";
import * as excludedCombos from "./excluded-combos.js";
import * as devWallets from "./dev-wallets.js";
import * as poisonWallets from "./poison-wallets.js";
import { AutoSellEngine, getAutoSellConfig } from "./auto-sell.js"; // TODO: GMGN 挂单集成后移除
import { gmgnOrderEngine, loadGmgnConfig, type GmgnOrderInfo } from "./gmgn-orders.js";

const WEBHOOK_PATHS = new Set(["/webhook", "/webhooks/quicknode"]);
const ROB_WEBHOOK_PATHS = new Set(["/webhook/rob", "/webhooks/rob/quicknode"]);
const ALL_WEBHOOK_PATHS = new Set([...WEBHOOK_PATHS, ...ROB_WEBHOOK_PATHS]);
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1_000;

// ── GMGN 挂单钩子 ──

/**
 * 买入成功后异步创建 GMGN 挂单（绝不阻塞主链路）。
 */
function fireGmgnOrders(positionId: string, tokenAddress: string, costBnb: bigint, tokenAmount: bigint): void {
  const gmgnConfig = loadGmgnConfig();
  if (!gmgnConfig.enabled) return;
  if (tokenAmount === 0n) return;

  const walletAddress = process.env.EVM_WALLET_ADDRESS || "";
  if (!walletAddress) return;

  // 计算买入价 (BNB/token)
  const costBnbDec = Number(costBnb) / 1e18;
  const tokenDec = Number(tokenAmount) / 1e18;
  const buyPriceBnb = (costBnbDec / tokenDec).toFixed(18);

  void gmgnOrderEngine.createOrders({
    tokenAddress,
    walletAddress,
    buyPriceBnb,
    tokenBalance: tokenAmount.toString(),
  }).then(results => {
    const orders: GmgnOrderInfo[] = results.map(r => ({
      orderId: r.orderId,
      type: r.subOrderType,
      label: r.label,
      checkPriceUsd: r.checkPriceUsd,
      amount: r.amount,
      sellPercent: r.sellPercent,
      status: r.status === "created" ? "open" as const : "unknown" as const,
      createdAtMs: Date.now(),
    }));
    positionTracker.setGmgnOrders(positionId, orders);
    const okCount = results.filter(r => r.status === "created").length;
    console.log(JSON.stringify({ event: "GMGN_ORDERS_CREATED", positionId, count: okCount, total: results.length }));
  }).catch(err => {
    console.error(JSON.stringify({ event: "GMGN_ORDERS_FAILED", positionId, error: err instanceof Error ? err.message : String(err) }));
  });
}

// ── 信心检查：共振买入后 N 秒内无其他钱包跟进则立即卖出 ──

interface ConfidenceCheck {
  timer: NodeJS.Timeout;
  originalWallets: Set<string>;
  positionId: string;
  tokenAmount: bigint;
  costBnb: bigint;
}

const confidenceChecks = new Map<string, ConfidenceCheck>();

/**
 * 启动信心检查定时器：N 秒内无其他钱包跟进买入则触发 GMGN 立即卖出
 */
function startConfidenceCheck(
  tokenAddress: string,
  positionId: string,
  originalWallets: string[],
  tokenAmount: bigint,
  costBnb: bigint,
): void {
  const seconds = runtimeConfig.getConfidenceCheckSeconds();
  if (seconds <= 0) return; // 禁用

  // 清除已有的检查（如果重复触发）
  const existing = confidenceChecks.get(tokenAddress);
  if (existing) {
    clearTimeout(existing.timer);
    confidenceChecks.delete(tokenAddress);
  }

  const timer = setTimeout(() => {
    confidenceChecks.delete(tokenAddress);
    executeConfidenceSell(tokenAddress, positionId, tokenAmount, costBnb);
  }, seconds * 1_000);

  confidenceChecks.set(tokenAddress, {
    timer,
    originalWallets: new Set(originalWallets.map(w => w.toLowerCase())),
    positionId,
    tokenAmount,
    costBnb,
  });

  console.log(JSON.stringify({
    event: "CONFIDENCE_CHECK_START",
    tokenAddress: tokenAddress.slice(0, 10),
    positionId,
    timeoutSeconds: seconds,
    originalWallets: originalWallets.map(w => w.slice(0, 10)),
  }));
}

/**
 * 检查信号是否取消信心检查（其他钱包跟进买入）
 * 返回 true 表示已取消（信心检查通过）
 */
function checkAndCancelConfidence(tokenAddress: string, walletAddress: string): boolean {
  const check = confidenceChecks.get(tokenAddress);
  if (!check) return false;

  const walletLower = walletAddress.toLowerCase();
  if (check.originalWallets.has(walletLower)) return false; // 原始钱包，不算跟进

  // 其他钱包跟进，取消信心检查
  clearTimeout(check.timer);
  confidenceChecks.delete(tokenAddress);

  console.log(JSON.stringify({
    event: "CONFIDENCE_CHECK_PASSED",
    tokenAddress: tokenAddress.slice(0, 10),
    positionId: check.positionId,
    followUpWallet: walletAddress.slice(0, 10),
  }));
  return true;
}

/**
 * 信心检查失败，执行 GMGN 立即卖出
 */
async function executeConfidenceSell(
  tokenAddress: string,
  positionId: string,
  tokenAmount: bigint,
  costBnb: bigint,
): Promise<void> {
  const walletAddress = process.env.EVM_WALLET_ADDRESS || "";
  if (!walletAddress || tokenAmount === 0n) return;

  // 计算买入价
  const costBnbDec = Number(costBnb) / 1e18;
  const tokenDec = Number(tokenAmount) / 1e18;
  const buyPriceBnb = (costBnbDec / tokenDec).toFixed(18);

  // 获取现有挂单 ID
  const position = positionTracker.getPositions().find(p => p.id === positionId);
  const existingOrderIds = position?.gmgnOrders?.map(o => o.orderId).filter(Boolean) || [];

  console.log(JSON.stringify({
    event: "CONFIDENCE_CHECK_FAILED",
    tokenAddress: tokenAddress.slice(0, 10),
    positionId,
    existingOrders: existingOrderIds.length,
  }));

  // 执行立即卖出
  const result = await gmgnOrderEngine.immediateSell({
    tokenAddress,
    walletAddress,
    buyPriceBnb,
    tokenBalance: tokenAmount.toString(),
    existingOrderIds,
  });

  if (result && result.status === "created") {
    // 更新持仓状态
    positionTracker.setGmgnOrders(positionId, [{
      orderId: result.orderId,
      type: "stop_loss",
      label: "信心检查立即卖出",
      checkPriceUsd: result.checkPriceUsd,
      amount: result.amount,
      sellPercent: 100,
      status: "open",
      createdAtMs: Date.now(),
    }]);
    console.log(JSON.stringify({
      event: "CONFIDENCE_SELL_CREATED",
      tokenAddress: tokenAddress.slice(0, 10),
      positionId,
      orderId: result.orderId,
    }));
  } else {
    console.error(JSON.stringify({
      event: "CONFIDENCE_SELL_FAILED",
      tokenAddress: tokenAddress.slice(0, 10),
      positionId,
    }));
  }
}

// ── Dashboard 登录认证 ──

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD?.trim();
if (!DASHBOARD_PASSWORD) {
  throw new Error("请配置 DASHBOARD_PASSWORD，Dashboard 不允许使用默认密码");
}
const SESSION_TOKEN = crypto.randomBytes(32).toString("hex");
const SESSION_COOKIE_NAME = "rsn_session";

function parseCookies(request: IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {};
  const header = request.headers.cookie;
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) cookies[key.trim()] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

function isAuthenticated(request: IncomingMessage): boolean {
  return parseCookies(request)[SESSION_COOKIE_NAME] === SESSION_TOKEN;
}

function serveLoginHtml(response: ServerResponse): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(loginPageHtml);
}

let loginPageHtml = "";
const seenNonces = new Map<string, number>();

interface WebhookQueueItem {
  body: string;
  receivedAtMs: number;
  chain: "bsc" | "rob"; // 标识来自哪条链的 webhook
}

const webhookQueue: WebhookQueueItem[] = [];
const MAX_WEBHOOK_QUEUE_SIZE = 1000;

function json(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function asset(
  response: ServerResponse,
  contentType: string,
  value: string,
): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": contentType,
  });
  response.end(value);
}

async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new Error("PAYLOAD_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodedBody(request: IncomingMessage, rawBody: Buffer): string {
  const encoding = request.headers["content-encoding"]?.toLowerCase();
  if (!encoding || encoding === "identity") return rawBody.toString("utf8");
  if (encoding === "gzip") return gunzipSync(rawBody).toString("utf8");
  throw new Error(`不支持 Content-Encoding: ${encoding}`);
}

function verifySignature(
  request: IncomingMessage,
  body: string,
  secret: string,
): { ok: true; replay: boolean } | { ok: false; message: string } {
  const nonce = request.headers["x-qn-nonce"];
  const signature = request.headers["x-qn-signature"];
  const timestamp = request.headers["x-qn-timestamp"];
  if (
    typeof nonce !== "string" ||
    typeof signature !== "string" ||
    typeof timestamp !== "string"
  ) {
    return { ok: false, message: "缺少 QuickNode 签名头" };
  }

  const timestampMs = Number(timestamp) * 1_000;
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs(Date.now() - timestampMs) > SIGNATURE_MAX_AGE_MS
  ) {
    return { ok: false, message: "QuickNode 签名时间戳已过期" };
  }
  if (seenNonces.has(nonce)) {
    // 幂等确认：QuickNode 重试同一笔投递时会复用相同 nonce（通常因为首次
    // 响应超时或网络丢失）。返回 200 让 QuickNode 停止重试，避免 stream 被停。
    return { ok: true, replay: true };
  }
  if (
    !verifyQuickNodeWebhook(secret, { nonce, signature, timestamp }, body)
  ) {
    return { ok: false, message: "QuickNode 签名无效" };
  }

  seenNonces.set(nonce, timestampMs);
  for (const [storedNonce, storedAtMs] of seenNonces) {
    if (storedAtMs < Date.now() - SIGNATURE_MAX_AGE_MS) {
      seenNonces.delete(storedNonce);
    }
  }
  return { ok: true, replay: false };
}

function triggerLog(trigger: ResonanceTrigger) {
  const ordered = [...trigger.signals].sort(
    (left, right) => left.blockTimestampMs - right.blockTimestampMs,
  );
  const first = ordered[0];
  const last = ordered.at(-1);
  return {
    event: "RESONANCE_TRIGGER",
    chainId: trigger.chainId,
    tokenAddress: trigger.tokenAddress,
    triggeredAt: new Date(trigger.triggeredAtMs).toISOString(),
    deltaSeconds:
      first && last
        ? (last.blockTimestampMs - first.blockTimestampMs) / 1_000
        : 0,
    wallets: ordered.map((signal) => signal.walletAddress),
    txHashes: ordered.map((signal) => signal.txHash),
  };
}

function loadWalletBook(
  filePath: string | null,
): Record<string, WalletBookEntry> {
  if (!filePath) return {};
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return {};

    const book: Record<string, WalletBookEntry> = {};
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const address =
        typeof record.address === "string" ? record.address.toLowerCase() : "";
      if (!/^0x[0-9a-f]{40}$/.test(address)) continue;

      const name = typeof record.name === "string" ? record.name.trim() : "";
      const emoji = typeof record.emoji === "string" ? record.emoji.trim() : "";
      const groups = Array.isArray(record.groups)
        ? record.groups.filter((item): item is string => typeof item === "string")
        : undefined;

      if (!name && !emoji && (!groups || groups.length === 0)) continue;
      book[address] = {
        ...(name ? { name } : {}),
        ...(emoji ? { emoji } : {}),
        ...(groups && groups.length > 0 ? { groups } : {}),
      };
    }
    return book;
  } catch {
    return {};
  }
}

function loadDisplayWallets(filePath: string | null): Set<string> {
  if (!filePath) return new Set();
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return new Set();
    const addresses = raw
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => /^0x[0-9a-f]{40}$/.test(line));
    return new Set(addresses);
  } catch {
    return new Set();
  }
}

// ── 事件日志（内存环形缓冲）──

interface EventLogEntry {
  ts: number;
  level: "info" | "warn" | "error" | "success";
  event: string;
  message: string;
  tokenAddress?: string;
  data?: Record<string, unknown>;
}

const EVENT_LOG_MAX = 200;
const eventLog: EventLogEntry[] = [];
const logSseClients = new Set<ServerResponse>();

function recordEvent(
  level: EventLogEntry["level"],
  event: string,
  message: string,
  tokenAddress?: string,
  data?: Record<string, unknown>,
): void {
  const entry: EventLogEntry = { ts: Date.now(), level, event, message };
  if (tokenAddress) entry.tokenAddress = tokenAddress;
  if (data) entry.data = data;
  eventLog.push(entry);
  if (eventLog.length > EVENT_LOG_MAX) eventLog.shift();
  // Push to SSE clients
  const payload = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const client of logSseClients) client.write(payload);
}

async function main(): Promise<void> {
  const config = getResonanceConfig();
  const robConfig = getRobResonanceConfig();
  const quickNodeSecret = process.env.QUICKNODE_STREAM_SECRET?.trim() ?? "";
  const quickNodeRobSecret = process.env.QUICKNODE_ROB_STREAM_SECRET?.trim() ?? "";
  const runtime = getRuntimeConfig();
  const webhookLiveTrading = process.env.WEBHOOK_LIVE_TRADING === "true";
  const webhookRobLiveTrading = process.env.WEBHOOK_ROB_LIVE_TRADING === "true";
  const allowUnsignedLiveTrading =
    process.env.ALLOW_UNSIGNED_WEBHOOKS_FOR_LIVE_TRADING === "true";
  const publicDirectory = path.resolve(process.cwd(), "public");
  const frontendDir = path.resolve(process.cwd(), "dist-frontend");
  const frontendIndexPath = path.join(frontendDir, "index.html");
  if (!existsSync(frontendIndexPath)) {
    throw new Error("dist-frontend/index.html not found. Run 'npm run build:frontend' first.");
  }
  const frontendIndex = readFileSync(frontendIndexPath, "utf8");
  loginPageHtml = readFileSync(
    path.join(publicDirectory, "login.html"),
    "utf8",
  );
  // howler.js 音频库 + 警笛音效
  const howlerJs = readFileSync(
    path.join(publicDirectory, "howler.min.js"),
    "utf8",
  );
  const sirenWav = readFileSync(
    path.join(publicDirectory, "siren.wav"),
  );

  const walletBookPath = process.env.WALLET_BOOK_PATH?.trim() || null;
  const walletBook = loadWalletBook(walletBookPath);
  const displayWalletsPath =
    process.env.DISPLAY_WALLETS_PATH?.trim() || "test/webhook-wallets.txt";
  const displayWallets = loadDisplayWallets(displayWalletsPath);

  if (webhookLiveTrading) {
    if (!runtime.liveTrading) {
      throw new Error(
        "WEBHOOK_LIVE_TRADING=true 需要同时设置 LIVE_TRADING=true 且 I_UNDERSTAND_LIVE_TRADING_RISK=true",
      );
    }
    if (config.watchedWallets.size === 0) {
      throw new Error(
        "真实交易必须配置 BSC_WATCH_WALLETS（避免任意錢包信号触发下单）",
      );
    }
    if (!quickNodeSecret && !allowUnsignedLiveTrading) {
      throw new Error(
        "真实交易必须启用 QUICKNODE_STREAM_SECRET 验签；或显式设置 ALLOW_UNSIGNED_WEBHOOKS_FOR_LIVE_TRADING=true",
      );
    }
  }

  if (webhookRobLiveTrading) {
    if (!runtime.liveTrading) {
      throw new Error(
        "WEBHOOK_ROB_LIVE_TRADING=true 需要同时设置 LIVE_TRADING=true 且 I_UNDERSTAND_LIVE_TRADING_RISK=true",
      );
    }
    if (robConfig.watchedWallets.size === 0) {
      throw new Error(
        "Rob 链真实交易必须配置 ROB_WATCH_WALLETS（避免任意錢包信号触发下单）",
      );
    }
    if (!quickNodeRobSecret && !allowUnsignedLiveTrading) {
      throw new Error(
        "Rob 链真实交易必须启用 QUICKNODE_ROB_STREAM_SECRET 验签；或显式设置 ALLOW_UNSIGNED_WEBHOOKS_FOR_LIVE_TRADING=true",
      );
    }
  }

  const walletFilter =
    config.watchedWallets.size > 0
      ? `${config.watchedWallets.size} local wallets`
      : "QuickNode Webhook upstream";
  const engine = new ResonanceEngine(
    {
      threshold: config.threshold,
      windowMs: config.windowMs,
      cooldownMs: config.cooldownMs,
      sniperCooldownMs: runtimeConfig.getSniperCooldownSeconds() * 1000,
      cooldownOverride: (tokenAddress: string) => {
        const buyCount = positionTracker.getBuyCount(tokenAddress);
        // 第 1 次→第 2 次：secondBuyCooldownSeconds（UI 可配）
        // 第 2 次→第 3 次：defaultCooldownSeconds（UI 可配）
        if (buyCount === 0) return runtimeConfig.getSecondBuyCooldownSeconds() * 1_000;
        return runtimeConfig.getDefaultCooldownSeconds() * 1_000;
      },
      ...(config.watchedWallets.size > 0
        ? { watchedWallets: config.watchedWallets }
        : {}),
    },
    56, // BSC chainId
  );

  // Rob 链独立共振引擎
  const robWalletFilter =
    robConfig.watchedWallets.size > 0
      ? `${robConfig.watchedWallets.size} rob wallets`
      : "QuickNode ROB upstream";
  const robEngine = new ResonanceEngine(
    {
      threshold: robConfig.threshold,
      windowMs: robConfig.windowMs,
      cooldownMs: robConfig.cooldownMs,
      sniperCooldownMs: runtimeConfig.getSniperCooldownSeconds() * 1000,
      cooldownMultiplier: (tokenAddress: string) => {
        return positionTracker.getBuyCount(tokenAddress) + 1;
      },
      ...(robConfig.watchedWallets.size > 0
        ? { watchedWallets: robConfig.watchedWallets }
        : {}),
    },
    4663, // Rob 链 chainId
  );
  // Swap build config (null = disabled)
  // 运行时配置：优先 runtime-config.json > 环境变量 > 默认值
  const runtimeOverrides = runtimeConfig.getAll();
  if (runtimeOverrides.evmPrivateKey) {
    process.env.EVM_PRIVATE_KEY = runtimeOverrides.evmPrivateKey;
  }

  // 黑名单文件
  const blacklistPath = path.resolve(process.cwd(), "test/blacklist.txt");
  let blacklistedWallets = new Set<string>();
  if (existsSync(blacklistPath)) {
    const raw = readFileSync(blacklistPath, "utf8");
    const addrs = raw.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => /^0x[0-9a-f]{40}$/.test(l));
    blacklistedWallets = new Set(addrs);
  }

  // 运行时覆盖 EVM 私钥（优先于环境变量）
  if (runtimeOverrides.evmPrivateKey?.trim()) {
    process.env.EVM_PRIVATE_KEY = runtimeOverrides.evmPrivateKey.trim();
  }

  // 从当前私钥派生执行钱包地址
  function getExecutorAddress(): string {
    const pk = process.env.EVM_PRIVATE_KEY?.trim();
    if (!pk) return "";
    try {
      const key = pk.startsWith("0x") ? pk : `0x${pk}`;
      return privateKeyToAccount(key as Hex).address.toLowerCase();
    } catch { return ""; }
  }

  let orderAmountBnb = runtimeConfig.getOrderAmountBnb() || config.orderAmountBnb;
  let swapConfig = config.buildSwapOnTrigger
    ? {
        amount: orderAmountBnb,
        maxAmount: config.maxOrderAmountBnb,
      }
    : null;
  // Rob 链交易配置
  let robOrderAmountEth = robConfig.orderAmountEth;
  let robSwapConfig = robConfig.buildSwapOnTrigger
    ? { amount: robOrderAmountEth }
    : null;
  // 设置黑名单到引擎
  engine.setBlacklistedWallets(blacklistedWallets);

  // 加载代币黑名单（毒钱包历史）
  const existingTokenBlacklist = poisonWallets.getTokenBlacklistEntries();
  for (const entry of existingTokenBlacklist) {
    engine.addBlacklistedToken(entry.token);
  }
  if (existingTokenBlacklist.length > 0) {
    console.log(`[PoisonWallet] \u52a0\u8f7d ${existingTokenBlacklist.length} \u4e2a\u4ee3\u5e01\u9ed1\u540d\u5355`);
  }

  const dashboard = new DashboardState(
    {
      threshold: config.threshold,
      windowSeconds: config.windowMs / 1_000,
      cooldownSeconds: config.cooldownMs / 1_000,
      maxSignalAgeSeconds: config.maxSignalAgeMs / 1_000,
      walletFilter,
      signatureVerification: Boolean(quickNodeSecret),
      okxBuildOnTrigger: Boolean(swapConfig),
      transactionBroadcast: webhookLiveTrading,
      orderAmountBnb: orderAmountBnb,
      executorAddress: getExecutorAddress(),
      robConfig: {
        threshold: robConfig.threshold,
        windowSeconds: robConfig.windowMs / 1_000,
        cooldownSeconds: robConfig.cooldownMs / 1_000,
        transactionBroadcast: webhookRobLiveTrading,
        orderAmountEth: robConfig.orderAmountEth,
      },
    },
    engine,
    walletBook,
    displayWallets,
  );
  const sseClients = new Set<ServerResponse>();

  // ── 预构建缓存（不提前占用 nonce）──
  // 第一个钱包信号到达时，立刻启动 prepareBuyTx（detect+build+estimateGas）。
  // 缓存 Promise，第二个钱包到达时可复用，不重复构建。
  // 共振触发时统一走 executePreparedTx（acquireNonce+签名+广播），
  // 避免预签名提前占 nonce 制造空洞。
  const prepareCache = new Map<string, Promise<PreparedTransaction>>();
  const PREPARE_TTL = 60_000; // 60 秒过期
  setInterval(() => {
    const now = Date.now();
    for (const [key, promise] of prepareCache) {
      promise.then((p) => {
        if (now - p.preparedAtMs > PREPARE_TTL) prepareCache.delete(key);
      }).catch(() => prepareCache.delete(key));
    }
  }, 10_000).unref();

  const tryPrepare = (tokenAddress: string): void => {
    if (positionTracker.getBuyCount(tokenAddress) >= config.maxBuyCount) return;
    if (!swapConfig) return;
    if (prepareCache.has(tokenAddress)) return;

    const amount = runtimeConfig.getOrderAmountBnb() || swapConfig.amount;
    const slippage = runtimeConfig.getBuySlippagePercent();
    const wallet = process.env.EVM_WALLET_ADDRESS || "";

    // 立即缓存 Promise，后续信号可复用
    const preparePromise = prepareBuyTx(tokenAddress, amount, slippage, wallet, 1.2)
      .then((pt) => {
        recordEvent("info", "PREPARE_READY",
          `预构建完成 ${tokenAddress.slice(0, 10)}... (${pt.result.route})`,
          tokenAddress,
          { route: pt.result.route, ms: Date.now() - pt.preparedAtMs },
        );
        return pt;
      });
    prepareCache.set(tokenAddress, preparePromise);

    // 失败时清除缓存，允许后续重试
    preparePromise.catch(() => {
      if (prepareCache.get(tokenAddress) === preparePromise) {
        prepareCache.delete(tokenAddress);
      }
      recordEvent("warn", "PREPARE_FAILED",
        `预构建失败 ${tokenAddress.slice(0, 10)}...`,
        tokenAddress,
      );
    });
  };

  // 后台异步处理 webhook payload，避免阻塞 QuickNode 投递
  function processWebhookItem(item: WebhookQueueItem): void {
    if (item.chain === "rob") {
      processRobWebhook(item);
    } else {
      processBscWebhook(item);
    }
  }

  function processBscWebhook(item: WebhookQueueItem): void {
    try {
      const payload = JSON.parse(item.body) as unknown;
      const signals = extractBscBuySignals(payload);
      let accepted = 0;
      let stale = 0;
      let triggered = 0;

      dashboard.recordWebhook(item.receivedAtMs);
      if (signals.length > 0) {
        const oldestMs = Math.min(...signals.map((s) => s.blockTimestampMs));
        const newestMs = Math.max(...signals.map((s) => s.blockTimestampMs));
        console.log(
          JSON.stringify({
            event: "WEBHOOK_RECEIVED",
            chain: "bsc",
            count: signals.length,
            receivedAgeMs: item.receivedAtMs - newestMs,
            oldestAgeMs: item.receivedAtMs - oldestMs,
            receivedAt: new Date(item.receivedAtMs).toISOString(),
            newestSignalAt: new Date(newestMs).toISOString(),
          }),
        );
      }
      for (const signal of signals) {
        const ageMs = item.receivedAtMs - signal.blockTimestampMs;
        if (ageMs < -5_000 || ageMs > config.maxSignalAgeMs) {
          stale += 1;
          dashboard.recordSignal(signal, "stale", item.receivedAtMs, "bsc");
          continue;
        }

        // 毒钱包检测：该钱包买入的代币直接拉黑
        if (poisonWallets.isPoisonWallet(signal.walletAddress)) {
          const isNew = poisonWallets.blacklistToken(
            signal.tokenAddress,
            `poison wallet ${signal.walletAddress.slice(0, 10)}... bought`,
          );
          engine.addBlacklistedToken(signal.tokenAddress);
          if (isNew) {
            console.log(JSON.stringify({
              event: "POISON_WALLET_DETECTED",
              poisonWallet: signal.walletAddress,
              blacklistedToken: signal.tokenAddress,
            }));
            recordEvent("warn", "POISON_WALLET", `${signal.tokenAddress.slice(0, 10)}... 被毒钱包 ${signal.walletAddress.slice(0, 10)}... 买入，已拉黑`, signal.tokenAddress);
          }
          continue;
        }

        // 信心检查：检查此信号是否取消信心检查（其他钱包跟进买入）
        checkAndCancelConfidence(signal.tokenAddress, signal.walletAddress);

        const decision = engine.ingest(signal);
        dashboard.recordSignal(signal, decision.reason, item.receivedAtMs, "bsc");
        if (decision.reason !== "not_watched") accepted += 1;
        if (decision.trigger) {
          triggered += 1;
          handleTrigger(decision.trigger);
        } else if (decision.reason === "accepted" && swapConfig) {
          // 未触发但有 swap 配置：启动预构建，等下一个信号到达时复用
          tryPrepare(signal.tokenAddress);
        }
      }
      if (accepted > 0 || stale > 0 || triggered > 0) {
        publishDashboard();
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(JSON.stringify({ event: "WEBHOOK_PROCESS_ERROR", chain: "bsc", error: message }));
    }
  }

  function processRobWebhook(item: WebhookQueueItem): void {
    try {
      const payload = JSON.parse(item.body) as unknown;
      const signals = extractRobBuySignals(payload);
      let accepted = 0;
      let stale = 0;
      let triggered = 0;

      dashboard.recordWebhook(item.receivedAtMs);
      if (signals.length > 0) {
        const oldestMs = Math.min(...signals.map((s) => s.blockTimestampMs));
        const newestMs = Math.max(...signals.map((s) => s.blockTimestampMs));
        console.log(
          JSON.stringify({
            event: "WEBHOOK_RECEIVED",
            chain: "rob",
            count: signals.length,
            receivedAgeMs: item.receivedAtMs - newestMs,
            oldestAgeMs: item.receivedAtMs - oldestMs,
            receivedAt: new Date(item.receivedAtMs).toISOString(),
            newestSignalAt: new Date(newestMs).toISOString(),
          }),
        );
      }
      for (const signal of signals) {
        const ageMs = item.receivedAtMs - signal.blockTimestampMs;
        if (ageMs < -5_000 || ageMs > robConfig.maxSignalAgeMs) {
          stale += 1;
          dashboard.recordSignal(signal, "stale", item.receivedAtMs, "rob");
          continue;
        }

        const decision = robEngine.ingest(signal);
        dashboard.recordSignal(signal, decision.reason, item.receivedAtMs, "rob");
        if (decision.reason !== "not_watched") accepted += 1;
        if (decision.trigger) {
          triggered += 1;
          handleRobTrigger(decision.trigger);
        }
      }
      if (accepted > 0 || stale > 0 || triggered > 0) {
        publishDashboard();
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(JSON.stringify({ event: "WEBHOOK_PROCESS_ERROR", chain: "rob", error: message }));
    }
  }

  function startWebhookQueueWorker(): void {
    setInterval(() => {
      // 每次批量处理最多 10 条，避免队列堆积
      for (let i = 0; i < 10 && webhookQueue.length > 0; i += 1) {
        const item = webhookQueue.shift();
        if (item) processWebhookItem(item);
      }
    }, 20).unref();
  }
  startWebhookQueueWorker();

  // 自动卖出引擎已停用，等待 GMGN 挂单集成
  // const autoSellConfig = getAutoSellConfig();
  // const autoSellEngine = new AutoSellEngine(autoSellConfig);
  // if (autoSellConfig.enabled && webhookLiveTrading) { autoSellEngine.start(); }

  // 注册持仓 provider（dashboard 每次推送时获取最新持仓）
  dashboard.setPositionsProvider(() =>
    positionTracker.snapshot().map((pos) => ({
      id: pos.id,
      ...(pos.chain ? { chain: pos.chain } : {}),
      tokenAddress: pos.tokenAddress,
      platform: pos.platform,
      buyTxHash: pos.buyTxHash,
      boughtAtMs: pos.boughtAtMs,
      costBnb: pos.costBnb.toString(),
      tokenAmount: pos.tokenAmount.toString(),
      remainingAmount: pos.remainingAmount.toString(),
      status: pos.status,
      actions: pos.actions.map((a) => ({
        type: a.type,
        txHash: a.txHash,
        amount: a.amount?.toString(),
        executedAtMs: a.executedAtMs,
      })),
    })),
  );

  // 更新 dashboard config（autoSell 已停用）
  (dashboard as any).config.autoSell = undefined;

  const publishDashboard = (): void => {
    const message = `event: state\ndata: ${JSON.stringify(
      dashboard.snapshot(),
    )}\n\n`;
    for (const client of sseClients) client.write(message);
  };

  let lastTriggerBuyMs = 0; // 全局触发限流：上次共振买入的时间戳

  const handleTrigger = (trigger: ResonanceTrigger): void => {
    console.log(JSON.stringify(triggerLog(trigger)));
    const triggerId = dashboard.recordTrigger(trigger, Boolean(swapConfig), "bsc");
    publishDashboard();
    recordEvent("info", "RESONANCE_TRIGGER",
      `[BSC] ${trigger.isSniper ? "🎯 狙击" : `${trigger.signals.length}个錢包共振`}触发 ${trigger.tokenAddress.slice(0, 10)}... (第${positionTracker.getBuyCount(trigger.tokenAddress) + 1}次)`,
      trigger.tokenAddress,
      { wallets: trigger.signals.length, isSniper: trigger.isSniper, deltaSeconds: ((trigger.triggeredAtMs - Math.min(...trigger.signals.map((s) => s.blockTimestampMs))) / 1000).toFixed(1), buyCount: positionTracker.getBuyCount(trigger.tokenAddress) + 1 },
    );
    if (!swapConfig) return;

    // ── 买入次数限制 ──
    const buyCount = positionTracker.getBuyCount(trigger.tokenAddress);
    if (buyCount >= config.maxBuyCount) {
      const msg = `${trigger.tokenAddress.slice(0, 10)}... 已买入 ${buyCount} 次，达到上限 ${config.maxBuyCount}，跳过`;
      console.log(JSON.stringify({ event: "BUY_LIMIT", tokenAddress: trigger.tokenAddress, buyCount, maxBuyCount: config.maxBuyCount }));
      recordEvent("warn", "BUY_LIMIT", msg, trigger.tokenAddress,
        { buyCount, maxBuyCount: config.maxBuyCount },
      );
      dashboard.recordSwapRejected(triggerId, msg);
      publishDashboard();
      return;
    }

    // ── 全局触发限流：N 秒内只触发一次共振买入 ──
    const throttleMs = runtimeConfig.getResonanceThrottleSeconds() * 1_000;
    if (lastTriggerBuyMs > 0 && Date.now() - lastTriggerBuyMs < throttleMs) {
      const elapsedMs = Date.now() - lastTriggerBuyMs;
      const msg = `${trigger.tokenAddress.slice(0, 10)}... 距上次共振买入仅 ${elapsedMs}ms，限流跳过（阈值 ${throttleMs}ms）`;
      console.log(JSON.stringify({ event: "THROTTLE_SKIP", tokenAddress: trigger.tokenAddress, elapsedMs, throttleMs }));
      recordEvent("info", "THROTTLE_SKIP", msg, trigger.tokenAddress, { elapsedMs, throttleMs });
      dashboard.recordSwapRejected(triggerId, msg);
      publishDashboard();
      return;
    }
    lastTriggerBuyMs = Date.now();

    const t0 = Date.now();
    console.log(JSON.stringify({ event: "TIMING", phase: "trigger", tokenAddress: trigger.tokenAddress, ms: 0 }));

    // ── 预构建缓存检查：复用 prepareBuyTx 的 Promise ──
    // 如果有预构建缓存（已完成或仍在构建），复用它，不重复构建
    const preparePromise = prepareCache.get(trigger.tokenAddress);
    if (preparePromise) {
      prepareCache.delete(trigger.tokenAddress);
      recordEvent("info", "PREPARE_HIT",
        `预构建命中 ${trigger.tokenAddress.slice(0, 10)}...`,
        trigger.tokenAddress,
      );

      void (async () => {
        try {
          // 等待预构建完成（如果还在构建中）
          const prepared = await preparePromise;
          const tBuild = Date.now();
          console.log(JSON.stringify({ event: "TIMING", phase: "prepare_ready", tokenAddress: trigger.tokenAddress, ms: tBuild - t0, route: prepared.result.route }));

          if (webhookLiveTrading) {
            // 统一签名广播：acquireNonce + sign + broadcast（broadcastLock 保护）
            const broadcastResult = await executePreparedTx(prepared);
            console.log(JSON.stringify({ event: "TIMING", phase: "execute_broadcast_done", tokenAddress: trigger.tokenAddress, ms: Date.now() - t0 }));
            console.log(JSON.stringify({ event: "TX_BROADCAST", ...broadcastResult }));
            recordEvent("success", "TX_BROADCAST",
              `交易已广播 ${broadcastResult.txHash.slice(0, 14)}...`,
              trigger.tokenAddress,
              { txHash: broadcastResult.txHash },
            );

            // 等待交易确认并记录持仓
            try {
              const receipt = await waitForTx(broadcastResult.txHash);
              if (receipt && receipt.status === "success") {
                const r = prepared.result;
                const tokenAmount = r.fourmemeQuote
                  ? BigInt(r.fourmemeQuote.estimatedAmount)
                  : r.flapQuote
                    ? BigInt(r.flapQuote.estimatedOutput)
                    : r.okxResult
                      ? BigInt(r.okxResult.toTokenAmount)
                      : 0n;
                const costBnb = r.fourmemeQuote
                  ? BigInt(r.fourmemeQuote.amountMsgValue)
                  : r.flapQuote
                    ? BigInt(r.flapQuote.inputAmount)
                    : BigInt(r.tx!.value);
                const position = positionTracker.addPosition({
                  tokenAddress: trigger.tokenAddress,
                  platform: r.route,
                  tokenPlatform: r.tokenMarket.platform,
                  buyTxHash: broadcastResult.txHash,
                  costBnb,
                  tokenAmount,
                  resonanceWallets: trigger.signals.map((s) => s.walletAddress),
                  chain: "bsc",
                });
                console.log(JSON.stringify({ event: "POSITION_ADDED", positionId: position.id, tokenAddress: position.tokenAddress, totalMs: Date.now() - t0, prepare: true }));
                recordEvent("success", "POSITION_ADDED",
                  `买入成功 · 持仓已记录`,
                  position.tokenAddress,
                  { positionId: position.id, totalMs: Date.now() - t0 },
                );
                fireGmgnOrders(position.id, position.tokenAddress, costBnb, tokenAmount);
                startConfidenceCheck(
                  position.tokenAddress,
                  position.id,
                  trigger.signals.map(s => s.walletAddress),
                  tokenAmount,
                  costBnb,
                );
              } else if (receipt) {
                recordEvent("error", "TX_REVERTED",
                  `交易被链上回滚 ${broadcastResult.txHash.slice(0, 14)}...`,
                  trigger.tokenAddress,
                  { txHash: broadcastResult.txHash },
                );
              }
            } catch (waitErr) {
              if (waitErr instanceof WaitForTxTimeoutError) {
                console.log(JSON.stringify({ event: "WAIT_TIMEOUT", txHash: broadcastResult.txHash, note: "tx已广播，后台继续追踪" }));
              } else {
                throw waitErr;
              }
            }

            dashboard.recordSwapBuilt(triggerId, {
              route: prepared.result.route,
              tokenAddress: trigger.tokenAddress,
              platform: prepared.result.tokenMarket.platform,
              broadcast: { txHash: broadcastResult.txHash, fromAddress: broadcastResult.fromAddress },
            } as any);
            publishDashboard();
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          recordEvent("error", "BROADCAST_FAILED", `广播失败: ${message}`, trigger.tokenAddress);
          dashboard.recordSwapRejected(triggerId, `广播失败: ${message}`);
          publishDashboard();
        }
      })();
      return;
    }

    void buildBscSwapUnified({
      tokenAddress: trigger.tokenAddress,
      amount: trigger.isSniper
        ? runtimeConfig.getSniperOrderAmountBnb()
        : swapConfig.amount,
      slippagePercent: trigger.isSniper
        ? runtimeConfig.getSniperSlippagePercent()
        : runtimeConfig.getBuySlippagePercent(),
      walletAddress: process.env.EVM_WALLET_ADDRESS || "",
      options: { buildTx: true },
    })
      .then(async (result: BscSwapBuildResult) => {
        // 标记狙击模式，传给 broadcast.ts
        result.isSniper = trigger.isSniper;
        const tBuild = Date.now();
        console.log(JSON.stringify({ event: "TIMING", phase: "build_swap", tokenAddress: trigger.tokenAddress, ms: tBuild - t0, route: result.route }));
        recordEvent("info", "SWAP_BUILT",
          `路由 ${result.route} · ${result.tokenMarket.platform || "unknown"}`,
          trigger.tokenAddress,
          { route: result.route, ms: tBuild - t0 },
        );

        // 生成 summary 兼容 dashboard 格式
        const summary: {
          route: string;
          tokenAddress: string;
          reason: string;
          platform: string | null;
          status: string;
          progress: number;
          okx?: { fromToken: string; toToken: string; expectedToAmount: string; priceImpact: string; router: string; latencyMs: number };
          fourmeme?: { estimatedAmount: string; estimatedCost: string; amountMsgValue: string };
          flap?: { estimatedOutput: string; inputAmount: string };
          mode: string;
          broadcast?: { txHash: string; fromAddress: string };
        } = {
          route: result.route,
          tokenAddress: trigger.tokenAddress,
          reason: result.reason,
          platform: result.tokenMarket.platform,
          status: result.tokenMarket.status,
          progress: result.tokenMarket.progress,
          mode: webhookLiveTrading ? "LIVE" : "DRY_RUN",
        };

        if (result.okxResult) {
          summary.okx = {
            fromToken: result.okxResult.fromTokenSymbol,
            toToken: result.okxResult.toTokenSymbol,
            expectedToAmount: result.okxResult.toTokenAmount,
            priceImpact: result.okxResult.priceImpact,
            router: result.okxResult.router,
            latencyMs: result.okxResult.latencyMs,
          };
        }

        if (result.fourmemeQuote) {
          summary.fourmeme = {
            estimatedAmount: result.fourmemeQuote.estimatedAmount,
            estimatedCost: result.fourmemeQuote.estimatedCost,
            amountMsgValue: result.fourmemeQuote.amountMsgValue,
          };
        }

        if (result.flapQuote) {
          summary.flap = {
            estimatedOutput: result.flapQuote.estimatedOutput,
            inputAmount: result.flapQuote.inputAmount,
          };
        }

        // 真实交易模式：签名广播
        if (webhookLiveTrading && result.tx) {
          try {
            const tBroadcastStart = Date.now();
            const broadcastResult = await broadcastSwap(result);
            const tBroadcastDone = Date.now();
            console.log(JSON.stringify({ event: "TIMING", phase: "broadcast", tokenAddress: trigger.tokenAddress, ms: tBroadcastDone - tBroadcastStart, totalMs: tBroadcastDone - t0 }));

            summary.broadcast = {
              txHash: broadcastResult.txHash,
              fromAddress: broadcastResult.fromAddress,
            };
            console.log(JSON.stringify({ event: "TX_BROADCAST", ...broadcastResult }));
            recordEvent("success", "TX_BROADCAST",
              `交易已广播 ${broadcastResult.txHash.slice(0, 14)}...`,
              trigger.tokenAddress,
              { txHash: broadcastResult.txHash, ms: tBroadcastDone - tBroadcastStart },
            );

            // 等待交易确认（超时不代表失败，异步继续追踪）
            const tWaitStart = Date.now();
            let receipt: { status: "success" | "reverted"; blockNumber: bigint } | null = null;
            try {
              receipt = await waitForTx(broadcastResult.txHash);
            } catch (waitErr) {
              if (waitErr instanceof WaitForTxTimeoutError) {
                // 超时：tx 已发出，继续异步轮询，不阻断主流程
                console.log(JSON.stringify({ event: "WAIT_TIMEOUT", txHash: broadcastResult.txHash, note: "tx已广播，后台继续追踪" }));
                recordEvent("info", "WAIT_TIMEOUT",
                  `确认等待超时，后台继续追踪 ${broadcastResult.txHash.slice(0, 14)}...`,
                  trigger.tokenAddress,
                  { txHash: broadcastResult.txHash },
                );
                // 后台异步继续等（最多再等 5 分钟），同时每 10s 主动轮询一次
                void (async () => {
                  const { publicClient } = getBscClients();
                  // 先主动查一次 receipt，有可能已上链只是节点同步延迟
                  for (let i = 0; i < 30; i++) {
                    await new Promise(r => setTimeout(r, 10_000));
                    const r = await publicClient.getTransactionReceipt({ hash: broadcastResult.txHash as `0x${string}` }).catch(() => null);
                    if (!r) continue;
                    if (r.status === "success") {
                      const tokenAmount = result.fourmemeQuote
                        ? BigInt(result.fourmemeQuote.estimatedAmount)
                        : result.flapQuote
                          ? BigInt(result.flapQuote.estimatedOutput)
                          : result.okxResult
                            ? BigInt(result.okxResult.toTokenAmount)
                            : 0n;
                      const costBnb = result.fourmemeQuote
                        ? BigInt(result.fourmemeQuote.amountMsgValue)
                        : result.flapQuote
                          ? BigInt(result.flapQuote.inputAmount)
                          : BigInt(result.tx!.value);
                      const position = positionTracker.addPosition({
                        tokenAddress: trigger.tokenAddress,
                        platform: result.route,
                        tokenPlatform: result.tokenMarket.platform,
                        buyTxHash: broadcastResult.txHash,
                        costBnb,
                        tokenAmount,
                        resonanceWallets: trigger.signals.map((s) => s.walletAddress),
                        chain: "bsc",
                      });
                      console.log(JSON.stringify({ event: "POSITION_ADDED_LATE", positionId: position.id, txHash: broadcastResult.txHash }));
                      recordEvent("success", "POSITION_ADDED",
                        `买入成功（延迟确认）· 持仓已记录`,
                        position.tokenAddress,
                        { positionId: position.id, txHash: broadcastResult.txHash },
                      );
                      fireGmgnOrders(position.id, position.tokenAddress, costBnb, tokenAmount);
                      startConfidenceCheck(
                        position.tokenAddress,
                        position.id,
                        trigger.signals.map(s => s.walletAddress),
                        tokenAmount,
                        costBnb,
                      );
                    } else {
                      console.log(JSON.stringify({ event: "TX_REVERTED_LATE", txHash: broadcastResult.txHash }));
                      recordEvent("error", "TX_REVERTED",
                        `交易被链上回滚（延迟确认）${broadcastResult.txHash.slice(0, 14)}...`,
                        trigger.tokenAddress,
                        { txHash: broadcastResult.txHash },
                      );
                    }
                    publishDashboard();
                    return;
                  }
                  // 5 分钟后仍没有上链，tx 已丢失
                  console.error(JSON.stringify({ event: "TX_DROPPED", txHash: broadcastResult.txHash, note: "tx未上链，可能被节点丢弃" }));
                  recordEvent("error", "TX_DROPPED",
                    `tx 未上链，被节点丢弃 ${broadcastResult.txHash.slice(0, 14)}...`,
                    trigger.tokenAddress,
                    { txHash: broadcastResult.txHash },
                  );
                  publishDashboard();
                })().catch((e) => {
                  console.error(JSON.stringify({ event: "WAIT_BACKGROUND_FAILED", txHash: broadcastResult.txHash, error: e instanceof Error ? e.message : String(e) }));
                });
              } else {
                throw waitErr; // 非超时错误，正常抛出
              }
            }
            const tWaitDone = Date.now();
            if (receipt) {
              console.log(JSON.stringify({ event: "TIMING", phase: "wait_confirm", tokenAddress: trigger.tokenAddress, ms: tWaitDone - tWaitStart, totalMs: tWaitDone - t0, status: receipt.status }));

              if (receipt.status === "success") {
                // 获取代币数量：内盘用报价预估值，外盘用 OKX 返回的 toTokenAmount
                const tokenAmount = result.fourmemeQuote
                  ? BigInt(result.fourmemeQuote.estimatedAmount)
                  : result.flapQuote
                    ? BigInt(result.flapQuote.estimatedOutput)
                    : result.okxResult
                      ? BigInt(result.okxResult.toTokenAmount)
                      : 0n;
                const costBnb = result.fourmemeQuote
                  ? BigInt(result.fourmemeQuote.amountMsgValue)
                  : result.flapQuote
                    ? BigInt(result.flapQuote.inputAmount)
                    : BigInt(result.tx.value);

                // 记录持仓（平台用 tokenMarket.platform，毕业也不变）
                const position = positionTracker.addPosition({
                  tokenAddress: trigger.tokenAddress,
                  platform: result.route,
                  tokenPlatform: result.tokenMarket.platform,
                  buyTxHash: broadcastResult.txHash,
                  costBnb,
                  tokenAmount,
                  resonanceWallets: trigger.signals.map((s) => s.walletAddress),
                  chain: "bsc",
                });
                console.log(JSON.stringify({ event: "POSITION_ADDED", positionId: position.id, tokenAddress: position.tokenAddress, totalMs: Date.now() - t0 }));
                recordEvent("success", "POSITION_ADDED",
                  `买入成功 · 持仓已记录`,
                  position.tokenAddress,
                  { positionId: position.id, totalMs: Date.now() - t0 },
                );
                fireGmgnOrders(position.id, position.tokenAddress, costBnb, tokenAmount);
                startConfidenceCheck(
                  position.tokenAddress,
                  position.id,
                  trigger.signals.map(s => s.walletAddress),
                  tokenAmount,
                  costBnb,
                );
              } else {
                console.log(JSON.stringify({ event: "TX_REVERTED", txHash: broadcastResult.txHash }));
                recordEvent("error", "TX_REVERTED",
                  `交易被链上回滚 ${broadcastResult.txHash.slice(0, 14)}...`,
                  trigger.tokenAddress,
                  { txHash: broadcastResult.txHash },
                );
              }
            } // end if (receipt)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(JSON.stringify({ event: "BROADCAST_FAILED", message }));
            recordEvent("error", "BROADCAST_FAILED",
              `广播失败: ${message}`,
              trigger.tokenAddress,
            );
            dashboard.recordSwapRejected(triggerId, `广播失败: ${message}`);
          }
        }

        dashboard.recordSwapBuilt(triggerId, summary);
        publishDashboard();
        console.log(JSON.stringify({ event: "SWAP_BUILT", ...summary }));
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        recordEvent("error", "SWAP_REJECTED",
          `路由构建失败: ${message}`,
          trigger.tokenAddress,
        );
        dashboard.recordSwapRejected(triggerId, message);
        publishDashboard();
        console.error(
          JSON.stringify({
            event: "SWAP_REJECTED",
            tokenAddress: trigger.tokenAddress,
            message,
          }),
        );
      });
  };

  // ── Rob 链触发处理 ──

  const handleRobTrigger = (trigger: ResonanceTrigger): void => {
    console.log(JSON.stringify(triggerLog(trigger)));
    const triggerId = dashboard.recordTrigger(trigger, Boolean(robSwapConfig), "rob");
    publishDashboard();
    recordEvent("info", "RESONANCE_TRIGGER",
      `[ROB] ${trigger.isSniper ? "🎯 狙击" : `${trigger.signals.length}个錢包共振`}触发 ${trigger.tokenAddress.slice(0, 10)}... (第${positionTracker.getBuyCount(trigger.tokenAddress) + 1}次)`,
      trigger.tokenAddress,
      { chain: "rob", wallets: trigger.signals.length, isSniper: trigger.isSniper, deltaSeconds: ((trigger.triggeredAtMs - Math.min(...trigger.signals.map((s) => s.blockTimestampMs))) / 1000).toFixed(1), buyCount: positionTracker.getBuyCount(trigger.tokenAddress) + 1 },
    );
    if (!robSwapConfig) return;

    // ── 买入次数限制 ──
    const buyCount = positionTracker.getBuyCount(trigger.tokenAddress);
    if (buyCount >= robConfig.maxBuyCount) {
      const msg = `${trigger.tokenAddress.slice(0, 10)}... 已买入 ${buyCount} 次，达到上限 ${robConfig.maxBuyCount}，跳过`;
      console.log(JSON.stringify({ event: "BUY_LIMIT", chain: "rob", tokenAddress: trigger.tokenAddress, buyCount, maxBuyCount: robConfig.maxBuyCount }));
      recordEvent("warn", "BUY_LIMIT", msg, trigger.tokenAddress, { buyCount, maxBuyCount: robConfig.maxBuyCount });
      dashboard.recordSwapRejected(triggerId, msg);
      publishDashboard();
      return;
    }

    const t0 = Date.now();
    void buildRobSwapUnified({
      tokenAddress: trigger.tokenAddress,
      amount: trigger.isSniper
        ? runtimeConfig.getSniperOrderAmountBnb() // 狙击金额共用配置
        : robSwapConfig.amount,
      slippagePercent: trigger.isSniper
        ? runtimeConfig.getSniperSlippagePercent()
        : runtimeConfig.getBuySlippagePercent(),
      walletAddress: process.env.EVM_WALLET_ADDRESS || "",
    })
      .then(async (result: RobSwapBuildResult) => {
        result.isSniper = trigger.isSniper;
        const tBuild = Date.now();
        console.log(JSON.stringify({ event: "TIMING", phase: "rob_build_swap", tokenAddress: trigger.tokenAddress, ms: tBuild - t0, route: result.route }));
        recordEvent("info", "SWAP_BUILT",
          `[ROB] 路由 ${result.route} · ${result.tokenMarket.platform || "unknown"}`,
          trigger.tokenAddress,
          { chain: "rob", route: result.route, ms: tBuild - t0 },
        );

        const summary: {
          chain: string;
          route: string;
          tokenAddress: string;
          reason: string;
          platform: string | null;
          status: string;
          progress: number;
          flap?: { estimatedOutput: string; inputAmount: string };
          uniswap?: { amountIn: string; tokenIn: string; tokenOut: string };
          mode: string;
          broadcast?: { txHash: string; fromAddress: string };
        } = {
          chain: "rob",
          route: result.route,
          tokenAddress: trigger.tokenAddress,
          reason: result.reason,
          platform: result.tokenMarket.platform,
          status: result.tokenMarket.status,
          progress: result.tokenMarket.progress,
          mode: webhookRobLiveTrading ? "LIVE" : "DRY_RUN",
        };

        if (result.flapQuote) {
          summary.flap = {
            estimatedOutput: result.flapQuote.estimatedOutput,
            inputAmount: result.flapQuote.inputAmount,
          };
        }
        if (result.uniswapQuote) {
          summary.uniswap = {
            amountIn: result.uniswapQuote.amountIn,
            tokenIn: result.uniswapQuote.tokenIn,
            tokenOut: result.uniswapQuote.tokenOut,
          };
        }

        // 真实交易模式
        if (webhookRobLiveTrading && result.tx) {
          try {
            const tBroadcastStart = Date.now();
            const broadcastResult = await broadcastRobSwap(result);
            const tBroadcastDone = Date.now();
            console.log(JSON.stringify({ event: "TIMING", phase: "rob_broadcast", tokenAddress: trigger.tokenAddress, ms: tBroadcastDone - tBroadcastStart, totalMs: tBroadcastDone - t0 }));

            summary.broadcast = { txHash: broadcastResult.txHash, fromAddress: broadcastResult.fromAddress };
            console.log(JSON.stringify({ event: "ROB_TX_BROADCAST", ...broadcastResult }));
            recordEvent("success", "TX_BROADCAST",
              `[ROB] 交易已广播 ${broadcastResult.txHash.slice(0, 14)}...`,
              trigger.tokenAddress,
              { chain: "rob", txHash: broadcastResult.txHash, ms: tBroadcastDone - tBroadcastStart },
            );

            let receipt: { status: "success" | "reverted"; blockNumber: bigint } | null = null;
            try {
              receipt = await waitForRobTx(broadcastResult.txHash);
            } catch (waitErr) {
              if (waitErr instanceof WaitForTxTimeoutError) {
                console.log(JSON.stringify({ event: "ROB_WAIT_TIMEOUT", txHash: broadcastResult.txHash }));
                recordEvent("info", "WAIT_TIMEOUT",
                  `[ROB] 确认等待超时，后台继续追踪 ${broadcastResult.txHash.slice(0, 14)}...`,
                  trigger.tokenAddress,
                  { chain: "rob", txHash: broadcastResult.txHash },
                );
                void (async () => {
                  const { publicClient } = getRobClients();
                  for (let i = 0; i < 30; i++) {
                    await new Promise(r => setTimeout(r, 10_000));
                    const r = await publicClient.getTransactionReceipt({ hash: broadcastResult.txHash as `0x${string}` }).catch(() => null);
                    if (!r) continue;
                    if (r.status === "success") {
                      const tokenAmount = result.flapQuote
                        ? BigInt(result.flapQuote.estimatedOutput)
                        : result.uniswapQuote ? BigInt(result.uniswapQuote.amountIn) : 0n;
                      const costBnb = result.flapQuote
                        ? BigInt(result.flapQuote.inputAmount)
                        : BigInt(result.tx!.value);
                      const position = positionTracker.addPosition({
                        tokenAddress: trigger.tokenAddress,
                        platform: result.route,
                        tokenPlatform: result.tokenMarket.platform,
                        buyTxHash: broadcastResult.txHash,
                        costBnb,
                        tokenAmount,
                        resonanceWallets: trigger.signals.map((s) => s.walletAddress),
                        chain: "rob",
                      });
                      recordEvent("success", "POSITION_ADDED",
                        `[ROB] 买入成功（延迟确认）· 持仓已记录`,
                        position.tokenAddress,
                        { chain: "rob", positionId: position.id, txHash: broadcastResult.txHash },
                      );
                    } else {
                      recordEvent("error", "TX_REVERTED",
                        `[ROB] 交易被链上回滚（延迟确认）${broadcastResult.txHash.slice(0, 14)}...`,
                        trigger.tokenAddress,
                        { chain: "rob", txHash: broadcastResult.txHash },
                      );
                    }
                    publishDashboard();
                    return;
                  }
                  recordEvent("error", "TX_DROPPED",
                    `[ROB] tx 未上链，被节点丢弃 ${broadcastResult.txHash.slice(0, 14)}...`,
                    trigger.tokenAddress,
                    { chain: "rob", txHash: broadcastResult.txHash },
                  );
                  publishDashboard();
                })().catch((e) => {
                  console.error(JSON.stringify({ event: "ROB_WAIT_BACKGROUND_FAILED", txHash: broadcastResult.txHash, error: e instanceof Error ? e.message : String(e) }));
                });
              } else {
                throw waitErr;
              }
            }

            if (receipt) {
              if (receipt.status === "success") {
                const tokenAmount = result.flapQuote
                  ? BigInt(result.flapQuote.estimatedOutput)
                  : result.uniswapQuote ? BigInt(result.uniswapQuote.amountIn) : 0n;
                const costBnb = result.flapQuote
                  ? BigInt(result.flapQuote.inputAmount)
                  : BigInt(result.tx.value);
                const position = positionTracker.addPosition({
                  tokenAddress: trigger.tokenAddress,
                  platform: result.route,
                  tokenPlatform: result.tokenMarket.platform,
                  buyTxHash: broadcastResult.txHash,
                  costBnb,
                  tokenAmount,
                  resonanceWallets: trigger.signals.map((s) => s.walletAddress),
                  chain: "rob",
                });
                console.log(JSON.stringify({ event: "ROB_POSITION_ADDED", positionId: position.id, tokenAddress: position.tokenAddress, totalMs: Date.now() - t0 }));
                recordEvent("success", "POSITION_ADDED",
                  `[ROB] 买入成功 · 持仓已记录`,
                  position.tokenAddress,
                  { chain: "rob", positionId: position.id, totalMs: Date.now() - t0 },
                );
              } else {
                recordEvent("error", "TX_REVERTED",
                  `[ROB] 交易被链上回滚 ${broadcastResult.txHash.slice(0, 14)}...`,
                  trigger.tokenAddress,
                  { chain: "rob", txHash: broadcastResult.txHash },
                );
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(JSON.stringify({ event: "ROB_BROADCAST_FAILED", message }));
            recordEvent("error", "BROADCAST_FAILED",
              `[ROB] 广播失败: ${message}`,
              trigger.tokenAddress,
              { chain: "rob" },
            );
            dashboard.recordSwapRejected(triggerId, `[ROB] 广播失败: ${message}`);
          }
        }

        dashboard.recordSwapBuilt(triggerId, summary);
        publishDashboard();
        console.log(JSON.stringify({ event: "ROB_SWAP_BUILT", ...summary }));
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        recordEvent("error", "SWAP_REJECTED",
          `[ROB] 路由构建失败: ${message}`,
          trigger.tokenAddress,
          { chain: "rob" },
        );
        dashboard.recordSwapRejected(triggerId, `[ROB] ${message}`);
        publishDashboard();
        console.error(JSON.stringify({ event: "ROB_SWAP_REJECTED", tokenAddress: trigger.tokenAddress, message }));
      });
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    // ── 登录页 & 登录 API（无需认证）──

    if (request.method === "GET" && url.pathname === "/login") {
      serveLoginHtml(response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/login") {
      try {
        const body = await readRequestBody(request, 4096);
        const parsed = JSON.parse(decodedBody(request, body)) as { password?: string };
        if (parsed.password === DASHBOARD_PASSWORD) {
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            "set-cookie": `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
          });
          response.end(JSON.stringify({ ok: true }));
        } else {
          json(response, 401, { ok: false, error: "密码错误" });
        }
      } catch {
        json(response, 400, { ok: false, error: "请求格式错误" });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/logout") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`,
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    // favicon 无需认证
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    // webhook 端点无需认证（QuickNode 投递）
    if (ALL_WEBHOOK_PATHS.has(url.pathname)) {
      // 继续往下走 webhook 处理逻辑
    } else if (!isAuthenticated(request)) {
      // 未认证 → 重定向到登录页
      response.writeHead(302, { location: "/login" });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      asset(response, "text/html; charset=utf-8", frontendIndex);
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
      const relPath = url.pathname.slice(1); // remove leading /
      const filePath = path.join(frontendDir, relPath);
      const resolved = path.resolve(filePath);
      // Path traversal guard
      if (!resolved.startsWith(frontendDir + path.sep)) {
        response.writeHead(403); response.end("Forbidden"); return;
      }
      try {
        if (!statSync(resolved).isFile()) {
          response.writeHead(404); response.end("Not Found"); return;
        }
      } catch {
        response.writeHead(404); response.end("Not Found"); return;
      }
      const ext = path.extname(resolved);
      const mimeMap: Record<string, string> = {
        ".js": "application/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
      };
      const mime = mimeMap[ext] || "application/octet-stream";
      const content = readFileSync(resolved);
      response.writeHead(200, {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": mime,
        "content-length": content.length,
      });
      response.end(content);
      return;
    }
    if (request.method === "GET" && url.pathname === "/howler.min.js") {
      asset(response, "text/javascript; charset=utf-8", howlerJs);
      return;
    }
    if (request.method === "GET" && (url.pathname === "/siren.wav" || url.pathname === "/siren.mp3")) {
      response.writeHead(200, {
        "cache-control": "no-cache",
        "content-type": url.pathname.endsWith(".mp3") ? "audio/mpeg" : "audio/wav",
        "content-length": sirenWav.length,
      });
      response.end(sirenWav);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      json(response, 200, dashboard.snapshot());
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });
      response.write(
        `event: state\ndata: ${JSON.stringify(dashboard.snapshot())}\n\n`,
      );
      sseClients.add(response);
      request.on("close", () => sseClients.delete(response));
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, {
        ok: true,
        mode: webhookLiveTrading ? "LIVE" : "DRY_RUN",
        walletFilter,
        threshold: config.threshold,
        windowSeconds: config.windowMs / 1_000,
        dashboard: "/",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/logs") {
      const limit = Number(url.searchParams.get("limit")) || 100;
      const level = url.searchParams.get("level") || "";
      const entries = eventLog
        .filter((e) => !level || e.level === level)
        .slice(-limit);
      json(response, 200, entries);
      return;
    }
    if (request.method === "GET" && url.pathname === "/log-events") {
      response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });
      // Send existing log buffer first
      for (const entry of eventLog) {
        response.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
      }
      logSseClients.add(response);
      request.on("close", () => logSseClients.delete(response));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/test/trigger") {
      // 仅用于测试通知/UI，不构建交易、不广播
      const testToken = "0x1111111111111111111111111111111111111111";
      const nowMs = Date.now();
      const testTrigger: ResonanceTrigger = {
        chainId: 56,
        tokenAddress: testToken,
        triggeredAtMs: nowMs,
        isSniper: false,
        signals: [
          {
            chainId: 56,
            tokenAddress: testToken,
            walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            txHash: `0x${"a".repeat(64)}`,
            blockTimestampMs: nowMs - 500,
          },
          {
            chainId: 56,
            tokenAddress: testToken,
            walletAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            txHash: `0x${"b".repeat(64)}`,
            blockTimestampMs: nowMs - 250,
          },
        ],
      };
      const triggerId = dashboard.recordTrigger(testTrigger, false, "bsc");
      publishDashboard();
      json(response, 200, { ok: true, triggerId, test: true });
      return;
    }
    // ── GMGN 挂单 API ──

    if (request.method === "GET" && url.pathname === "/api/gmgn/config") {
      json(response, 200, loadGmgnConfig());
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/gmgn/config") {
      const rawBody = await readRequestBody(request, 4096);
      const body = JSON.parse(decodedBody(request, rawBody)) as Record<string, unknown>;
      const current = loadGmgnConfig();
      const updated = {
        ...current,
        ...(body.enabled !== undefined ? { enabled: !!body.enabled } : {}),
        ...(body.stopLossPercent !== undefined ? { stopLossPercent: Number(body.stopLossPercent) } : {}),
        ...(body.takeProfit1Percent !== undefined ? { takeProfit1Percent: Number(body.takeProfit1Percent) } : {}),
        ...(body.takeProfit1Ratio !== undefined ? { takeProfit1Ratio: Number(body.takeProfit1Ratio) } : {}),
        ...(body.takeProfit2Percent !== undefined ? { takeProfit2Percent: Number(body.takeProfit2Percent) } : {}),
        ...(body.takeProfit2Ratio !== undefined ? { takeProfit2Ratio: Number(body.takeProfit2Ratio) } : {}),
      };
      gmgnOrderEngine.setConfig(updated);
      json(response, 200, updated);
      return;
    }

    // GET /api/gmgn/orders/:positionId
    const gmgnOrdersMatch = url.pathname.match(/^\/api\/gmgn\/orders\/([^/]+)$/);
    if (request.method === "GET" && gmgnOrdersMatch) {
      const posId = decodeURIComponent(gmgnOrdersMatch[1]!);
      const pos = positionTracker.getPosition(posId);
      if (!pos) { json(response, 404, { error: "持仓不存在" }); return; }
      json(response, 200, { positionId: posId, gmgnOrders: pos.gmgnOrders || [] });
      return;
    }

    // PUT /api/gmgn/orders/:positionId — 修改挂单（取消旧的 + 创建新的）
    if (request.method === "PUT" && gmgnOrdersMatch) {
      const posId = decodeURIComponent(gmgnOrdersMatch[1]!);
      const pos = positionTracker.getPosition(posId);
      if (!pos) { json(response, 404, { error: "持仓不存在" }); return; }

      const rawBody = await readRequestBody(request, 4096);
      const body = JSON.parse(decodedBody(request, rawBody)) as Record<string, unknown>;
      const walletAddress = process.env.EVM_WALLET_ADDRESS || "";
      if (!walletAddress) { json(response, 400, { error: "未配置执行钱包" }); return; }

      const existingIds = (pos.gmgnOrders || []).filter(o => o.orderId && o.orderId !== "unknown").map(o => o.orderId);
      const newConfig = { ...loadGmgnConfig(), ...body };

      try {
        const results = await gmgnOrderEngine.replaceOrders({
          positionId: posId,
          tokenAddress: pos.tokenAddress,
          walletAddress,
          buyPriceBnb: (Number(pos.entryPrice) / 1e18).toFixed(18),
          tokenBalance: pos.tokenAmount.toString(),
          config: newConfig,
          existingOrderIds: existingIds,
        });
        const orders: GmgnOrderInfo[] = results.map(r => ({
          orderId: r.orderId,
          type: r.subOrderType,
          label: r.label,
          checkPriceUsd: r.checkPriceUsd,
          amount: r.amount,
          sellPercent: r.sellPercent,
          status: r.status === "created" ? "open" as const : "unknown" as const,
          createdAtMs: Date.now(),
        }));
        positionTracker.setGmgnOrders(posId, orders);
        json(response, 200, { ok: true, orders });
      } catch (e) {
        json(response, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    // DELETE /api/gmgn/orders/:positionId/:orderId
    const gmgnCancelMatch = url.pathname.match(/^\/api\/gmgn\/orders\/([^/]+)\/([^/]+)$/);
    if (request.method === "DELETE" && gmgnCancelMatch) {
      const posId = decodeURIComponent(gmgnCancelMatch[1]!);
      const orderId = decodeURIComponent(gmgnCancelMatch[2]!);
      const walletAddress = process.env.EVM_WALLET_ADDRESS || "";
      try {
        await gmgnOrderEngine.cancelOrder(walletAddress, orderId);
        positionTracker.updateGmgnOrderStatus(posId, orderId, "cancelled");
        json(response, 200, { ok: true });
      } catch (e) {
        json(response, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    // ── Settings API ──

    if (request.method === "GET" && url.pathname === "/api/settings") {
      const executorAddress = getExecutorAddress();
      json(response, 200, {
        watchedWallets: [...engine.getWatchedWallets()],
        watchedWalletCount: engine.getWatchedWallets().size,
        blacklistedWallets: [...engine.getBlacklistedWallets()],
        blacklistedWalletCount: engine.getBlacklistedWallets().size,
        orderAmountBnb: orderAmountBnb,
        executorAddress,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/settings/wallets.txt") {
      const wallets = [...engine.getWatchedWallets()].sort();
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename=wallets.txt",
      });
      response.end(wallets.join("\n") + "\n");
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/settings/blacklist.txt") {
      const wallets = [...engine.getBlacklistedWallets()].sort();
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": "attachment; filename=blacklist.txt",
      });
      response.end(wallets.join("\n") + "\n");
      return;
    }

    if ((request.method === "PUT" || request.method === "POST") &&
        (url.pathname === "/api/settings/wallets" || url.pathname === "/api/settings/blacklist")) {
      const isBlacklist = url.pathname.includes("blacklist");
      const isReplace = request.method === "PUT";
      try {
        const body = await readRequestBody(request, 1024 * 1024);
        const parsed = JSON.parse(decodedBody(request, body)) as { wallets?: string[] };
        // 去重 + 验证
        const rawWallets = (parsed.wallets || [])
          .map((w: string) => w.trim().toLowerCase());
        const invalidWallets = rawWallets.filter((w: string) => w && !/^0x[0-9a-f]{40}$/.test(w));
        if (invalidWallets.length > 0) {
          json(response, 400, { ok: false, error: "包含无效地址" });
          return;
        }
        const newWallets = [...new Set(rawWallets.filter(Boolean))];

        if (isBlacklist) {
          if (isReplace) {
            engine.setBlacklistedWallets(new Set(newWallets));
          } else {
            engine.addBlacklistedWallets(new Set(newWallets));
          }
          // 持久化黑名单
          writeFileSync(blacklistPath, [...engine.getBlacklistedWallets()].sort().join("\n") + "\n");
        } else {
          if (isReplace) {
            engine.setWatchedWallets(new Set(newWallets));
          } else {
            engine.addWatchedWallets(new Set(newWallets));
          }
          // 持久化钱包列表
          const walletListPath = process.env.WALLET_LIST_PATH?.trim();
          if (walletListPath) {
            const filePath = path.resolve(process.cwd(), walletListPath);
            writeFileSync(filePath, [...engine.getWatchedWallets()].sort().join("\n") + "\n");
          }
          // 更新 dashboard config
          (dashboard as any).config.walletFilter = `${engine.getWatchedWallets().size} local wallets`;
        }
        publishDashboard();
        json(response, 200, {
          ok: true,
          watchedWalletCount: engine.getWatchedWallets().size,
          blacklistedWalletCount: engine.getBlacklistedWallets().size,
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        json(response, 400, { ok: false, error: msg });
      }
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/settings/order-amount") {
      try {
        const body = await readRequestBody(request, 4096);
        const parsed = JSON.parse(decodedBody(request, body)) as { amount?: string };
        const amount = parsed.amount?.trim();
        if (!amount || !/^\d*\.?\d+$/.test(amount) || Number(amount) <= 0) {
          json(response, 400, { ok: false, error: "金额必须为正数字" });
          return;
        }
        orderAmountBnb = amount;
        if (swapConfig) swapConfig.amount = amount;
        (dashboard as any).config.orderAmountBnb = amount;
        // 持久化运行时配置
        const cfg = runtimeConfig.getAll();
        cfg.orderAmountBnb = amount;
        runtimeConfig.save(cfg);
        publishDashboard();
        json(response, 200, { ok: true, orderAmountBnb: amount });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        json(response, 400, { ok: false, error: msg });
      }
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/settings/executor") {
      try {
        const body = await readRequestBody(request, 4096);
        const parsed = JSON.parse(decodedBody(request, body)) as { privateKey?: string };
        const raw = parsed.privateKey?.trim();
        if (!raw) {
          json(response, 400, { ok: false, error: "请提供私钥" });
          return;
        }
        const key = raw.startsWith("0x") ? raw : `0x${raw}`;
        if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
          json(response, 400, { ok: false, error: "私钥格式无效（需 32 字节十六进制）" });
          return;
        }
        const account = privateKeyToAccount(key as Hex);
        // 更新环境变量（broadcast.ts 每次调用时读取）
        process.env.EVM_PRIVATE_KEY = raw;
        // 更新 dashboard config
        (dashboard as any).config.executorAddress = account.address.toLowerCase();
        // 持久化到运行时配置
        const cfg = runtimeConfig.getAll();
        cfg.evmPrivateKey = raw;
        runtimeConfig.save(cfg);
        publishDashboard();
        json(response, 200, {
          ok: true,
          executorAddress: account.address.toLowerCase(),
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        json(response, 400, { ok: false, error: msg });
      }
      return;
    }

    // ── 共振组合排除 API ──
    if (request.method === "GET" && url.pathname === "/api/settings/excluded-combos") {
      const combos = excludedCombos.getAllExcluded();
      json(response, 200, { ok: true, combos });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/excluded-combos") {
      try {
        const body = await readRequestBody(request, 4096);
        const parsed = JSON.parse(decodedBody(request, body)) as {
          walletA?: string;
          walletB?: string;
        };
        const walletA = parsed.walletA?.trim().toLowerCase();
        const walletB = parsed.walletB?.trim().toLowerCase();
        if (!walletA || !walletB) {
          json(response, 400, { ok: false, error: "请提供两个钱包地址" });
          return;
        }
        if (!/^0x[0-9a-f]{40}$/.test(walletA) || !/^0x[0-9a-f]{40}$/.test(walletB)) {
          json(response, 400, { ok: false, error: "钱包地址格式无效" });
          return;
        }
        if (walletA === walletB) {
          json(response, 400, { ok: false, error: "不能排除同一个钱包" });
          return;
        }
        const added = excludedCombos.addExcluded(walletA, walletB);
        recordEvent("info", "COMBO_EXCLUDED", "添加共振排除组合", undefined, { walletA, walletB });
        json(response, 200, { ok: true, added, walletA, walletB });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        json(response, 400, { ok: false, error: msg });
      }
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/api/settings/excluded-combos") {
      try {
        const body = await readRequestBody(request, 4096);
        const parsed = JSON.parse(decodedBody(request, body)) as {
          walletA?: string;
          walletB?: string;
        };
        const walletA = parsed.walletA?.trim().toLowerCase();
        const walletB = parsed.walletB?.trim().toLowerCase();
        if (!walletA || !walletB) {
          json(response, 400, { ok: false, error: "请提供两个钱包地址" });
          return;
        }
        const removed = excludedCombos.removeExcluded(walletA, walletB);
        recordEvent("info", "COMBO_INCLUDED", "移除共振排除组合", undefined, { walletA, walletB });
        json(response, 200, { ok: true, removed, walletA, walletB });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        json(response, 400, { ok: false, error: msg });
      }
      return;
    }

    // ── 毒钱包 API ──
    if (request.method === "GET" && url.pathname === "/api/settings/poison-wallets") {
      const wallets = poisonWallets.getAllPoisonWallets();
      const tokenBlacklist = poisonWallets.getTokenBlacklistEntries();
      json(response, 200, { ok: true, wallets, tokenBlacklist });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/poison-wallets") {
      try {
        const body = await readRequestBody(request, 4096);
        const parsed = JSON.parse(decodedBody(request, body)) as { wallet?: string };
        const wallet = parsed.wallet?.trim().toLowerCase();
        if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) {
          json(response, 400, { ok: false, error: "钱包地址格式无效" });
          return;
        }
        const added = poisonWallets.addPoisonWallet(wallet);
        recordEvent("warn", "POISON_WALLET_ADDED", `\u6dfb\u52a0\u6bd2\u94b1\u5305 ${wallet.slice(0, 10)}...`, undefined, { wallet });
        json(response, 200, { ok: true, added, wallet });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        json(response, 400, { ok: false, error: msg });
      }
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/api/settings/poison-wallets") {
      try {
        const body = await readRequestBody(request, 4096);
        const parsed = JSON.parse(decodedBody(request, body)) as { wallet?: string };
        const wallet = parsed.wallet?.trim().toLowerCase();
        if (!wallet) {
          json(response, 400, { ok: false, error: "\u8bf7\u63d0\u4f9b\u94b1\u5305\u5730\u5740" });
          return;
        }
        const removed = poisonWallets.removePoisonWallet(wallet);
        recordEvent("info", "POISON_WALLET_REMOVED", `\u79fb\u9664\u6bd2\u94b1\u5305 ${wallet.slice(0, 10)}...`, undefined, { wallet });
        json(response, 200, { ok: true, removed, wallet });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        json(response, 400, { ok: false, error: msg });
      }
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/api/settings/token-blacklist") {
      try {
        const body = await readRequestBody(request, 4096);
        const parsed = JSON.parse(decodedBody(request, body)) as { token?: string };
        const token = parsed.token?.trim().toLowerCase();
        if (!token) {
          json(response, 400, { ok: false, error: "\u8bf7\u63d0\u4f9b\u4ee3\u5e01\u5730\u5740" });
          return;
        }
        const removed = poisonWallets.unblacklistToken(token);
        if (removed) engine.removeBlacklistedToken(token);
        recordEvent("info", "TOKEN_UNBLACKLISTED", `\u79fb\u9664\u4ee3\u5e01\u9ed1\u540d\u5355 ${token.slice(0, 10)}...`, token);
        json(response, 200, { ok: true, removed, token });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        json(response, 400, { ok: false, error: msg });
      }
      return;
    }

    // ── 共振组合分析 API ──
    if (request.method === "GET" && url.pathname === "/api/analysis/combos") {
      const positions = positionTracker.getPositions();
      // 聚合：combo(排序后的钱包对) → 次数 + 代币列表
      const comboMap = new Map<string, { wallets: string[]; tokens: string[]; count: number; lastAtMs: number }>();
      for (const pos of positions) {
        if (!pos.resonanceWallets || pos.resonanceWallets.length < 2) continue;
        const sorted = [...pos.resonanceWallets].sort();
        const key = sorted.join("|");
        const existing = comboMap.get(key);
        if (existing) {
          existing.count += 1;
          existing.lastAtMs = Math.max(existing.lastAtMs, pos.boughtAtMs);
          if (!existing.tokens.includes(pos.tokenAddress)) {
            existing.tokens.push(pos.tokenAddress);
          }
        } else {
          comboMap.set(key, {
            wallets: sorted,
            tokens: [pos.tokenAddress],
            count: 1,
            lastAtMs: pos.boughtAtMs,
          });
        }
      }
      const combos = [...comboMap.values()].sort((a, b) => b.count - a.count);
      json(response, 200, { ok: true, combos });
      return;
    }

    // ── Dev 钱包 API（狙击模式）──
    if (request.method === "GET" && url.pathname === "/api/settings/dev-wallets") {
      const wallets = devWallets.getAllDevWallets();
      json(response, 200, { ok: true, wallets, count: wallets.length });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/dev-wallets") {
      try {
        const body = await readRequestBody(request, 4096);
        const parsed = JSON.parse(decodedBody(request, body)) as { wallet?: string };
        const wallet = parsed.wallet?.trim().toLowerCase();
        if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) {
          json(response, 400, { ok: false, error: "钱包地址格式无效" });
          return;
        }
        const added = devWallets.addDevWallet(wallet);
        recordEvent("info", "DEV_WALLET_ADDED", `添加狙击钱包 ${wallet.slice(0, 10)}...`, undefined, { wallet });
        json(response, 200, { ok: true, added, wallet });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        json(response, 400, { ok: false, error: msg });
      }
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/api/settings/dev-wallets") {
      try {
        const body = await readRequestBody(request, 4096);
        const parsed = JSON.parse(decodedBody(request, body)) as { wallet?: string };
        const wallet = parsed.wallet?.trim().toLowerCase();
        if (!wallet) {
          json(response, 400, { ok: false, error: "请提供钱包地址" });
          return;
        }
        const removed = devWallets.removeDevWallet(wallet);
        recordEvent("info", "DEV_WALLET_REMOVED", `移除狙击钱包 ${wallet.slice(0, 10)}...`, undefined, { wallet });
        json(response, 200, { ok: true, removed, wallet });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        json(response, 400, { ok: false, error: msg });
      }
      return;
    }

    // ── 交易配置 API（gas/slippage）──
    if (request.method === "GET" && url.pathname === "/api/settings/trading") {
      const all = runtimeConfig.getAll();
      json(response, 200, {
        ok: true,
        gasPriceGwei: runtimeConfig.getGasPriceGwei(),
        gasPriceByRoute: all.gasPriceByRoute || {},
        maxGasCostBnb: runtimeConfig.getMaxGasCostBnb(),
        buySlippagePercent: runtimeConfig.getBuySlippagePercent(),
        sellSlippagePercent: runtimeConfig.getSellSlippagePercent(),
        // 狙击配置
        sniperGasPriceGwei: all.sniperGasPriceGwei || "",
        sniperSlippagePercent: all.sniperSlippagePercent || "30",
        sniperOrderAmountBnb: all.sniperOrderAmountBnb || "",
        sniperCooldownSeconds: all.sniperCooldownSeconds ?? 600,
        secondBuyCooldownSeconds: runtimeConfig.getSecondBuyCooldownSeconds(),
        defaultCooldownSeconds: runtimeConfig.getDefaultCooldownSeconds(),
        resonanceTriggerThrottleSeconds: runtimeConfig.getResonanceThrottleSeconds(),
        confidenceCheckSeconds: runtimeConfig.getConfidenceCheckSeconds(),
      });
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/settings/trading") {
      try {
        const body = await readRequestBody(request, 4096);
        const parsed = JSON.parse(decodedBody(request, body)) as {
          gasPriceGwei?: string;
          gasPriceByRoute?: Record<string, string>;
          maxGasCostBnb?: string;
          buySlippagePercent?: string;
          sellSlippagePercent?: string;
          sniperGasPriceGwei?: string;
          sniperSlippagePercent?: string;
          sniperOrderAmountBnb?: string;
          sniperCooldownSeconds?: number;
          secondBuyCooldownSeconds?: number;
          defaultCooldownSeconds?: number;
          resonanceTriggerThrottleSeconds?: number;
          confidenceCheckSeconds?: number;
        };
        const cfg = runtimeConfig.getAll();
        if (parsed.gasPriceGwei !== undefined) cfg.gasPriceGwei = parsed.gasPriceGwei;
        if (parsed.gasPriceByRoute !== undefined) {
          const routeConfig: { fourmeme_inner?: string; flap_inner?: string; okx_dex?: string } = {};
          if (parsed.gasPriceByRoute.fourmeme_inner) routeConfig.fourmeme_inner = parsed.gasPriceByRoute.fourmeme_inner;
          if (parsed.gasPriceByRoute.flap_inner) routeConfig.flap_inner = parsed.gasPriceByRoute.flap_inner;
          if (parsed.gasPriceByRoute.okx_dex) routeConfig.okx_dex = parsed.gasPriceByRoute.okx_dex;
          cfg.gasPriceByRoute = routeConfig;
        }
        if (parsed.maxGasCostBnb !== undefined) cfg.maxGasCostBnb = parsed.maxGasCostBnb;
        if (parsed.buySlippagePercent !== undefined) cfg.buySlippagePercent = parsed.buySlippagePercent;
        if (parsed.sellSlippagePercent !== undefined) cfg.sellSlippagePercent = parsed.sellSlippagePercent;
        // 狙击配置
        if (parsed.sniperGasPriceGwei !== undefined) {
          if (parsed.sniperGasPriceGwei) cfg.sniperGasPriceGwei = parsed.sniperGasPriceGwei;
          else delete cfg.sniperGasPriceGwei;
        }
        if (parsed.sniperSlippagePercent !== undefined) cfg.sniperSlippagePercent = parsed.sniperSlippagePercent;
        if (parsed.sniperOrderAmountBnb !== undefined) {
          if (parsed.sniperOrderAmountBnb) cfg.sniperOrderAmountBnb = parsed.sniperOrderAmountBnb;
          else delete cfg.sniperOrderAmountBnb;
        }
        if (parsed.sniperCooldownSeconds !== undefined) cfg.sniperCooldownSeconds = parsed.sniperCooldownSeconds;
        if (parsed.secondBuyCooldownSeconds !== undefined) cfg.secondBuyCooldownSeconds = parsed.secondBuyCooldownSeconds;
        if (parsed.defaultCooldownSeconds !== undefined) cfg.defaultCooldownSeconds = parsed.defaultCooldownSeconds;
        if (parsed.resonanceTriggerThrottleSeconds !== undefined) cfg.resonanceTriggerThrottleSeconds = parsed.resonanceTriggerThrottleSeconds;
        if (parsed.confidenceCheckSeconds !== undefined) cfg.confidenceCheckSeconds = parsed.confidenceCheckSeconds;
        runtimeConfig.save(cfg);
        recordEvent("info", "CONFIG_UPDATED", "交易配置已更新", undefined, cfg as Record<string, unknown>);
        json(response, 200, { ok: true });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        json(response, 400, { ok: false, error: msg });
      }
      return;
    }

    if (request.method !== "POST" || !ALL_WEBHOOK_PATHS.has(url.pathname)) {
      json(response, 404, { ok: false });
      return;
    }

    try {
      const receivedAtMs = Date.now();
      const rawBody = await readRequestBody(request, config.maxBodyBytes);
      const body = decodedBody(request, rawBody);

      // 根据路径判断是 BSC 还是 Rob 链 webhook
      const isRobWebhook = ROB_WEBHOOK_PATHS.has(url.pathname);

      // 验签：各链独立密钥
      if (isRobWebhook) {
        if (quickNodeRobSecret) {
          const verification = verifySignature(request, body, quickNodeRobSecret);
          if (!verification.ok) {
            json(response, 401, { ok: false, error: verification.message });
            return;
          }
          if (verification.replay) {
            // 同一 nonce 的重试投递，已处理过，幂等返回 200
            json(response, 200, { ok: true, queued: false, replay: true, chain: "rob" });
            return;
          }
        }
      } else {
        if (quickNodeSecret) {
          const verification = verifySignature(request, body, quickNodeSecret);
          if (!verification.ok) {
            json(response, 401, { ok: false, error: verification.message });
            return;
          }
          if (verification.replay) {
            // 同一 nonce 的重试投递，已处理过，幂等返回 200
            json(response, 200, { ok: true, queued: false, replay: true, chain: "bsc" });
            return;
          }
        }
      }

      // 快速返回 200，避免阻塞 QuickNode 投递；实际处理交给后台队列
      if (webhookQueue.length >= MAX_WEBHOOK_QUEUE_SIZE) {
        webhookQueue.shift(); // 丢弃最旧的，防止内存无限增长
      }
      webhookQueue.push({ body, receivedAtMs, chain: isRobWebhook ? "rob" : "bsc" });

      json(response, 200, { ok: true, queued: true, chain: isRobWebhook ? "rob" : "bsc" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message === "PAYLOAD_TOO_LARGE" ? 413 : 200;
      json(response, statusCode, { ok: statusCode === 200, error: message });
    }
  });

  const keepAlive = setInterval(() => {
    for (const client of sseClients) client.write(": keepalive\n\n");
  }, 15_000);
  keepAlive.unref();

  server.listen(config.webhookPort, config.webhookHost, () => {
    console.log(
      JSON.stringify({
        event: "WEBHOOK_SERVER_READY",
        dashboard: `http://${config.webhookHost}:${config.webhookPort}/`,
        bsc: {
          webhookPaths: [...WEBHOOK_PATHS],
          walletFilter,
          threshold: config.threshold,
          windowSeconds: config.windowMs / 1_000,
          cooldownSeconds: config.cooldownMs / 1_000,
          signatureVerification: Boolean(quickNodeSecret),
          liveTrading: webhookLiveTrading,
        },
        rob: {
          webhookPaths: [...ROB_WEBHOOK_PATHS],
          walletFilter: robWalletFilter,
          threshold: robConfig.threshold,
          windowSeconds: robConfig.windowMs / 1_000,
          cooldownSeconds: robConfig.cooldownMs / 1_000,
          signatureVerification: Boolean(quickNodeRobSecret),
          liveTrading: webhookRobLiveTrading,
        },
        displayWallets: displayWallets.size,
        displayWalletsPath,
      }),
    );
  });

  const shutdown = (): void => {
    clearInterval(keepAlive);
    // autoSellEngine.stop(); // 已停用
    for (const client of sseClients) client.end();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`webhook server failed: ${message}`);
  process.exitCode = 1;
});
