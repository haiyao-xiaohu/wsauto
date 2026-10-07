/**
 * Flap.sh（蝴蝶平台）内盘买入模块
 *
 * 通过 Flap.sh Portal 合约直接在 bonding curve 上买入代币。
 * 流程：
 *   1. Portal.quoteExactInput() → 预估输出数量
 *   2. Portal.swapExactInput()  → 执行买入
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  decodeAbiParameters,
  type Hex,
  encodeFunctionData,
} from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { INNER_MARKET_CONTRACTS } from "./inner-market-detector.js";
import { getBscRpcUrl } from "./config.js";

// ── ABIs ──

const PORTAL_ABI = parseAbi([
  "function swapExactInput((address inputToken, address outputToken, uint256 inputAmount, uint256 minOutputAmount, bytes permitData)) payable returns (uint256 outputAmount)",
]);

// ── 类型 ──

export interface FlapBuyQuote {
  /** 预估获得的代币数量 (wei) */
  estimatedOutput: bigint;
  /** 花费的 BNB (wei) */
  inputAmount: bigint;
}

export interface FlapBuyResult {
  /** 交易哈希 */
  txHash: string;
  /** 实际获得的代币数量 */
  estimatedOutput: bigint;
  /** 实际发送的 BNB */
  inputAmount: bigint;
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
 * 获取 Flap.sh 内盘买入报价。
 * 通过 eth_call 模拟 swapExactInput（minOutputAmount=0）来获取预估输出量，
 * 同时验证交易可执行（preflight）。
 * @param tokenAddress 代币地址
 * @param bnbAmount 花费的 BNB 数量（字符串，如 "0.001"）
 */
export async function getFlapBuyQuote(
  tokenAddress: string,
  bnbAmount: string,
): Promise<FlapBuyQuote> {
  const publicClient = getBscPublicClient();
  const inputAmount = parseEther(bnbAmount);

  // 用 swapExactInput eth_call（minOutputAmount=0）做 preflight + 获取预估数量
  // 必须带 account（即 walletAddress），否则 Portal 无法确定 recipient
  const walletAddress = process.env.EVM_WALLET_ADDRESS as `0x${string}` | undefined;

  const data = encodeFunctionData({
    abi: PORTAL_ABI,
    functionName: "swapExactInput",
    args: [
      {
        inputToken: "0x0000000000000000000000000000000000000000" as `0x${string}`, // BNB
        outputToken: tokenAddress as `0x${string}`,
        inputAmount,
        minOutputAmount: 0n,
        permitData: "0x" as Hex,
      },
    ],
  });

  const result = await publicClient.call({
    to: INNER_MARKET_CONTRACTS.FLAP_PORTAL as `0x${string}`,
    data,
    value: inputAmount,
    // 传入钱包地址作为 msg.sender，Portal 用它作为代币 recipient
    ...(walletAddress ? { account: walletAddress } : {}),
  });

  // 解码返回值 (uint256)，result.data 是 ABI 编码的十六进制
  const [outputAmount] = decodeAbiParameters([{ type: "uint256" }], result.data as Hex);

  return {
    estimatedOutput: outputAmount,
    inputAmount,
  };
}

// ── 构建买入 calldata ──

/**
 * 构建 Flap.sh 买入交易的 calldata（不广播）。
 * 用于 dry-run 模式或手动广播。
 */
export async function buildFlapBuyTx(
  tokenAddress: string,
  bnbAmount: string,
  slippagePercent: string = "5",
): Promise<{
  to: string;
  data: Hex;
  value: bigint;
  estimatedOutput: bigint;
  inputAmount: bigint;
  minOutputAmount: bigint;
}> {
  const quote = await getFlapBuyQuote(tokenAddress, bnbAmount);

  // 计算最小输出量（滑点保护）
  const slippage = Number(slippagePercent);
  const minOutputAmount =
    (quote.estimatedOutput * BigInt(Math.floor((100 - slippage) * 100))) / 10000n;

  const data = encodeFunctionData({
    abi: PORTAL_ABI,
    functionName: "swapExactInput",
    args: [
      {
        inputToken: "0x0000000000000000000000000000000000000000" as `0x${string}`,
        outputToken: tokenAddress as `0x${string}`,
        inputAmount: quote.inputAmount,
        minOutputAmount,
        permitData: "0x" as Hex,
      },
    ],
  });

  return {
    to: INNER_MARKET_CONTRACTS.FLAP_PORTAL,
    data,
    value: quote.inputAmount,
    estimatedOutput: quote.estimatedOutput,
    inputAmount: quote.inputAmount,
    minOutputAmount,
  };
}

// ── 执行买入（签名 + 广播） ──

/**
 * 在 Flap.sh 内盘直接买入代币，签名并广播到 BSC。
 */
export async function executeFlapBuy(
  tokenAddress: string,
  bnbAmount: string,
  slippagePercent: string = "5",
): Promise<FlapBuyResult> {
  const tx = await buildFlapBuyTx(tokenAddress, bnbAmount, slippagePercent);

  const walletClient = getBscWalletClient();

  const txHash = await walletClient.sendTransaction({
    to: tx.to as `0x${string}`,
    data: tx.data,
    value: tx.value,
    gas: 600000n,
    chain: bsc,
  });

  return {
    txHash,
    estimatedOutput: tx.estimatedOutput,
    inputAmount: tx.value,
  };
}
