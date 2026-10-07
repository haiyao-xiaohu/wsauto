/**
 * Four.meme 内盘买入模块
 *
 * 通过 Four.meme TokenManager 合约直接在 bonding curve 上买入代币。
 * 流程：
 *   1. Helper.tryBuy() → 获取精确 msgValue
 *   2. TokenManager.buyTokenAMAP() → 执行买入
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  type Hex,
  encodeFunctionData,
} from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { INNER_MARKET_CONTRACTS } from "./inner-market-detector.js";
import { getBscRpcUrl } from "./config.js";

// ── ABIs ──

const HELPER_ABI = parseAbi([
  "function tryBuy(address token, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)",
]);

const TOKEN_MANAGER_ABI = parseAbi([
  "function buyTokenAMAP(address token, uint256 funds, uint256 minAmount) payable",
]);

const OPENFOUR_CORE_ABI = parseAbi([
  "function tokens(address token) external view returns (uint32 version, address creator, uint256 presetId, address token_, string name, string symbol, uint256 maxSupply, uint256 saleAmount, uint256 raiseAmount, address quoteAsset, address vault, address curveModule, address tradeModule, address migrateModule, address tokenModule, address customData, uint256 createBlock, bool exists, bool paused, bool antiSniperEnabled)",
  "function buyByBudget(address token, uint256 maxQuotePayAmount, uint256 minAmountOut, uint256 options, bytes calldata proof) external payable",
]);

const OPENFOUR_VAULT_ABI = parseAbi([
  "function totalRaised() external view returns (uint256)",
  "function remainingForSale() external view returns (uint256)",
]);

const OPENFOUR_CURVE_ABI = parseAbi([
  "function evaluateReverse(address token, bool isBuy, uint256 quoteBudget, uint256 remainingForSale, uint256 totalRaised, uint256 timestamp) external view returns (uint256 tokenAmount, uint256 curveQuote)",
]);

const OPEN_FOUR_CORE = INNER_MARKET_CONTRACTS.FOURMEME_OPENFOUR_CORE;

// ── 类型 ──

export interface FourMemeBuyQuote {
  /** 预估获得的代币数量 (wei) */
  estimatedAmount: bigint;
  /** 预估花费的 BNB (wei) */
  estimatedCost: bigint;
  /** 手续费 (wei) */
  estimatedFee: bigint;
  /** 实际要发送的 msgValue (wei) — 必须精确 */
  amountMsgValue: bigint;
  /** TokenManager 合约地址 */
  tokenManager: string;
}

export interface FourMemeBuyResult {
  /** 交易哈希 */
  txHash: string;
  /** 实际获得的代币数量 */
  estimatedAmount: bigint;
  /** 实际发送的 BNB */
  amountMsgValue: bigint;
}

// ── Client 创建 ──

function getBscPublicClient() {
  return createPublicClient({ chain: bsc, transport: http(getBscRpcUrl()) });
}

function getBscWalletClient() {
  const privateKey = process.env.EVM_PRIVATE_KEY;
  if (!privateKey) throw new Error("EVM_PRIVATE_KEY 未配置");
  const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(key as Hex);
  return createWalletClient({ account, chain: bsc, transport: http(getBscRpcUrl()) });
}

// ── 查询买入报价 ──

/**
 * 获取 Four.meme 内盘买入报价。
 * @param tokenAddress 代币地址
 * @param bnbAmount 花费的 BNB 数量（字符串，如 "0.001"）
 */
export async function getFourMemeBuyQuote(
  tokenAddress: string,
  bnbAmount: string,
): Promise<FourMemeBuyQuote> {
  const publicClient = getBscPublicClient();
  const fundsWei = parseEther(bnbAmount);

  const result = await publicClient.readContract({
    address: INNER_MARKET_CONTRACTS.FOURMEME_HELPER as `0x${string}`,
    abi: HELPER_ABI,
    functionName: "tryBuy",
    args: [tokenAddress as `0x${string}`, 0n, fundsWei],
  });

  const [
    tokenManager,
    _quote,
    estimatedAmount,
    estimatedCost,
    estimatedFee,
    amountMsgValue,
    _amountApproval,
    _amountFunds,
  ] = result as [
    `0x${string}`,
    `0x${string}`,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];

  return {
    estimatedAmount,
    estimatedCost,
    estimatedFee,
    amountMsgValue,
    tokenManager,
  };
}

// ── 构建买入 calldata ──

/**
 * 构建 Four.meme 买入交易的 calldata（不广播）。
 * 用于 dry-run 模式或手动广播。
 * @param managerAddress 可选：由调用方传入的合约地址；不传时自动检测旧版/OpenFour。
 */
