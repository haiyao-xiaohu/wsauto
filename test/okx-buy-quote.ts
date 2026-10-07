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

  try {
    const result = await okxClient.getSwap({
      chainIndex: CHAINS.bsc.chainIndex,
      fromTokenAddress: CHAINS.bsc.nativeTokenAddress,
      toTokenAddress: TOKEN,
      amount: parseEther("0.001").toString(),
      userWalletAddress: walletAddress,
      slippagePercent: "20",
    });
    const dex = result.routerResult?.dexRouterList?.[0]?.subRouterList?.[0]?.dexProtocol?.[0]?.dexName;
    console.log("✅ OKX报价成功");
    console.log("路由DEX:", dex);
    console.log("预估获得代币:", result.routerResult?.toTokenAmount);
    console.log("router:", result.swap?.tx?.to);
  } catch (e: any) {
    console.log("❌ OKX报价失败:", e.message);
  }
}
main();
