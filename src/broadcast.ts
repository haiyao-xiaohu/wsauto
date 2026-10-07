/**
 * BSC 和 Rob 链交易执行模块
 *
 * 统一处理两条链的签名和广播：
 *   - BSC： legacy type:0（BSC 不支持 EIP-1559）
 *   - Rob 链（Arbitrum L2）： EIP-1559 type:2，gas 以 ETH 计价
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseGwei,
  parseEther,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import type { BscSwapBuildResult } from "./bsc-swap-builder.js";
import type { RobSwapBuildResult } from "./rob-swap-builder.js";
import { parseBscRpcUrls, parseRobRpcUrls } from "./rpc.js";
import { robinhoodChain } from "./flap-rob-swap.js";
import * as runtimeConfig from "./runtime-config.js";

// ── RPC 配置 ──

// 判断是否为可重试的 RPC 错误（限流、超时、服务端 5xx）
function isRetryableRpcError(error: unknown): boolean {
  if (error == null) return false;
  const message = String(
    (error instanceof Error ? error.message : error) ?? "",
  ).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("timeout") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("504") ||
    message.includes("econnrefused") ||
    message.includes("econnreset")
  );
}

interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
}

// 指数退避重试（针对限流/瞬时失败）
async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 500);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 4_000);
  const label = options.label ? `[${options.label}] ` : "";

  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isRetryable = isRetryableRpcError(error);
      const isLast = i === attempts - 1;
      if (!isRetryable || isLast) throw error;

      const delay = Math.min(baseDelayMs * 2 ** i, maxDelayMs);
      console.log(
        JSON.stringify({
          event: "RPC_RETRY",
          attempt: i + 1,
          nextAttempt: i + 2,
          delayMs: delay,
          label: options.label,
          error:
            error instanceof Error ? error.message : String(error),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// ── Nonce 管理 ──
// 防止并发广播时 nonce 冲突（replacement transaction underpriced）
let nonceTracker: { address: string; nextNonce: number } | null = null;
let broadcastLock: Promise<void> = Promise.resolve();

async function acquireNonce(
  publicClient: { getTransactionCount: (args: { address: `0x${string}`; includePending?: boolean }) => Promise<number> },
  address: `0x${string}`,
): Promise<number> {
  // 从链上获取 pending nonce，与本地追踪取较大值
  const chainNonce = await withRetry(
    () =>
      publicClient.getTransactionCount({
        address,
        includePending: true,
      }),
    { label: "getTransactionCount" },
  );
  if (!nonceTracker || nonceTracker.address !== address) {
    nonceTracker = { address, nextNonce: chainNonce };
  }
  const nonce = Math.max(chainNonce, nonceTracker.nextNonce);
  nonceTracker.nextNonce = nonce + 1;
  return nonce;
}

// ── Client 工厂 ──

export function getBscClients(preferredIndex = 0) {
  const privateKey = process.env.EVM_PRIVATE_KEY?.trim();
  const rpcUrls = parseBscRpcUrls();

  if (!privateKey) throw new Error("EVM_PRIVATE_KEY 未配置");
  if (rpcUrls.length === 0) throw new Error("BSC_RPC_URL 未配置");

  const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("EVM_PRIVATE_KEY 格式无效");
  }

  const rpcUrlIndex = Math.max(0, Math.min(preferredIndex, rpcUrls.length - 1));
  const rpcUrl = rpcUrls[rpcUrlIndex];
  console.log(`[RPC] getBscClients → #${rpcUrlIndex}/${rpcUrls.length}`);

  const account = privateKeyToAccount(key as Hex);
  const publicClient = createPublicClient({
    chain: bsc,
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }),
  });
  const walletClient = createWalletClient({
    account,
    chain: bsc,
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }),
  });

  return {
    account,
    publicClient,
    walletClient,
    rpcUrl,
    rpcUrlIndex,
    rpcUrls,
  };
}

export type BscClients = ReturnType<typeof getBscClients>;

// 切换到下一个 RPC URL（轮询）
function rotateBscClients(current: BscClients): BscClients {
  const nextIndex = (current.rpcUrlIndex + 1) % current.rpcUrls.length;
  return getBscClients(nextIndex);
}

// ── Rob 链 Client 工厂 ──

export function getRobClients(preferredIndex = 0) {
  const privateKey = process.env.EVM_PRIVATE_KEY?.trim();
  const rpcUrls = parseRobRpcUrls();

  if (!privateKey) throw new Error("EVM_PRIVATE_KEY 未配置");
  if (rpcUrls.length === 0) throw new Error("ROBINHOOD_RPC_URL 未配置");

  const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("EVM_PRIVATE_KEY 格式无效");
  }

  const rpcUrlIndex = Math.max(0, Math.min(preferredIndex, rpcUrls.length - 1));
  const rpcUrl = rpcUrls[rpcUrlIndex]!;

  const account = privateKeyToAccount(key as Hex);
  // 动态使用当前配置的 RPC URL
  const chainWithRpc = { ...robinhoodChain, rpcUrls: { default: { http: [rpcUrl] } } };
  const publicClient = createPublicClient({
    chain: chainWithRpc,
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }),
  });
  const walletClient = createWalletClient({
    account,
    chain: chainWithRpc,
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }),
  });

  return {
    account,
    publicClient,
    walletClient,
    rpcUrl,
    rpcUrlIndex,
    rpcUrls,
  };
}

export type RobClients = ReturnType<typeof getRobClients>;

// ── Rob 链 Nonce 管理 ──
// Rob 链使用独立的 nonce 追踪，避免与 BSC 混淆
let robNonceTracker: { address: string; nextNonce: number } | null = null;
let robBroadcastLock: Promise<void> = Promise.resolve();

async function acquireRobNonce(
  publicClient: { getTransactionCount: (args: { address: `0x${string}`; includePending?: boolean }) => Promise<number> },
  address: `0x${string}`,
): Promise<number> {
  const chainNonce = await withRetry(
    () => publicClient.getTransactionCount({ address, includePending: true }),
    { label: "rob_getTransactionCount" },
  );
  if (!robNonceTracker || robNonceTracker.address !== address) {
    robNonceTracker = { address, nextNonce: chainNonce };
  }
  const nonce = Math.max(chainNonce, robNonceTracker.nextNonce);
  robNonceTracker.nextNonce = nonce + 1;
  return nonce;
}

// ── Rob 链广播函数 ──

/**
 * 广播 Rob 链交易（Flap.sh 内盘 + Uniswap V3 外盘）。
 * Rob 链是 Arbitrum L2，支持 EIP-1559，gas 以 ETH 计价。
 */
