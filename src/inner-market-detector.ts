/**
 * BSC 内盘代币平台检测器
 *
 * 检测一个代币是否还在内盘（bonding curve），以及属于哪个平台。
 * 支持 Four.meme 和 Flap.sh（蝴蝶）两个平台。
 */

import type { PublicClient } from "viem";

// ── 平台合约地址 ──

export const INNER_MARKET_CONTRACTS = {
  /** Four.meme Helper V3 — 只读查询（旧版 V1/V2 代币） */
  FOURMEME_HELPER: "0xF251F83e40a78868FcfA3FA4599Dad6494E46034" as const,
  /** Four.meme TokenManager V2 — 2024.9.5 之后的旧版代币 */
  FOURMEME_MANAGER_V2: "0x5c952063c7fc8610FFDB798152D69F0B9550762b" as const,
  /** Four.meme TokenManager V1 — 2024.9.5 之前的旧代币 */
  FOURMEME_MANAGER_V1: "0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC" as const,
  /** Four.meme OpenFour Core — V12+ 新版代币 */
  FOURMEME_OPENFOUR_CORE: "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3" as const,
  /** Flap.sh Portal V5 — 主合约（蝴蝶平台） */
  FLAP_PORTAL: "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0" as const,
} as const;

// ── 检测结果类型 ──

export type InnerMarketPlatform = "fourmeme" | "flap" | null;

export type TokenMarketStatus =
  | "inner_market" // 内盘 bonding curve
  | "graduated" // 已毕业，在 DEX 上交易
  | "unknown"; // 无法判断（可能代币不存在或合约异常）

export interface TokenMarketInfo {
  platform: InnerMarketPlatform;
  status: TokenMarketStatus;
  /** 实际执行买入的合约地址 */
  managerAddress: string;
  /** 当前价格（原生代币计价） */
  price: string;
  /** 已筹集资金（原生代币） */
  reserve: string;
  /** 毕业进度 (0~100) */
  progress: number;
  /** 额外信息 */
  extra: Record<string, string | number | boolean>;
}

// ── Contract ABIs (minimal) ──

const FOURMEME_HELPER_ABI = [
  {
    name: "getTokenInfo",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "version", type: "uint256" },
      { name: "tokenManager", type: "address" },
      { name: "quote", type: "address" },
      { name: "lastPrice", type: "uint256" },
      { name: "tradingFeeRate", type: "uint256" },
      { name: "minTradingFee", type: "uint256" },
      { name: "launchTime", type: "uint256" },
      { name: "offers", type: "uint256" },
      { name: "maxOffers", type: "uint256" },
      { name: "funds", type: "uint256" },
      { name: "maxFunds", type: "uint256" },
      { name: "liquidityAdded", type: "bool" },
    ],
  },
] as const;

/** OpenFour Core ABI（仅检测需要的最小接口） */
const OPENFOUR_CORE_ABI = [
  {
    name: "tokens",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "version", type: "uint32" },
      { name: "creator", type: "address" },
      { name: "presetId", type: "uint256" },
      { name: "token_", type: "address" },
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "maxSupply", type: "uint256" },
      { name: "saleAmount", type: "uint256" },
      { name: "raiseAmount", type: "uint256" },
      { name: "quoteAsset", type: "address" },
      { name: "vault", type: "address" },
      { name: "curveModule", type: "address" },
      { name: "tradeModule", type: "address" },
      { name: "migrateModule", type: "address" },
      { name: "tokenModule", type: "address" },
      { name: "customData", type: "address" },
      { name: "createBlock", type: "uint256" },
      { name: "exists", type: "bool" },
      { name: "paused", type: "bool" },
      { name: "antiSniperEnabled", type: "bool" },
    ],
  },
] as const;

/** OpenFour Vault ABI（检测毕业状态） */
const OPENFOUR_VAULT_ABI = [
  {
    name: "phase",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "totalRaised",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "remainingForSale",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const FLAP_PORTAL_ABI = [
  {
    name: "getTokenV8",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "state",
        type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "reserve", type: "uint256" },
          { name: "circulatingSupply", type: "uint256" },
          { name: "price", type: "uint256" },
          { name: "tokenVersion", type: "uint8" },
          { name: "r", type: "uint256" },
          { name: "h", type: "uint256" },
          { name: "k", type: "uint256" },
          { name: "dexSupplyThresh", type: "uint256" },
          { name: "quoteTokenAddress", type: "address" },
          { name: "nativeToQuoteSwapEnabled", type: "bool" },
          { name: "extensionID", type: "bytes32" },
          { name: "buyTaxRate", type: "uint256" },
          { name: "sellTaxRate", type: "uint256" },
          { name: "pool", type: "address" },
          { name: "progress", type: "uint256" },
          { name: "lpFeeProfile", type: "uint256" },
          { name: "dexId", type: "uint8" },
        ],
      },
    ],
  },
] as const;

