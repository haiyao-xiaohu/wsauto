import { config } from "dotenv";
config();

import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";

async function main() {
  const rpcUrl = process.env.BSC_RPC_URL || "";
  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });

  // 用户给的交易
  const txHash = process.env.TEST_TX_HASH;
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("请配置 TEST_TX_HASH");
  const tokenAddress = (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })()) as `0x${string}`;

  // 查交易的 to 地址
  const tx = await publicClient.getTransaction({ hash: txHash as `0x${string}` });
  console.log("买入交易 to:", tx.to);
  console.log("买入交易 input 前 10 字节:", tx.input.slice(0, 10));

  // 尝试旧的 Four.meme Helper
  const oldHelper = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034" as `0x${string}`;
  const oldAbi = [
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
      address: oldHelper,
      abi: oldAbi,
      functionName: "getTokenInfo",
      args: [tokenAddress],
    });
    console.log("旧 Helper 结果:", result);
  } catch (err) {
    console.log("旧 Helper 失败:", err instanceof Error ? err.message : String(err));
  }
}

main().catch(console.error);