export async function broadcastRobSwap(
  result: RobSwapBuildResult,
): Promise<BroadcastResult> {
  if (!result.tx) {
    throw new Error("没有可广播的交易数据");
  }

  const prevLock = robBroadcastLock;
  let releaseLock!: () => void;
  robBroadcastLock = new Promise<void>((resolve) => { releaseLock = resolve; });
  await prevLock;

  try {
    return await doRobBroadcast(result);
  } finally {
    releaseLock();
  }
}

async function doRobBroadcast(
  result: RobSwapBuildResult,
): Promise<BroadcastResult> {
  if (!result.tx) throw new Error("没有可广播的交易数据");

  const { account, publicClient, walletClient } = getRobClients();
  const { to, data, value } = result.tx;

  const tb0 = Date.now();

  // estimateGas
  const estimated = await withRetry(
    () => publicClient.estimateGas({ account: account.address, to: to as Hex, data, value }),
    { label: "rob_estimateGas" },
  );
  const gasLimit = (estimated * 130n) / 100n; // Rob 链加 30% 余量
  console.log(JSON.stringify({ event: "TIMING", phase: "rob_estimate_gas", ms: Date.now() - tb0 }));

  // Rob 链是 Arbitrum L2，支持 EIP-1559
  // 使用 maxFeePerGas / maxPriorityFeePerGas
  const tGasPrice = Date.now();
  const feeData = await withRetry(
    () => publicClient.estimateFeesPerGas(),
    { label: "rob_estimateFeesPerGas" },
  );
  console.log(JSON.stringify({ event: "TIMING", phase: "rob_get_gas_fee", ms: Date.now() - tGasPrice }));

  // 使用网络建议费用，加小量 Tip 提速
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
    ? (feeData.maxPriorityFeePerGas * 120n) / 100n
    : 1000000n; // 0.001 Gwei
  const maxFeePerGas = feeData.maxFeePerGas
    ? (feeData.maxFeePerGas * 120n) / 100n
    : maxPriorityFeePerGas + 100000000n; // base fee + tip

  console.log(JSON.stringify({
    event: "ROB_GAS_INFO",
    gasLimit: gasLimit.toString(),
    maxFeePerGasGwei: (Number(maxFeePerGas) / 1e9).toFixed(6),
    maxPriorityFeePerGasGwei: (Number(maxPriorityFeePerGas) / 1e9).toFixed(6),
    estimatedCostEth: (Number(gasLimit * maxFeePerGas) / 1e18).toFixed(8),
  }));

  const nonce = await acquireRobNonce(publicClient, account.address);
  console.log(JSON.stringify({ event: "ROB_NONCE", nonce, address: account.address }));

  // 构建 EIP-1559 交易
  const request = await walletClient.prepareTransactionRequest({
    account,
    to: to as Hex,
    data,
    value,
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce,
    type: "eip1559",
  });

  const tSign = Date.now();
  const signed = await walletClient.signTransaction(request);
  console.log(JSON.stringify({ event: "TIMING", phase: "rob_sign_tx", ms: Date.now() - tSign }));

  // 广播：并行向所有 Rob RPC 节点发送
  const tSend = Date.now();
  const rpcUrls = parseRobRpcUrls();
  const broadcastPromises = rpcUrls.map((url) => {
    const chainWithRpc = { ...robinhoodChain, rpcUrls: { default: { http: [url] } } };
    const c = createPublicClient({
      chain: chainWithRpc,
      transport: http(url, { timeout: 15_000, retryCount: 0 }),
    });
    return withRetry(
      () => c.sendRawTransaction({ serializedTransaction: signed }),
      { attempts: 2, label: `rob_sendRaw-${url.slice(0, 30)}` },
    ).catch((err: unknown) => {
      const msg = String(err instanceof Error ? err.message : err).toLowerCase();
      if (msg.includes("already known") || msg.includes("nonce too low") || msg.includes("already exists")) {
        return undefined;
      }
      throw err;
    });
  });

  let txHash: string | undefined;
  const results = await Promise.allSettled(broadcastPromises);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      txHash = r.value;
      break;
    }
  }
  if (!txHash) {
    const firstErr = results.find(r => r.status === "rejected");
    throw (firstErr as PromiseRejectedResult)?.reason ?? new Error("Rob 链广播失败，所有 RPC 节点均无响应");
  }
  console.log(JSON.stringify({ event: "TIMING", phase: "rob_send_raw_tx", ms: Date.now() - tSend, rpcCount: rpcUrls.length }));

  return {
    txHash,
    route: result.route,
    fromAddress: account.address,
    toAddress: to,
    value: value.toString(),
  };
}