// ── Flap.sh TokenStatus 枚举 ──
// 0=Invalid, 1=Tradable, 2=InDuel, 3=Killed, 4=DEX, 5=Staged
const FLAP_STATUS_TRADABLE = 1;
const FLAP_STATUS_DEX = 4;

// ── 检测函数 ──

/**
 * 检测代币在哪个内盘平台，以及当前状态。
 * 按 Four.meme → Flap.sh 顺序检测。
 */
export async function detectTokenMarket(
  publicClient: PublicClient,
  tokenAddress: string,
): Promise<TokenMarketInfo> {
  // 并行查询 Four.meme 和 Flap.sh，取最快命中的
  const [fourResult, flapResult] = await Promise.allSettled([
    detectFourMeme(publicClient, tokenAddress),
    detectFlap(publicClient, tokenAddress),
  ]);

  // 优先 Four.meme
  if (fourResult.status === "fulfilled" && fourResult.value) {
    return fourResult.value;
  }

  if (flapResult.status === "fulfilled" && flapResult.value) {
    return flapResult.value;
  }

  // 都没有 → 可能已在 DEX 或不存在
  return {
    platform: null,
    status: "unknown",
    managerAddress: "",
    price: "0",
    reserve: "0",
    progress: 0,
    extra: {},
  };
}

async function detectFourMeme(
  publicClient: PublicClient,
  tokenAddress: string,
): Promise<TokenMarketInfo | null> {
  // 1. 先尝试旧版 Helper（V1/V2 代币）
  try {
    const result = await publicClient.readContract({
      address: INNER_MARKET_CONTRACTS.FOURMEME_HELPER as `0x${string}`,
      abi: FOURMEME_HELPER_ABI,
      functionName: "getTokenInfo",
      args: [tokenAddress as `0x${string}`],
    });

    const [
      version,
      tokenManager,
      _quote,
      lastPrice,
      _tradingFeeRate,
      _minTradingFee,
      _launchTime,
      offers,
      maxOffers,
      funds,
      maxFunds,
      liquidityAdded,
    ] = result as [
      bigint,
      `0x${string}`,
      `0x${string}`,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
    ];

    // tokenManager 为零地址 → 代币不在旧版 Four.meme
    if (tokenManager !== "0x0000000000000000000000000000000000000000") {
      const fundsBnb = Number(funds) / 1e18;
      const maxFundsBnb = Number(maxFunds) / 1e18;
      const progress =
        maxFunds > 0n ? Number((funds * 10000n) / maxFunds) / 100 : 0;

      return {
        platform: "fourmeme",
        status: liquidityAdded ? "graduated" : "inner_market",
        managerAddress: tokenManager,
        price: lastPrice > 0n ? (Number(lastPrice) / 1e18).toFixed(12) : "0",
        reserve: fundsBnb.toFixed(4),
        progress,
        extra: {
          version: Number(version),
          offers: Number(offers),
          maxOffers: Number(maxOffers),
          fundsBnb,
          maxFundsBnb,
          liquidityAdded,
        },
      };
    }
  } catch {
    // 旧版 Helper 查询失败 → 继续尝试 OpenFour
  }

  // 2. 尝试新版 OpenFour Core（V12+）
  try {
    const openFourResult = await publicClient.readContract({
      address: INNER_MARKET_CONTRACTS.FOURMEME_OPENFOUR_CORE as `0x${string}`,
      abi: OPENFOUR_CORE_ABI,
      functionName: "tokens",
      args: [tokenAddress as `0x${string}`],
    });

    const openFour = openFourResult as [
      number, // version
      `0x${string}`, // creator
      bigint, // presetId
      `0x${string}`, // token_
      string, // name
      string, // symbol
      bigint, // maxSupply
      bigint, // saleAmount
      bigint, // raiseAmount
      `0x${string}`, // quoteAsset
      `0x${string}`, // vault
      `0x${string}`, // curveModule
      `0x${string}`, // tradeModule
      `0x${string}`, // migrateModule
      `0x${string}`, // tokenModule
      `0x${string}`, // customData
      bigint, // createBlock
      boolean, // exists
      boolean, // paused
      boolean, // antiSniperEnabled
    ];

    const exists = openFour[17];
    const paused = openFour[18];
    const vault = openFour[10];
    const raiseAmount = openFour[8];

    if (exists && !paused) {
      const [phase, totalRaised, remainingForSale] = await publicClient.readContract({
        address: vault,
        abi: OPENFOUR_VAULT_ABI,
        functionName: "phase",
      }).then(async () => {
        return await Promise.all([
          publicClient.readContract({ address: vault, abi: OPENFOUR_VAULT_ABI, functionName: "phase" }),
          publicClient.readContract({ address: vault, abi: OPENFOUR_VAULT_ABI, functionName: "totalRaised" }),
          publicClient.readContract({ address: vault, abi: OPENFOUR_VAULT_ABI, functionName: "remainingForSale" }),
        ]);
      });

      // Phase: 0=Created, 1=Trading, 2=MigratePending, 3=Migrated, 4=Terminal, 5=SoldOut
      const isGraduated = phase >= 3;
      const progress = raiseAmount > 0n
        ? Number((totalRaised * 10000n) / raiseAmount) / 100
        : 0;

      return {
        platform: "fourmeme",
        status: isGraduated ? "graduated" : "inner_market",
        managerAddress: INNER_MARKET_CONTRACTS.FOURMEME_OPENFOUR_CORE,
        price: "0",
        reserve: (Number(totalRaised) / 1e18).toFixed(4),
        progress,
        extra: {
          version: "v12",
          openFourVersion: openFour[0],
          vault,
          curveModule: openFour[11],
          tradeModule: openFour[12],
          quoteAsset: openFour[9],
          totalRaised: totalRaised.toString(),
          remainingForSale: remainingForSale.toString(),
          phase: Number(phase),
          antiSniperEnabled: openFour[19],
        },
      };
    }
  } catch {
    // OpenFour 也失败 → 不是 Four.meme 代币
  }

  return null;
}

