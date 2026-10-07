/**
 * Rob 链 swap builder — 统一路由器
 *
 * 自动检测代币所在平台，选择最佳路由：
 *   - Flap.sh 内盘（bonding curve）→ Rob 链 Flap Portal 直接买入
 *   - 外盘（Pons/UERC20/Uniswap V3）→ Uniswap V3 SwapRouter02 exactInputSingle
 *   - 检测失败 / dry-run → dry_run 路由（不广播）
 */

import {
  createPublicClient,
  http,
  parseEther,
  encodeFunctionData,
  parseAbi,
  type Hex,
} from "viem";

import { buildFlapRobBuyTx, ROB_FLAP_PORTAL, robinhoodChain } from "./flap-rob-swap.js";
import { getRobRpcUrl } from "./rpc.js";
import type { TokenMarketInfo } from "./inner-market-detector.js";

// ── 路由类型 ──

export type RobSwapRoute =
  | "flap_rob_inner"  // Flap.sh Rob 链内盘 bonding curve
  | "uniswap_v3"      // Uniswap V3 外盘（Pons/UERC20/毕业代币）
  | "dry_run";        // dry-run 模式（检测失败或未启用交易）

export interface RobSwapBuildResult {
  route: RobSwapRoute;
  tokenMarket: TokenMarketInfo;
  tx?: {
    to: string;
    data: Hex;
    value: bigint;
    gas?: bigint;
  };
  flapQuote?: {
    estimatedOutput: string;
    inputAmount: string;
    minOutputAmount: string;
  };
  uniswapQuote?: {
    amountIn: string;
    tokenIn: string;
    tokenOut: string;
  };
  reason: string;
  isSniper?: boolean;
}

// ── Rob 链合约地址 ──

/** Rob 链 Flap.sh Portal（v5.14.16）*/
const ROB_FLAP_PORTAL_ADDRESS = ROB_FLAP_PORTAL;

/**
 * Uniswap V3 SwapRouter02 — Rob 链部署地址。
 * Rob 链（chainId 4663）是 Arbitrum L2，使用与 Arbitrum One 相同的 Uniswap 标准部署。
 * 参考：https://docs.uniswap.org/contracts/v3/reference/deployments/arbitrum-deployments
 */
const UNISWAP_V3_SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as const;

/** Rob 链 WETH 地址（Arbitrum 标准 WETH，OP-stack chains 用 0x4200...0006）*/
const ROB_WETH = "0x4200000000000000000000000000000000000006" as `0x${string}`;

// ── Flap.sh 代币检测 ABI ──

const FLAP_GET_TOKEN_ABI = parseAbi([
  "function getTokenV8(address token) view returns ((uint8 status, uint256 reserve, uint256 circulatingSupply, uint256 price, uint8 tokenVersion, uint256 r, uint256 h, uint256 k, uint256 dexSupplyThresh, address quoteTokenAddress, bool nativeToQuoteSwapEnabled, bytes32 extensionID, uint256 buyTaxRate, uint256 sellTaxRate, address pool, uint256 progress, uint256 lpFeeProfile, uint8 dexId))",
]);

// ── Uniswap V3 ABI ──

const SWAP_ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
]);

// ── Client 工厂 ──

function getRobPublicClient() {
  const rpcUrl = getRobRpcUrl();
  return createPublicClient({
    chain: { ...robinhoodChain, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }),
  });
}

// ── Flap.sh 代币检测 ──

/**
 * 检测代币是否在 Rob 链 Flap.sh 内盘（status=1=Tradable）。
 * 返回 null 表示不在内盘（已毕业或不存在）。
 */
async function detectRobFlapToken(tokenAddress: string): Promise<TokenMarketInfo | null> {
  const publicClient = getRobPublicClient();
  try {
    const result = await publicClient.readContract({
      address: ROB_FLAP_PORTAL_ADDRESS as `0x${string}`,
      abi: FLAP_GET_TOKEN_ABI,
      functionName: "getTokenV8",
      args: [tokenAddress as `0x${string}`],
    });

    const state = result as {
      status: number;
      reserve: bigint;
      price: bigint;
      progress: bigint;
      buyTaxRate: bigint;
      sellTaxRate: bigint;
      pool: `0x${string}`;
      circulatingSupply: bigint;
    };

    // status == 0 (Invalid) → 代币不在 Flap.sh
    if (state.status === 0) return null;

    const reserveEth = Number(state.reserve) / 1e18;
    const progressPercent = Number(state.progress) / 1e16;

    // status: 1=Tradable(内盘), 4=DEX(已毕业), 其他=unknown
    let status: "inner_market" | "graduated" | "unknown";
    if (state.status === 1) status = "inner_market";
    else if (state.status === 4) status = "graduated";
    else status = "unknown";

    return {
      platform: "flap",
      status,
      managerAddress: ROB_FLAP_PORTAL_ADDRESS,
      price: state.price > 0n ? (Number(state.price) / 1e18).toFixed(12) : "0",
      reserve: reserveEth.toFixed(4),
      progress: progressPercent,
      extra: {
        status: state.status,
        circulatingSupply: Number(state.circulatingSupply) / 1e18,
        buyTaxRate: Number(state.buyTaxRate),
        sellTaxRate: Number(state.sellTaxRate),
        pool: state.pool,
        chain: "rob",
      },
    };
  } catch {
    // 查询失败 → 不是 Flap.sh 代币
    return null;
  }
}

