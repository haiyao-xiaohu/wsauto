import { config } from "dotenv";
config();

import { buildBscSwapUnified } from "../src/bsc-swap-builder.js";

async function main() {
  const tokenAddress = (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })());
  const walletAddress = process.env.EVM_WALLET_ADDRESS!;

  const result = await buildBscSwapUnified({
    tokenAddress,
    amount: "0.01",
    slippagePercent: "5",
    walletAddress,
  });

  console.log("Route:", result.route);
  console.log("Reason:", result.reason);
  console.log("Platform:", result.tokenMarket.platform);
  console.log("Status:", result.tokenMarket.status);
  console.log("Manager:", result.tokenMarket.managerAddress);
  console.log("Progress:", result.tokenMarket.progress);
  console.log("Extra:", JSON.stringify(result.tokenMarket.extra, null, 2));
  console.log("Tx to:", result.tx?.to);
  console.log("Tx value:", result.tx?.value?.toString());
  console.log("Tx data:", result.tx?.data?.slice(0, 100) + "...");
  if (result.fourmemeQuote) {
    console.log("FourMeme quote:", result.fourmemeQuote);
  }
}

main().catch(console.error);