export async function buildFourMemeBuyTx(
  tokenAddress: string,
  bnbAmount: string,
  slippagePercent: string = "5",
  managerAddress?: string,
): Promise<{
  to: string;
  data: Hex;
  value: bigint;
  estimatedAmount: bigint;
  estimatedCost: bigint;
  amountMsgValue: bigint;
  minAmount: bigint;
  tokenManager: string;
}> {
  // 如果调用方明确指定了 OpenFourCore，或者检测为新版 V12，则走 OpenFour 路径
  const isOpenFour =
    managerAddress?.toLowerCase() === OPEN_FOUR_CORE.toLowerCase() ||
    (await isOpenFourToken(tokenAddress));

  if (isOpenFour) {
    return buildOpenFourBuyTx(tokenAddress, bnbAmount, slippagePercent);
  }

  // 旧版 Four.meme TokenManager
  const quote = await getFourMemeBuyQuote(tokenAddress, bnbAmount);

  // 零值检查：amountMsgValue = 0 说明代币已毕业或暂停，无法买入
  if (quote.amountMsgValue === 0n) {
    throw new Error(
      `Four.meme tryBuy 返回 amountMsgValue=0，代币 ${tokenAddress.slice(0, 10)}... 可能已毕业或暂停`,
    );
  }

  // 计算最小获得量（滑点保护）
  const slippage = Number(slippagePercent);
  const minAmount =
    (quote.estimatedAmount * BigInt(Math.floor((100 - slippage) * 100))) / 10000n;

  const data = encodeFunctionData({
    abi: TOKEN_MANAGER_ABI,
    functionName: "buyTokenAMAP",
    args: [tokenAddress as `0x${string}`, quote.estimatedCost, minAmount],
  });

  return {
    to: quote.tokenManager,
    data,
    value: quote.amountMsgValue,
    estimatedAmount: quote.estimatedAmount,
    estimatedCost: quote.estimatedCost,
    amountMsgValue: quote.amountMsgValue,
    minAmount,
    tokenManager: quote.tokenManager,
  };
}

/**
 * 判断代币是否在新版 OpenFour Core 上。
 */
async function isOpenFourToken(tokenAddress: string): Promise<boolean> {
  try {
    const publicClient = getBscPublicClient();
    const result = await publicClient.readContract({
      address: OPEN_FOUR_CORE,
      abi: OPENFOUR_CORE_ABI,
      functionName: "tokens",
      args: [tokenAddress as `0x${string}`],
    });
    return (result as unknown as any[])[17] === true;
  } catch {
    return false;
  }
}

/**
 * 构建新版 OpenFour (V12+) 买入交易。
 */
async function buildOpenFourBuyTx(
  tokenAddress: string,
  bnbAmount: string,
  slippagePercent: string = "5",
): Promise<{
  to: string;
  data: Hex;
  value: bigint;
  estimatedAmount: bigint;
  estimatedCost: bigint;
  amountMsgValue: bigint;
  minAmount: bigint;
  tokenManager: string;
}> {
  const publicClient = getBscPublicClient();

  const tokenInfo = (await publicClient.readContract({
    address: OPEN_FOUR_CORE,
    abi: OPENFOUR_CORE_ABI,
    functionName: "tokens",
    args: [tokenAddress as `0x${string}`],
  })) as unknown as any[];

  const vault = tokenInfo[10] as `0x${string}`;
  const curveModule = tokenInfo[11] as `0x${string}`;

  const [totalRaised, remainingForSale] = await Promise.all([
    publicClient.readContract({ address: vault, abi: OPENFOUR_VAULT_ABI, functionName: "totalRaised" }),
    publicClient.readContract({ address: vault, abi: OPENFOUR_VAULT_ABI, functionName: "remainingForSale" }),
  ]);

  const budget = parseEther(bnbAmount);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const reverse = await publicClient.readContract({
    address: curveModule,
    abi: OPENFOUR_CURVE_ABI,
    functionName: "evaluateReverse",
    args: [tokenAddress as `0x${string}`, true, budget, remainingForSale, totalRaised, now],
  });

  const tokenAmount = reverse[0];
  const curveQuote = reverse[1];

  const slippage = Number(slippagePercent);
  const minAmount =
    (tokenAmount * BigInt(Math.floor((100 - slippage) * 100))) / 10000n;

  // 给手续费留 3% 余量；OpenFour 会把多余 BNB 退回
  const maxQuotePayAmount = (curveQuote * 103n) / 100n;

  const data = encodeFunctionData({
    abi: OPENFOUR_CORE_ABI,
    functionName: "buyByBudget",
    args: [
      tokenAddress as `0x${string}`,
      maxQuotePayAmount,
      minAmount,
      0n,
      "0x",
    ],
  });

  return {
    to: OPEN_FOUR_CORE,
    data,
    value: maxQuotePayAmount,
    estimatedAmount: tokenAmount,
    estimatedCost: curveQuote,
    amountMsgValue: maxQuotePayAmount,
    minAmount,
    tokenManager: OPEN_FOUR_CORE,
  };
}

// ── 执行买入（签名 + 广播） ──

/**
 * 在 Four.meme 内盘直接买入代币，签名并广播到 BSC。
 */
export async function executeFourMemeBuy(
  tokenAddress: string,
  bnbAmount: string,
  slippagePercent: string = "5",
): Promise<FourMemeBuyResult> {
  const tx = await buildFourMemeBuyTx(tokenAddress, bnbAmount, slippagePercent);

  const walletClient = getBscWalletClient();

  // OpenFour 买入需要更多 gas（实测约 900k）
  const gas = tx.to.toLowerCase() === OPEN_FOUR_CORE.toLowerCase() ? 1500000n : 500000n;

  const txHash = await walletClient.sendTransaction({
    to: tx.to as `0x${string}`,
    data: tx.data,
    value: tx.value,
    gas,
    chain: bsc,
  });

  return {
    txHash,
    estimatedAmount: tx.estimatedAmount,
    amountMsgValue: tx.value,
  };
}
