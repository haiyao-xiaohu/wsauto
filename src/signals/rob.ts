/**
 * Robinhood Chain 信号提取模块
 *
 * 从 QuickNode block_with_receipts Webhook 中提取 Rob 链上的买入信号。
 * 逻辑与 BSC 版本相同，区别：chainId=4663，计价资产为 Rob 链的 WETH/USDC 等。
 */

export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Rob 链上常见的计价资产（不作为目标 meme 币）
// WETH: Arbitrum 标准 WETH 地址（与 Base/Arbitrum 一致）
export const ROB_QUOTE_TOKENS = new Set([
  "0x4200000000000000000000000000000000000006", // WETH（Arbitrum WETH 标准地址）
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC（Base 标准，Rob 链如有同地址）
  "0x0000000000000000000000000000000000000000", // 零地址占位
]);

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const HEX_PATTERN = /^0x[0-9a-f]+$/;

export interface RobBuySignal {
  chainId: 4663;
  tokenAddress: string;
  walletAddress: string;
  txHash: string;
  blockTimestampMs: number;
  blockNumber?: number;
}

interface QuickNodeLog {
  address?: unknown;
  blockTimestamp?: unknown;
  data?: unknown;
  topics?: unknown;
}

interface QuickNodeReceipt {
  blockNumber?: unknown;
  from?: unknown;
  logs?: unknown;
  status?: unknown;
  transactionHash?: unknown;
}

function asLowerAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return ADDRESS_PATTERN.test(normalized) ? normalized : null;
}

function asLowerHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return HASH_PATTERN.test(normalized) ? normalized : null;
}

function hexToSafeNumber(value: unknown): number | null {
  if (typeof value !== "string" || !HEX_PATTERN.test(value.toLowerCase())) {
    return null;
  }
  const parsed = Number(BigInt(value));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function topicAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) return null;
  return `0x${normalized.slice(-40)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receiptSignals(receipt: QuickNodeReceipt): RobBuySignal[] {
  if (receipt.status !== "0x1") return [];

  const walletAddress = asLowerAddress(receipt.from);
  const txHash = asLowerHash(receipt.transactionHash);
  const logs = Array.isArray(receipt.logs)
    ? (receipt.logs.filter(isObject) as QuickNodeLog[])
    : [];
  if (!walletAddress || !txHash || logs.length === 0) return [];

  const timestampSeconds = logs
    .map((log) => hexToSafeNumber(log.blockTimestamp))
    .find((value): value is number => value !== null);
  if (timestampSeconds === undefined) return [];

  const tokenNet = new Map<string, bigint>();

  for (const log of logs) {
    const tokenAddress = asLowerAddress(log.address);
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (
      !tokenAddress ||
      topics[0] !== ERC20_TRANSFER_TOPIC ||
      topics.length < 3 ||
      typeof log.data !== "string" ||
      !HEX_PATTERN.test(log.data.toLowerCase())
    ) {
      continue;
    }

    const from = topicAddress(topics[1]);
    const to = topicAddress(topics[2]);
    if (!from || !to) continue;

    const amount = BigInt(log.data);
    if (from === walletAddress) {
      tokenNet.set(tokenAddress, (tokenNet.get(tokenAddress) ?? 0n) - amount);
    }
    if (to === walletAddress) {
      tokenNet.set(tokenAddress, (tokenNet.get(tokenAddress) ?? 0n) + amount);
    }
  }

  const blockNumber = hexToSafeNumber(receipt.blockNumber);
  const signals: RobBuySignal[] = [];

  for (const [tokenAddress, netAmount] of tokenNet) {
    if (netAmount <= 0n || ROB_QUOTE_TOKENS.has(tokenAddress)) continue;
    signals.push({
      chainId: 4663,
      tokenAddress,
      walletAddress,
      txHash,
      blockTimestampMs: timestampSeconds * 1_000,
      ...(blockNumber === null ? {} : { blockNumber }),
    });
  }

  return signals;
}

/**
 * 从 QuickNode block_with_receipts Webhook 中提取 Rob 链买入信号。
 */
export function extractRobBuySignals(payload: unknown): RobBuySignal[] {
  if (!isObject(payload)) return [];

  // 兼容新版 Streams 可能使用的 { data: [...] } 包装
  if (Array.isArray(payload.data)) {
    return payload.data.flatMap((item) => extractRobBuySignals(item));
  }

  const receipts = Array.isArray(payload.matchingReceipts)
    ? payload.matchingReceipts.filter(isObject)
    : [];
  return receipts.flatMap((receipt) =>
    receiptSignals(receipt as QuickNodeReceipt),
  );
}
