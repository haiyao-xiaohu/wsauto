import { config } from "dotenv";
config();

import { createPublicClient, http, decodeFunctionData } from "viem";
import { bsc } from "viem/chains";

async function main() {
  const rpcUrl = process.env.BSC_RPC_URL || "";
  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });

  const newManager = "0x1de460f363af910f51726def188f9004276bf4bc" as `0x${string}`;
  const tokenAddress = (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })()) as `0x${string}`;

  // 尝试旧的 getTokenInfo
  const oldGetTokenInfoAbi = [
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

  try {
    const result = await publicClient.readContract({
      address: newManager,
      abi: oldGetTokenInfoAbi,
      functionName: "getTokenInfo",
      args: [tokenAddress],
    });
    console.log("新地址 + 旧 ABI getTokenInfo:", result);
  } catch (err) {
    console.log("新地址 + 旧 ABI getTokenInfo 失败:", err instanceof Error ? err.message : String(err));
  }

  // 尝试 buyToken selector
  const txHash = process.env.TEST_TX_HASH;
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("请配置 TEST_TX_HASH");
  const tx = await publicClient.getTransaction({ hash: txHash as `0x${string}` });
  console.log("\n原始交易 input:", tx.input);
  console.log("selector:", tx.input.slice(0, 10));
  console.log("value:", tx.value.toString());

  // 尝试用 buyToken(address,uint256) 解码
  try {
    const decoded = decodeFunctionData({
      abi: [{ name: "buyToken", type: "function", inputs: [{ name: "token", type: "address" }, { name: "minAmount", type: "uint256" }] }],
      data: tx.input,
    });
    console.log("decode buyToken(address,uint256):", decoded);
  } catch {
    console.log("不是 buyToken(address,uint256)");
  }

  // 尝试 buyToken(address,uint256,address)
  try {
    const decoded = decodeFunctionData({
      abi: [{ name: "buyToken", type: "function", inputs: [{ name: "token", type: "address" }, { name: "minAmount", type: "uint256" }, { name: "referrer", type: "address" }] }],
      data: tx.input,
    });
    console.log("decode buyToken(address,uint256,address):", decoded);
  } catch {
    console.log("不是 buyToken(address,uint256,address)");
  }

  // 尝试 buyToken(address,uint256,address,uint256)
  try {
    const decoded = decodeFunctionData({
      abi: [{ name: "buyToken", type: "function", inputs: [{ name: "token", type: "address" }, { name: "minAmount", type: "uint256" }, { name: "referrer", type: "address" }, { name: "deadline", type: "uint256" }] }],
      data: tx.input,
    });
    console.log("decode buyToken(address,uint256,address,uint256):", decoded);
  } catch {
    console.log("不是 buyToken(address,uint256,address,uint256)");
  }
}

main().catch(console.error);
