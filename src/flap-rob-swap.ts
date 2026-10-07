/**
 * Flap.sh Rob 链内盘买入模块
 *
 * 通过 Rob 链 Flap.sh Portal 合约在 bonding curve 上买入代币。
 * 逻辑与 flap-swap.ts 相同，区别：
 *   - Portal 地址：0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09（Rob 链）
 *   - 使用 Rob 链 RPC（ROBINHOOD_RPC_URL）
 *   - gas 用 ETH（Arbitrum L2，支持 EIP-1559）
 *   - 每个钱包最多买入代币总量的 2%（Flap.sh 内盘限制）
 */

import {
  createPublicClient,
  http,
  parseAbi,
  parseEther,
  decodeAbiParameters,
  type Hex,
  encodeFunctionData,
  defineChain,
} from "viem";

import { getRobRpcUrl } from "./rpc.js";

// ── Rob 链 viem chain 对象 ──

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.ROBINHOOD_RPC_URL || "https://mainnet.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

// ── 合约地址 ──

/** Rob 链 Flap.sh Portal（v5.14.16）*/
export const ROB_FLAP_PORTAL = "0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09" as const;

// ── ABI ──

const PORTAL_ABI = parseAbi([
  "function swapExactInput((address inputToken, address outputToken, uint256 inputAmount, uint256 minOutputAmount, bytes permitData)) payable returns (uint256 outputAmount)",
]);

// ── 类型 ──

export interface FlapRobBuyQuote {
  /** 预估获得的代币数量 (wei) */
  estimatedOutput: bigint;
  /** 花费的 ETH (wei) */
  inputAmount: bigint;
}

export interface FlapRobBuyTx {
  to: string;
  data: Hex;
  value: bigint;
  estimatedOutput: bigint;
  inputAmount: bigint;
  minOutputAmount: bigint;
}

// ── Client 工厂 ──

function getRobPublicClient() {
  const rpcUrl = getRobRpcUrl();
  // 动态使用当前配置的 RPC URL，同时提供 chain 对象保证 chainId 正确
  return createPublicClient({
    chain: { ...robinhoodChain, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }),
  });
}

// ── 查询买入报价 ──

/**
 * 获取 Rob 链 Flap.sh 内盘买入报价。
 * 通过 eth_call 模拟 swapExactInput（minOutputAmount=0）获取预估输出量。
 */
export async function getFlapRobBuyQuote(
  tokenAddress: string,
  ethAmount: string,
): Promise<FlapRobBuyQuote> {
  const publicClient = getRobPublicClient();
  const inputAmount = parseEther(ethAmount);

  const walletAddress = process.env.EVM_WALLET_ADDRESS as `0x${string}` | undefined;

  const data = encodeFunctionData({
    abi: PORTAL_ABI,
    functionName: "swapExactInput",
    args: [
      {
        inputToken: "0x0000000000000000000000000000000000000000" as `0x${string}`, // ETH (native)
        outputToken: tokenAddress as `0x${string}`,
        inputAmount,
        minOutputAmount: 0n,
        permitData: "0x" as Hex,
      },
    ],
  });

  const result = await publicClient.call({
    to: ROB_FLAP_PORTAL as `0x${string}`,
    data,
    value: inputAmount,
    ...(walletAddress ? { account: walletAddress } : {}),
  });

  const [outputAmount] = decodeAbiParameters([{ type: "uint256" }], result.data as Hex);

  return {
    estimatedOutput: outputAmount,
    inputAmount,
  };
}

// ── 构建买入 calldata ──

/**
 * 构建 Rob 链 Flap.sh 买入交易的 calldata（不广播）。
 * @param tokenAddress 代币地址
 * @param ethAmount 花费的 ETH 数量（字符串，如 "0.0001"）
 * @param slippagePercent 滑点百分比（默认 "5"）
 */
export async function buildFlapRobBuyTx(
  tokenAddress: string,
  ethAmount: string,
  slippagePercent = "5",
): Promise<FlapRobBuyTx> {
  const quote = await getFlapRobBuyQuote(tokenAddress, ethAmount);

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
    to: ROB_FLAP_PORTAL,
    data,
    value: quote.inputAmount,
    estimatedOutput: quote.estimatedOutput,
    inputAmount: quote.inputAmount,
    minOutputAmount,
  };
}
