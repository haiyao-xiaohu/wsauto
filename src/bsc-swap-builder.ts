/**
 * BSC swap builder — 统一路由器
 *
 * 自动检测代币所在平台和状态，选择最佳路由：
 *   - Four.meme 内盘 → Four.meme TokenManager 直接买入
 *   - Flap.sh 内盘   → Flap.sh Portal 直接买入
 *   - 已毕业/DEX    → OKX DEX Aggregator 路由
 */

import {
  createPublicClient,
  http,
  parseEther,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";

import { OkxClient } from "./okx/client.js";
import { CHAINS } from "./chains.js";
import { getOkxCredentials } from "./config.js";
import {
  detectTokenMarket,
  type TokenMarketInfo,
} from "./inner-market-detector.js";
import { buildFourMemeBuyTx } from "./fourmeme-swap.js";
import { buildFlapBuyTx } from "./flap-swap.js";
import { getBscRpcUrl } from "./rpc.js";

// ── BSC 配置 ──

const BSC_CHAIN = CHAINS.bsc;
const BSC_NATIVE_TOKEN = BSC_CHAIN.nativeTokenAddress;

// ── 路由类型 ──

export type SwapRoute =
  | "fourmeme_inner" // Four.meme 内盘 bonding curve
  | "flap_inner" // Flap.sh 蝴蝶内盘
  | "okx_dex" // OKX DEX 聚合器（已毕业代币）
  | "dry_run"; // dry-run 模式

export interface BscSwapBuildResult {
  /** 路由类型 */
  route: SwapRoute;
  /** 代币信息 */
  tokenMarket: TokenMarketInfo;
  /** 交易数据（如果可用） */
  tx?: {
    to: string;
    data: Hex;
    value: bigint;
    /** OKX 建议的 gas limit，优先使用 */
    gas?: bigint;
  };
  /** OKX 路由结果（仅 okx_dex 路由） */
  okxResult?: {
    fromTokenSymbol: string;
    toTokenSymbol: string;
    toTokenAmount: string;
    priceImpact: string;
    router: string;
    latencyMs: number;
  };
  /** Four.meme 报价（仅 fourmeme_inner 路由） */
  fourmemeQuote?: {
    estimatedAmount: string;
    estimatedCost: string;
    amountMsgValue: string;
    minAmount: string;
  };
  /** Flap.sh 报价（仅 flap_inner 路由） */
  flapQuote?: {
    estimatedOutput: string;
    inputAmount: string;
    minOutputAmount: string;
  };
  /** 路由选择原因 */
  reason: string;
  /** 狙击模式标志 */
  isSniper?: boolean;
}

// ── 统一构建函数 ──

/**
 * 构建 BSC swap 交易，自动选择路由。
 */
export async function buildBscSwapUnified(params: {
  tokenAddress: string;
  amount: string;
  slippagePercent: string;
  walletAddress: string;
  options?: { buildTx?: boolean };
}): Promise<BscSwapBuildResult> {
  const { tokenAddress, amount, slippagePercent, walletAddress } = params;

  // 获取 BSC RPC 并创建 publicClient
  const rpcUrl = getBscRpcUrl();
  console.log("[RPC] detectTokenMarket: endpoint configured");
  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }) });

  // 1. 检测代币所在平台和状态
  const tokenMarket = await detectTokenMarket(publicClient, tokenAddress);

  // 2. 根据平台和状态选择路由
  if (tokenMarket.platform === "fourmeme" && tokenMarket.status === "inner_market") {
    return buildFourMemeRoute(tokenAddress, amount, slippagePercent, walletAddress, tokenMarket);
  }

  if (tokenMarket.platform === "flap" && tokenMarket.status === "inner_market") {
    return buildFlapRoute(tokenAddress, amount, slippagePercent, tokenMarket);
  }

  // 3. 未知平台 → 拒绝交易（不认识的平台不走 OKX DEX，避免浪费）
  if (tokenMarket.platform === null) {
    throw new Error(
      `代币 ${tokenAddress.slice(0, 10)}... 未匹配任何已知平台（Four.meme/Flap.sh），拒绝交易`,
    );
  }

  // 4. 已知平台的已毕业代币 → 走 OKX DEX
  return buildOkxDexRoute(tokenAddress, amount, slippagePercent, walletAddress, tokenMarket);
}

// ── Four.meme 内盘路由 ──

