import { config } from "dotenv";
config();

import { OkxClient } from "../src/okx/client.js";
import { getOkxCredentials } from "../src/config.js";
import { CHAINS } from "../src/chains.js";

async function main() {
  const tokenAddress = process.argv[2] || (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })());
  const amount = process.argv[3] || "5464492378633085251281";
  const walletAddress = process.env.EVM_WALLET_ADDRESS || "";

  const credentials = getOkxCredentials();
  const okxClient = new OkxClient(credentials);

  const result = await okxClient.getSwap({
    chainIndex: CHAINS.bsc.chainIndex,
    fromTokenAddress: tokenAddress,
    toTokenAddress: CHAINS.bsc.nativeTokenAddress,
    amount,
    userWalletAddress: walletAddress,
    slippagePercent: "20",
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