/**
 * 等待 Rob 链交易确认。
 */
export async function waitForRobTx(
  txHash: string,
  confirmations = 1,
  timeoutMs = 120_000,
): Promise<{ status: "success" | "reverted"; blockNumber: bigint }> {
  const { publicClient } = getRobClients();

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash as Hex,
    confirmations,
    timeout: timeoutMs,
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("timed out") || msg.toLowerCase().includes("timeout")) {
      throw new WaitForTxTimeoutError(txHash);
    }
    throw err;
  });

  return { status: receipt.status, blockNumber: receipt.blockNumber };
}

// ── 交易结果 ──

export interface BroadcastResult {
  txHash: string;
  route: string;
  fromAddress: string;
  toAddress: string;
  value: string;
}

// ── 广播函数 ──

/**
 * 签名并广播交易。
 * 根据 buildBscSwapUnified 返回的路由类型自动选择 gas 配置。
 */
export async function broadcastSwap(
  result: BscSwapBuildResult,
): Promise<BroadcastResult> {
  if (!result.tx) {
    throw new Error("没有可广播的交易数据");
  }

  // 串行化广播，防止 nonce 冲突
  const prevLock = broadcastLock;
  let releaseLock!: () => void;
  broadcastLock = new Promise<void>((resolve) => { releaseLock = resolve; });
  await prevLock;

  try {
    return await doBroadcast(result);
  } finally {
    releaseLock();
  }
}

