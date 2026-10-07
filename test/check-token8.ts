import { config } from "dotenv";
config();
import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";
import { getBscRpcUrl } from "../src/rpc.js";

const TOKEN8_ABI = [
  { name: "_mode", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { name: "pair", inputs: [], outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { name: "quote", inputs: [], outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { name: "TOKEN_HELPER_5", inputs: [], outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
] as const;

async function main() {
  const TOKEN = process.argv[2] || (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })());
  const client = createPublicClient({ chain: bsc, transport: http(getBscRpcUrl()) });

  const [mode, pair, quoteToken, helper] = await Promise.all([
    client.readContract({ address: TOKEN as `0x${string}`, abi: TOKEN8_ABI, functionName: "_mode" }),
    client.readContract({ address: TOKEN as `0x${string}`, abi: TOKEN8_ABI, functionName: "pair" }),
    client.readContract({ address: TOKEN as `0x${string}`, abi: TOKEN8_ABI, functionName: "quote" }),
    client.readContract({ address: TOKEN as `0x${string}`, abi: TOKEN8_ABI, functionName: "TOKEN_HELPER_5" }),
  ]);

  console.log("_mode:", mode.toString(), mode === 0n ? "(NORMAL)" : mode === 1n ? "(TRANSFER_CONTROLLED)" : "(TRANSFER_RESTRICTED)");
  console.log("pair:", pair, pair === "0x0000000000000000000000000000000000000000" ? "← 还在内盘" : "← 已毕业，有PancakeSwap池子");
  console.log("quote token:", quoteToken);
  console.log("TOKEN_HELPER_5:", helper);
}
main().catch(console.error);