async function buildFourMemeRoute(
  tokenAddress: string,
  amount: string,
  slippagePercent: string,
  walletAddress: string,
  tokenMarket: TokenMarketInfo,
): Promise<BscSwapBuildResult> {
  try {
    const tx = await buildFourMemeBuyTx(
      tokenAddress,
      amount,
      slippagePercent,
      tokenMarket.managerAddress,
    );

    return {
      route: "fourmeme_inner",
      tokenMarket,
      tx: {
        to: tx.to,
        data: tx.data,
        value: tx.value,
      },
      fourmemeQuote: {
        estimatedAmount: tx.estimatedAmount.toString(),
        estimatedCost: tx.estimatedCost.toString(),
        amountMsgValue: tx.amountMsgValue.toString(),
        minAmount: tx.minAmount.toString(),
      },
      reason: `Four.meme 内盘，进度 ${tokenMarket.progress.toFixed(1)}%`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // amountMsgValue=0 说明旧版 Helper 无法处理此代币（Token8/特殊架构），
    // 降级尝试 OKX DEX 路由
    if (msg.includes("amountMsgValue=0")) {
      console.warn(`[bsc-swap] Four.meme tryBuy 返回0，降级到 OKX DEX: ${tokenAddress.slice(0, 10)}...`);
      return buildOkxDexRoute(tokenAddress, amount, slippagePercent, walletAddress, tokenMarket);
    }

    return {
      route: "dry_run",
      tokenMarket,
      reason: `Four.meme 报价失败: ${msg}`,
    };
  }
}

// ── Flap.sh 内盘路由 ──

async function buildFlapRoute(
  tokenAddress: string,
  amount: string,
  slippagePercent: string,
  tokenMarket: TokenMarketInfo,
): Promise<BscSwapBuildResult> {
  try {
    const tx = await buildFlapBuyTx(tokenAddress, amount, slippagePercent);

    return {
      route: "flap_inner",
      tokenMarket,
      tx: {
        to: tx.to,
        data: tx.data,
        value: tx.value,
      },
      flapQuote: {
        estimatedOutput: tx.estimatedOutput.toString(),
        inputAmount: tx.inputAmount.toString(),
        minOutputAmount: tx.minOutputAmount.toString(),
      },
      reason: `Flap.sh 内盘，进度 ${tokenMarket.progress.toFixed(1)}%`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      route: "dry_run",
      tokenMarket,
      reason: `Flap.sh 报价失败: ${msg}`,
    };
  }
}

// ── OKX DEX 路由（已毕业代币） ──

async function buildOkxDexRoute(
  tokenAddress: string,
  amount: string,
  slippagePercent: string,
  walletAddress: string,
  tokenMarket: TokenMarketInfo,
): Promise<BscSwapBuildResult> {
  try {
    const credentials = getOkxCredentials();
    const okxClient = new OkxClient(credentials);

    const result = await okxClient.getSwap({
      chainIndex: BSC_CHAIN.chainIndex,
      fromTokenAddress: BSC_NATIVE_TOKEN,
      toTokenAddress: tokenAddress,
      // OKX 要求 amount 是 wei 整数字符串，不能传 BNB 小数
      amount: parseEther(amount).toString(),
      userWalletAddress: walletAddress,
      slippagePercent,
    });

    const swapData = result.swap;
    const routerAddress = swapData.tx.to;

    return {
      route: "okx_dex",
      tokenMarket,
      tx: {
        to: routerAddress,
        data: swapData.tx.data as Hex,
        value: BigInt(swapData.tx.value || "0"),
        // 优先用 OKX 返回的 gas，加 20% 余量，最低 800000
        gas: swapData.tx.gas
          ? (BigInt(swapData.tx.gas) * 120n) / 100n
          : 1500000n,
      },
      okxResult: {
        fromTokenSymbol: swapData.routerResult.fromToken.tokenSymbol,
        toTokenSymbol: swapData.routerResult.toToken.tokenSymbol,
        toTokenAmount: swapData.routerResult.toTokenAmount,
        priceImpact: swapData.routerResult.priceImpactPercent,
        router: routerAddress,
        latencyMs: result.elapsedMs,
      },
      reason:
        tokenMarket.status === "graduated"
          ? `${tokenMarket.platform} 已毕业，走 OKX DEX`
          : tokenMarket.platform
            ? `${tokenMarket.platform} 内盘降级 OKX DEX（Token8架构）`
            : "未知平台，尝试 OKX DEX",
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      route: "dry_run",
      tokenMarket,
      reason: `OKX 路由失败: ${msg}`,
    };
  }
}