async function doBroadcast(
  result: BscSwapBuildResult,
): Promise<BroadcastResult> {
  if (!result.tx) {
    throw new Error("没有可广播的交易数据");
  }

  const { account, publicClient, walletClient } = getBscClients();
  const { to, data, value } = result.tx;

  const tb0 = Date.now();

  // ── estimateGas：动态估算 gas limit，同时充当 preflight（revert 时提前抛错不花 gas）
  // 加 20% 余量，防止链上状态变动导致实际消耗略高于估算
  const estimated = await withRetry(
    () =>
      publicClient.estimateGas({
        account: account.address,
        to: to as Hex,
        data,
        value,
      }),
    { label: "estimateGas" },
  );
  const gasLimit = (estimated * 120n) / 100n;
  console.log(JSON.stringify({ event: "TIMING", phase: "estimate_gas", ms: Date.now() - tb0 }));

  // BSC 不支持 EIP-1559，必须用 legacy type:0 + gasPrice
  // 狙击模式用专用 gas price（通常更高），否则用普通配置
  const configGasGwei = result.isSniper
    ? runtimeConfig.getSniperGasPriceGwei(result.route)
    : runtimeConfig.getGasPriceGwei(result.route);
  const MIN_GAS_PRICE = parseGwei(configGasGwei);
  const tGasPrice = Date.now();
  const networkGasPrice = await withRetry(
    () => publicClient.getGasPrice(),
    { label: "getGasPrice" },
  );
  console.log(JSON.stringify({ event: "TIMING", phase: "get_gas_price", ms: Date.now() - tGasPrice }));

  // ── gas 费用上限：从运行时配置读取
  // 如果当前 gasPrice 导致费用超限，自动压低到上限内。注意：MAX_GAS_COST 优先于 MIN_GAS_PRICE
  const configMaxCost = runtimeConfig.getMaxGasCostBnb();
  const MAX_GAS_COST_BNB = parseEther(configMaxCost);
  let gasPrice = networkGasPrice > MIN_GAS_PRICE ? networkGasPrice : MIN_GAS_PRICE;
  // 加 10% 提速
  gasPrice = (gasPrice * 110n) / 100n;
  const estimatedGasCostBNB = gasLimit * gasPrice;
  if (estimatedGasCostBNB > MAX_GAS_COST_BNB) {
    // 压低到上限：maxGasPrice = MAX_GAS_COST_BNB / gasLimit
    // 注意：不再与 MIN_GAS_PRICE 对比， MAX_GAS_COST 是硬底线
    const cappedGasPrice = MAX_GAS_COST_BNB / gasLimit;
    if (cappedGasPrice === 0n) {
      throw new Error(`gas 费用超限且无法压低：gasLimit=${gasLimit}, maxCost=${configMaxCost} BNB`);
    }
    gasPrice = cappedGasPrice;
    console.log(JSON.stringify({ event: "GAS_CAPPED", originalGwei: (Number(networkGasPrice) / 1e9).toFixed(4), cappedGwei: (Number(gasPrice) / 1e9).toFixed(4), estimatedCostBnb: (Number(gasLimit * gasPrice) / 1e18).toFixed(6) }));
  }
  console.log(JSON.stringify({ event: "GAS_CHECK", gasLimit: gasLimit.toString(), gasPriceGwei: (Number(gasPrice) / 1e9).toFixed(4), estimatedCostBnb: (Number(gasLimit * gasPrice) / 1e18).toFixed(6) }));

  // 获取 nonce（并发安全）
  const nonce = await acquireNonce(publicClient, account.address);
  console.log(JSON.stringify({ event: "NONCE", nonce, address: account.address }));

  // 构建交易请求（legacy type:0）
  const request = await walletClient.prepareTransactionRequest({
    account,
    to: to as Hex,
    data,
    value,
    gas: gasLimit,
    gasPrice,
    nonce,
    type: "legacy",
  });

  // 签名
  const tSign = Date.now();
  const signed = await walletClient.signTransaction(request);
  console.log(JSON.stringify({ event: "TIMING", phase: "sign_tx", ms: Date.now() - tSign }));

  // 广播：向所有 RPC 节点并行发送，提高 tx 被网络接受的概率
  // 只要有一个节点返回 txHash 就算成功，其余节点的重复提交会被自动忽略
  const tSend = Date.now();
  const rpcUrls = parseBscRpcUrls();

  const broadcastPromises = rpcUrls.map((url) => {
    const c = createPublicClient({ chain: bsc, transport: http(url, { timeout: 15_000, retryCount: 0 }) });
    return withRetry(
      () => c.sendRawTransaction({ serializedTransaction: signed }),
      { attempts: 2, label: `sendRaw-${url.slice(0, 30)}` },
    ).catch((err: unknown) => {
      // 忽略「already known」/ 「nonce too low」等重复提交错误
      const msg = String(err instanceof Error ? err.message : err).toLowerCase();
      if (msg.includes("already known") || msg.includes("nonce too low") || msg.includes("already exists")) {
        return undefined;
      }
      throw err;
    });
  });

  // 取第一个成功的结果
  let txHash: string | undefined;
  const results = await Promise.allSettled(broadcastPromises);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      txHash = r.value;
      break;
    }
  }
  if (!txHash) {
    // 全部失败，抛出第一个有意义的错误
    const firstErr = results.find(r => r.status === "rejected");
    throw (firstErr as PromiseRejectedResult)?.reason ?? new Error("广播失败，所有 RPC 节点均无响应");
  }
  console.log(JSON.stringify({ event: "TIMING", phase: "send_raw_tx", ms: Date.now() - tSend, rpcCount: rpcUrls.length }));

  return {
    txHash,
    route: result.route,
    fromAddress: account.address,
    toAddress: to,
    value: value.toString(),
  };
}

