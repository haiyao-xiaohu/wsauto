import { config } from "dotenv"; config();
import { createPublicClient, http, formatGwei, formatEther } from "viem";
import { bsc } from "viem/chains";
import { getBscRpcUrl } from "../src/rpc.js";

async function main() {
  const client = createPublicClient({ chain: bsc, transport: http(getBscRpcUrl()) });

  // 当前 gasPrice
  const gasPrice = await client.getGasPrice();
  console.log("当前 gasPrice:", formatGwei(gasPrice), "Gwei");

  // 查最新 block，看 baseFee（如果有 EIP-1559）
  const block = await client.getBlock();
  console.log("block baseFeePerGas:", block.baseFeePerGas ? formatGwei(block.baseFeePerGas) + " Gwei" : "无 (legacy only)");

  // 最近交易的 gasPrice 采样
  const txHash = block.transactions[0];
  if (txHash) {
    const tx = await client.getTransaction({ hash: txHash });
    console.log("最近 tx type:", tx.type);
    console.log("最近 tx gasPrice:", formatGwei(tx.gasPrice ?? 0n), "Gwei");
    console.log("最近 tx maxFeePerGas:", tx.maxFeePerGas ? formatGwei(tx.maxFeePerGas) + " Gwei" : "N/A");
    console.log("最近 tx maxPriorityFeePerGas:", tx.maxPriorityFeePerGas ? formatGwei(tx.maxPriorityFeePerGas) + " Gwei" : "N/A");
  }

  // 计算 $0.01 / $600 = 0.0000167 BNB
  // 200k gas: 0.0000167 / 200000 = 0.0000835 Gwei
  // 300k gas: 0.0000167 / 300000 = 0.0000557 Gwei
  console.log("\n--- GMGN $0.01 对应的 gasPrice ---");
  console.log("200k gas →", (Number(parseEther("0.0000167")) / 200000 / 1e9).toFixed(6), "Gwei");
  console.log("300k gas →", (Number(parseEther("0.0000167")) / 300000 / 1e9).toFixed(6), "Gwei");

  // 看看 GMGN 交易实际 gasUsed
  // 查一个最近的 Four.meme 买入交易
}
import { parseEther } from "viem";
main().catch(console.error);
