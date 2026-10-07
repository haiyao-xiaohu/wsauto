import { config } from "dotenv";
config();

import { buildBscSwapUnified } from "../src/bsc-swap-builder.js";
import { broadcastSwap } from "../src/broadcast.js";
import { positionTracker } from "../src/position-tracker.js";

async function main() {
  const tokenAddress =
    process.argv[2] || (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })());
  const walletAddress = process.env.EVM_WALLET_ADDRESS;
  if (!walletAddress) {
    throw new Error("EVM_WALLET_ADDRESS 未配置");
  }

  const amountBnb = process.argv[3] || "0.001";

  console.log(`[ManualBuy] 准备买入 ${tokenAddress}, 金额 ${amountBnb} BNB`);

  const result = await buildBscSwapUnified({
    tokenAddress,
    amount: amountBnb,
    slippagePercent: process.env.RESONANCE_SLIPPAGE_PERCENT || "20",
    walletAddress,
  });

  console.log(
    `[ManualBuy] 路由: ${result.route}, 原因: ${result.reason}, 平台: ${result.tokenMarket.platform}, 状态: ${result.tokenMarket.status}`,
  );

  if (!result.tx) {
    throw new Error("没有可广播的交易数据");
  }

  const broadcast = await broadcastSwap(result);
  console.log(
    `[ManualBuy] 买入成功: txHash=${broadcast.txHash}, route=${broadcast.route}`,
  );

  // 记录持仓，让 auto-sell 跟踪
  const tokenAmount =
    result.fourmemeQuote
      ? BigInt(result.fourmemeQuote.estimatedAmount)
      : result.flapQuote
        ? BigInt(result.flapQuote.estimatedOutput)
        : result.okxResult
          ? BigInt(result.okxResult.toTokenAmount)
          : 0n;
  const costBnb =
    result.fourmemeQuote
      ? BigInt(result.fourmemeQuote.amountMsgValue)
      : result.flapQuote
        ? BigInt(result.flapQuote.inputAmount)
        : BigInt(result.tx.value);

  const position = positionTracker.addPosition({
    tokenAddress,
    platform: result.route,
    tokenPlatform: result.tokenMarket.platform,
    buyTxHash: broadcast.txHash,
    costBnb,
    tokenAmount,
  });
  console.log(
    `[ManualBuy] 已记录持仓: positionId=${position.id}, tokenAmount=${tokenAmount.toString()}`,
  );
}

main().catch((error) => {
  console.error("[ManualBuy] 失败:", error);
  process.exit(1);
});