// ── Pre-sign（预签名，保留向后兼容）──

export interface PreSignResult {
  signedTx: Hex;
  result: BscSwapBuildResult;
  gasLimit: bigint;
  gasPrice: bigint;
  nonce: number;
  createdAtMs: number;
}

// ── Prepared Transaction（预构建，不含 nonce 和签名）──

export interface PreparedTransaction {
  result: BscSwapBuildResult;
  gasLimit: bigint;
  gasPrice: bigint;
  preparedAtMs: number;
}

/**
 * 预签名买入交易：构建 + estimateGas + 签名（不广播）。
 * 当共振引擎收到第一个信号时调用，trigger 触发后直接用 broadcastPreSigned 发送。
 * gasPrice 使用 configGasPrice * gasMultiplier（默认 1.2）。
 */
export async function preSignBuyTx(
  tokenAddress: string,
  amount: string,
  slippagePercent: string,
  walletAddress: string,
  gasMultiplier = 1.2,
): Promise<PreSignResult> {
  const { buildBscSwapUnified } = await import("./bsc-swap-builder.js");

  const t0 = Date.now();
  const result = await buildBscSwapUnified({
    tokenAddress,
    amount,
    slippagePercent,
    walletAddress,
    options: { buildTx: true },
  });

  if (!result.tx) throw new Error("pre-sign: 没有交易数据");

  const { account, publicClient, walletClient } = getBscClients();
  const { to, data, value } = result.tx;

  // estimateGas（并行不了，是后续步骤的前置）
  const estimated = await withRetry(
    () =>
      publicClient.estimateGas({
        account: account.address,
        to: to as Hex,
        data,
        value,
      }),
    { label: "preSign_estimateGas" },
  );
  const gasLimit = (estimated * 120n) / 100n;

  // gasPrice = configGasPrice * gasMultiplier
  const configGasGwei = runtimeConfig.getGasPriceGwei(result.route);
  const configGasPrice = parseGwei(configGasGwei);
  // 用整数运算避免浮点精度问题：1.2 = 120/100
  const multiplierBps = BigInt(Math.round(gasMultiplier * 100));
  let gasPrice = (configGasPrice * multiplierBps) / 100n;

  // gas cost 上限
  const configMaxCost = runtimeConfig.getMaxGasCostBnb();
  const MAX_GAS_COST_BNB = parseEther(configMaxCost);
  const estimatedGasCostBNB = gasLimit * gasPrice;
  if (estimatedGasCostBNB > MAX_GAS_COST_BNB) {
    const cappedGasPrice = MAX_GAS_COST_BNB / gasLimit;
    if (cappedGasPrice === 0n) {
      throw new Error(`pre-sign: gas 费用超限且无法压低`);
    }
    gasPrice = cappedGasPrice;
  }

  // 获取 nonce
  const nonce = await acquireNonce(publicClient, account.address);

  // 签名
  const request = await walletClient.prepareTransactionRequest({
    account,
    to: to as Hex,
    data,
    value,
    gas: gasLimit,
    gasPrice,
    nonce,
    type: "legacy",
  });
  const signedTx = await walletClient.signTransaction(request);

  console.log(
    JSON.stringify({
      event: "PRE_SIGN",
      tokenAddress: tokenAddress.slice(0, 10),
      route: result.route,
      gasLimit: gasLimit.toString(),
      gasPriceGwei: (Number(gasPrice) / 1e9).toFixed(4),
      nonce,
      ms: Date.now() - t0,
    }),
  );

  return {
    signedTx,
    result,
    gasLimit,
    gasPrice,
    nonce,
    createdAtMs: Date.now(),
  };
}

