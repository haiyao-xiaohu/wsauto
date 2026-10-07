import { config } from "dotenv";
config();

import { createPublicClient, http, parseAbi } from "viem";
import { bsc } from "viem/chains";

async function main() {
  const tokenAddress = process.argv[2] || (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })());
  const owner = process.env.EVM_WALLET_ADDRESS || "";
  const rpcUrl = process.env.BSC_RPC_URL || "";

  const spenders = [
    "0x62cceF0b4545166f721cAa9fEe13c1d3767E27dc", // OKX tx.to
    "0x000000000022D473030F116dDEE9F6B43aC78BA3", // Permit2
    "0xC3E5dd4D2Fdf89C2a46655fE653308e9c763b5E5", // OKX approve proxy (BSC guess)
    "0x3B626bdc1E38952EbAB2039c65e1c199E5B674Eb", // OKX swap router (BSC guess)
  ];

  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const abi = parseAbi([
    "function allowance(address owner, address spender) view returns (uint256)",
  ]);

  for (const spender of spenders) {
    try {
      const allowance = await publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi,
        functionName: "allowance",
        args: [owner as `0x${string}`, spender as `0x${string}`],
      });
      console.log(`${spender}: ${allowance.toString()}`);
    } catch (err) {
      console.log(`${spender}: ERROR ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch(console.error);
