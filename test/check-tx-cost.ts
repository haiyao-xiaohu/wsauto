import { config } from "dotenv"; config();
import { createPublicClient, http, formatEther } from "viem";
import { bsc } from "viem/chains";
import { getBscRpcUrl } from "../src/rpc.js";

async function main() {
  const TX = process.argv[2];
  if (!TX || !/^0x[0-9a-fA-F]{64}$/.test(TX)) throw new Error("请通过命令行提供交易哈希");
  const client = createPublicClient({ chain: bsc, transport: http(getBscRpcUrl()) });
  const receipt = await client.getTransactionReceipt({ hash: TX as `0x${string}` });
  const actualCost = receipt.gasUsed * receipt.effectiveGasPrice;
  console.log("gasUsed:", receipt.gasUsed.toString());
  console.log("effectiveGasPrice:", (Number(receipt.effectiveGasPrice) / 1e9).toFixed(4), "Gwei");
  console.log("实际 gas 费用:", formatEther(actualCost), "BNB");
  console.log("约:", (Number(formatEther(actualCost)) * 600).toFixed(4), "USD");
}
main().catch(console.error);