/**
 * 广播预签名交易（跳过 build + estimateGas + sign，直接发送）。
 */
export async function broadcastPreSigned(
  preSign: PreSignResult,
): Promise<BroadcastResult> {
  const { account } = getBscClients();
  const tSend = Date.now();
  const rpcUrls = parseBscRpcUrls();

  const broadcastPromises = rpcUrls.map((url) => {
    const c = createPublicClient({
      chain: bsc,
      transport: http(url, { timeout: 15_000, retryCount: 0 }),
    });
    return withRetry(
      () => c.sendRawTransaction({ serializedTransaction: preSign.signedTx }),
      { attempts: 2, label: `preSign_sendRaw-${url.slice(0, 30)}` },
    ).catch((err: unknown) => {
      const msg = String(err instanceof Error ? err.message : err).toLowerCase();
      if (
        msg.includes("already known") ||
        msg.includes("nonce too low") ||
        msg.includes("already exists")
      ) {
        return undefined;
      }
      throw err;
    });
  });

  let txHash: string | undefined;
  const results = await Promise.allSettled(broadcastPromises);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      txHash = r.value;
      break;
    }
  }
  if (!txHash) {
    const firstErr = results.find((r) => r.status === "rejected");
    throw (
      (firstErr as PromiseRejectedResult)?.reason ??
      new Error("预签名广播失败，所有 RPC 节点均无响应")
    );
  }

  console.log(
    JSON.stringify({
      event: "TIMING",
      phase: "preSign_broadcast",
      ms: Date.now() - tSend,
      rpcCount: rpcUrls.length,
    }),
  );

  return {
    txHash,
    route: preSign.result.route,
    fromAddress: account.address,
    toAddress: preSign.result.tx!.to,
    value: preSign.result.tx!.value.toString(),
  };
}

// ── 预构建 + 触发时签名广播（不提前占用 nonce）──

/**
 * 预构建买入交易：detect + build + estimateGas + gasPrice。
 * 不获取 nonce，不签名，不推进 nonceTracker。
 * 第一个钱包信号到达时调用，共振触发后用 executePreparedTx 签名广播。
 */
export async function prepareBuyTx(
  tokenAddress: string,
  amount: string,
  slippagePercent: string,
  walletAddress: string,
  gasMultiplier = 1.2,
): Promise<PreparedTransaction> {
  const { buildBscSwapUnified } = await import("./bsc-swap-builder.js");

  const t0 = Date.now();
  const result = await buildBscSwapUnified({
    tokenAddress,
    amount,
    slippagePercent,
    walletAddress,
    options: { buildTx: true },
  });

  if (!result.tx) throw new Error("prepare: 没有交易数据");

  const { account, publicClient } = getBscClients();
  const { to, data, value } = result.tx;

  // estimateGas
  const estimated = await withRetry(
    () =>
      publicClient.estimateGas({
        account: account.address,
        to: to as Hex,
        data,
        value,
      }),
    { label: "prepare_estimateGas" },
  );
  const gasLimit = (estimated * 120n) / 100n;

  // gasPrice = configGasPrice * gasMultiplier
  const configGasGwei = runtimeConfig.getGasPriceGwei(result.route);
  const configGasPrice = parseGwei(configGasGwei);
  const multiplierBps = BigInt(Math.round(gasMultiplier * 100));
  let gasPrice = (configGasPrice * multiplierBps) / 100n;

  // gas cost 上限
  const configMaxCost = runtimeConfig.getMaxGasCostBnb();
  const MAX_GAS_COST_BNB = parseEther(configMaxCost);
  const estimatedGasCostBNB = gasLimit * gasPrice;
  if (estimatedGasCostBNB > MAX_GAS_COST_BNB) {
    const cappedGasPrice = MAX_GAS_COST_BNB / gasLimit;
    if (cappedGasPrice === 0n) {
      throw new Error(`prepare: gas 费用超限且无法压低`);
    }
    gasPrice = cappedGasPrice;
  }

  // 不获取 nonce，不签名
  console.log(
    JSON.stringify({
      event: "PREPARE",
      tokenAddress: tokenAddress.slice(0, 10),
      route: result.route,
      gasLimit: gasLimit.toString(),
      gasPriceGwei: (Number(gasPrice) / 1e9).toFixed(4),
      ms: Date.now() - t0,
    }),
  );

  return {
    result,
    gasLimit,
    gasPrice,
    preparedAtMs: Date.now(),
  };
}

