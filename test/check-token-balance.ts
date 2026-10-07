import { config } from "dotenv";
config();

import { createPublicClient, http, parseAbi } from "viem";
import { bsc } from "viem/chains";

const TOKEN = (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })()) as `0x${string}`;
const WALLET = (process.env.EVM_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000") as `0x${string}`;

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
]);

async function main() {
  const rpcUrl = process.env.BSC_RPC_URL || "";
  const client = createPublicClient({ chain: bsc, transport: http(rpcUrl) });

  const [balance, decimals, symbol] = await Promise.all([
    client.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [WALLET] }),
    client.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "decimals" }),
    client.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "symbol" }),
  ]);

  console.log("Wallet:", WALLET);
  console.log("Token:", TOKEN);
  console.log("Symbol:", symbol);
  console.log("Balance:", (Number(balance) / 10 ** decimals).toLocaleString());
}

main().catch(console.error);