async function detectFlap(
  publicClient: PublicClient,
  tokenAddress: string,
): Promise<TokenMarketInfo | null> {
  const result = await publicClient.readContract({
    address: INNER_MARKET_CONTRACTS.FLAP_PORTAL as `0x${string}`,
    abi: FLAP_PORTAL_ABI,
    functionName: "getTokenV8",
    args: [tokenAddress as `0x${string}`],
  });

  // result 是一个 tuple 对象
  const state = result as {
    status: number;
    reserve: bigint;
    circulatingSupply: bigint;
    price: bigint;
    tokenVersion: number;
    r: bigint;
    h: bigint;
    k: bigint;
    dexSupplyThresh: bigint;
    quoteTokenAddress: `0x${string}`;
    nativeToQuoteSwapEnabled: boolean;
    extensionID: `0x${string}`;
    buyTaxRate: bigint;
    sellTaxRate: bigint;
    pool: `0x${string}`;
    progress: bigint;
    lpFeeProfile: bigint;
    dexId: number;
  };

  // status == 0 (Invalid) → 代币不在 Flap.sh
  if (state.status === 0) return null;

  const reserveBnb = Number(state.reserve) / 1e18;
  // progress 是 0~1e18 的范围
  const progressPercent = Number(state.progress) / 1e16;

  let marketStatus: TokenMarketStatus;
  if (state.status === FLAP_STATUS_TRADABLE) {
    marketStatus = "inner_market";
  } else if (state.status === FLAP_STATUS_DEX) {
    marketStatus = "graduated";
  } else {
    marketStatus = "unknown";
  }

  return {
    platform: "flap",
    status: marketStatus,
    managerAddress: INNER_MARKET_CONTRACTS.FLAP_PORTAL,
    price: state.price > 0n ? (Number(state.price) / 1e18).toFixed(12) : "0",
    reserve: reserveBnb.toFixed(4),
    progress: progressPercent,
    extra: {
      status: state.status,
      circulatingSupply: Number(state.circulatingSupply) / 1e18,
      buyTaxRate: Number(state.buyTaxRate),
      sellTaxRate: Number(state.sellTaxRate),
      pool: state.pool,
    },
  };
}