/**
 * 执行预构建交易：获取 nonce → 签名 → 多 RPC 并行广播。
 * 使用 broadcastLock 串行化，确保 nonce 安全。
 * 共振触发时调用，也可用于普通路径统一 nonce 管理。
 */
export async function executePreparedTx(
  prepared: PreparedTransaction,
): Promise<BroadcastResult> {
  if (!prepared.result.tx) throw new Error("execute: 没有交易数据");

  // 串行化广播，防止 nonce 冲突
  const prevLock = broadcastLock;
  let releaseLock!: () => void;
  broadcastLock = new Promise<void>((resolve) => { releaseLock = resolve; });
  await prevLock;

  try {
    const { account, publicClient, walletClient } = getBscClients();
    const { to, data, value } = prepared.result.tx;

    // 获取 nonce（在 broadcastLock 内，安全）
    const nonce = await acquireNonce(publicClient, account.address);
    console.log(JSON.stringify({ event: "NONCE", nonce, address: account.address, source: "executePrepared" }));

    // 签名
    const request = await walletClient.prepareTransactionRequest({
      account,
      to: to as Hex,
      data,
      value,
      gas: prepared.gasLimit,
      gasPrice: prepared.gasPrice,
      nonce,
      type: "legacy",
    });
    const signedTx = await walletClient.signTransaction(request);

    // 多 RPC 并行广播
    const tSend = Date.now();
    const rpcUrls = parseBscRpcUrls();

    const broadcastPromises = rpcUrls.map((url) => {
      const c = createPublicClient({
        chain: bsc,
        transport: http(url, { timeout: 15_000, retryCount: 0 }),
      });
      return withRetry(
        () => c.sendRawTransaction({ serializedTransaction: signedTx }),
        { attempts: 2, label: `execute_sendRaw-${url.slice(0, 30)}` },
      ).catch((err: unknown) => {
        const msg = String(err instanceof Error ? err.message : err).toLowerCase();
        if (
          msg.includes("already known") ||
          msg.includes("nonce too low") ||
          msg.includes("already exists")
        ) {
          return undefined;
        }
        throw err;
      });
    });

    let txHash: string | undefined;
    const results = await Promise.allSettled(broadcastPromises);
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        txHash = r.value;
        break;
      }
    }
    if (!txHash) {
      const firstErr = results.find((r) => r.status === "rejected");
      throw (
        (firstErr as PromiseRejectedResult)?.reason ??
        new Error("广播失败，所有 RPC 节点均无响应")
      );
    }

    console.log(
      JSON.stringify({
        event: "TIMING",
        phase: "execute_broadcast",
        ms: Date.now() - tSend,
        rpcCount: rpcUrls.length,
        nonce,
      }),
    );

    return {
      txHash,
      route: prepared.result.route,
      fromAddress: account.address,
      toAddress: to,
      value: value.toString(),
    };
  } finally {
    releaseLock();
  }
}

/**
 * 等待交易确认。
 * @param timeoutMs 超时毫秒数，默认 120s。超时抛 WaitForTxTimeoutError，不代表失败
 */
export class WaitForTxTimeoutError extends Error {
  constructor(public readonly txHash: string) {
    super(`等待交易确认超时: ${txHash}`);
    this.name = "WaitForTxTimeoutError";
  }
}

export async function waitForTx(
  txHash: string,
  confirmations = 1,
  timeoutMs = 120_000,
): Promise<{ status: "success" | "reverted"; blockNumber: bigint }> {
  const { publicClient } = getBscClients();

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash as Hex,
    confirmations,
    timeout: timeoutMs,
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("timed out") || msg.toLowerCase().includes("timeout")) {
      throw new WaitForTxTimeoutError(txHash);
    }
    throw err;
  });

  return {
    status: receipt.status,
    blockNumber: receipt.blockNumber,
  };
}

/**
 * 获取钱包地址（从私钥派生）。
 */
export function getWalletAddress(): string {
  const { account } = getBscClients();
  return account.address;
}

/**
 * 获取钱包 BNB 余额。
 */
export async function getWalletBalance(): Promise<bigint> {
  const { publicClient, account } = getBscClients();
  return publicClient.getBalance({ address: account.address });
}
