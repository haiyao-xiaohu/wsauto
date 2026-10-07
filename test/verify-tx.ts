import { config } from "dotenv"; config();
import { createPublicClient, http, formatEther } from "viem";
import { bsc } from "viem/chains";
import { getBscRpcUrl } from "../src/rpc.js";

async function main() {
  const TX = process.argv[2];
  if (!TX || !/^0x[0-9a-fA-F]{64}$/.test(TX)) throw new Error("请通过命令行提供交易哈希");
  const client = createPublicClient({ chain: bsc, transport: http(getBscRpcUrl()) });
  const receipt = await client.getTransactionReceipt({ hash: TX as `0x${string}` });
  console.log("status:", receipt.status === "success" ? "✅ 成功" : "❌ 失败");
  console.log("blockNumber:", receipt.blockNumber.toString());
  console.log("from:", receipt.from);
  console.log("to:", receipt.to);

  // 查 Transfer 事件，看到底收到多少代币
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const transfers = receipt.logs.filter(l => l.topics[0] === transferTopic);
  for (const t of transfers) {
    const from = "0x" + t.topics[1].slice(26);
    const to = "0x" + t.topics[2].slice(26);
    const amount = BigInt(t.data);
    console.log(`Transfer: ${from.slice(0,10)}... → ${to.slice(0,10)}... amount=${formatEther(amount)}`);
  }
}
main().catch(console.error);