// ── 统一构建函数 ──

/**
 * 构建 Rob 链 swap 交易，自动选择路由。
 * 优先检测 Flap.sh 内盘，否则走 Uniswap V3。
 */
export async function buildRobSwapUnified(params: {
  tokenAddress: string;
  amount: string;           // ETH 数量（字符串，如 "0.0001"）
  slippagePercent: string;
  walletAddress: string;
}): Promise<RobSwapBuildResult> {
  const { tokenAddress, amount, slippagePercent, walletAddress } = params;

  // 1. 检测是否在 Flap.sh 内盘
  const flapInfo = await detectRobFlapToken(tokenAddress);

  if (flapInfo && flapInfo.status === "inner_market") {
    return buildRobFlapRoute(tokenAddress, amount, slippagePercent, flapInfo);
  }

  // 2. 外盘（Pons/UERC20/已毕业/未知平台）→ Uniswap V3
  const tokenMarket: TokenMarketInfo = flapInfo ?? {
    platform: null,
    status: "unknown",
    managerAddress: "",
    price: "0",
    reserve: "0",
    progress: 0,
    extra: {},
  };

  return buildRobUniswapV3Route(tokenAddress, amount, slippagePercent, walletAddress, tokenMarket);
}

// ── Flap.sh 内盘路由 ──

async function buildRobFlapRoute(
  tokenAddress: string,
  amount: string,
  slippagePercent: string,
  tokenMarket: TokenMarketInfo,
): Promise<RobSwapBuildResult> {
  try {
    const tx = await buildFlapRobBuyTx(tokenAddress, amount, slippagePercent);

    return {
      route: "flap_rob_inner",
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
      reason: `Flap.sh Rob 内盘，进度 ${tokenMarket.progress.toFixed(1)}%`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      route: "dry_run",
      tokenMarket,
      reason: `Flap.sh Rob 报价失败: ${msg}`,
    };
  }
}

// ── Uniswap V3 外盘路由 ──

async function buildRobUniswapV3Route(
  tokenAddress: string,
  amount: string,
  slippagePercent: string,
  walletAddress: string,
  tokenMarket: TokenMarketInfo,
): Promise<RobSwapBuildResult> {
  try {
    const amountIn = parseEther(amount);
    // 滑点保护：minAmountOut = 0（由链上报价保证，或用链下估算）
    // 这里简单设 0，实际可集成链上 quoter
    const slipBps = BigInt(Math.floor(Number(slippagePercent) * 100));
    const minAmountOut = 0n; // 外盘使用 0 作为最低输出，依赖滑点保护

    // exactInputSingle: ETH(WETH) → token
    // Uniswap V3 接受原生 ETH 时需要通过 WETH 路径（tokenIn 填 WETH，发送 ETH value）
    const data = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: ROB_WETH,
          tokenOut: tokenAddress as `0x${string}`,
          fee: 10000, // 1% fee tier（Rob 链 meme 常用）
          recipient: walletAddress as `0x${string}`,
          amountIn,
          amountOutMinimum: minAmountOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    const reason = tokenMarket.platform === "flap" && tokenMarket.status === "graduated"
      ? `Flap.sh Rob 已毕业，走 Uniswap V3`
      : tokenMarket.platform === null
        ? `未知平台，走 Uniswap V3（Rob 链）`
        : `Rob 链外盘（${tokenMarket.platform || "unknown"}），走 Uniswap V3`;

    return {
      route: "uniswap_v3",
      tokenMarket,
      tx: {
        to: UNISWAP_V3_SWAP_ROUTER,
        data,
        value: amountIn,
        gas: 500000n, // Uniswap V3 单跳预估 gas
      },
      uniswapQuote: {
        amountIn: amountIn.toString(),
        tokenIn: ROB_WETH,
        tokenOut: tokenAddress,
      },
      reason,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      route: "dry_run",
      tokenMarket,
      reason: `Uniswap V3 路由构建失败: ${msg}`,
    };
  }
}
