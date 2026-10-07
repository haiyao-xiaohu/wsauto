import { config } from "dotenv";
config();
import { OkxClient } from "../src/okx/client.js";
import { getOkxCredentials } from "../src/config.js";
import { CHAINS } from "../src/chains.js";
import { parseEther } from "viem";

async function main() {
  const TOKEN = process.argv[2] || (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })());
  const walletAddress = process.env.EVM_WALLET_ADDRESS || "";
  const credentials = getOkxCredentials();
  const okxClient = new OkxClient(credentials);
  const result = await okxClient.getSwap({
    chainIndex: CHAINS.bsc.chainIndex,
    fromTokenAddress: CHAINS.bsc.nativeTokenAddress,
    toTokenAddress: TOKEN,
    amount: parseEther("0.001").toString(),
    userWalletAddress: walletAddress,
    slippagePercent: "20",
  });
  console.log("swap keys:", Object.keys(result.swap ?? {}));
  console.log("swap.tx:", JSON.stringify(result.swap?.tx).slice(0, 200));
  console.log("full keys:", Object.keys(result));
}
main().catch(console.error);
