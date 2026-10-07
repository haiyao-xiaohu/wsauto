import dotenv from "dotenv";
dotenv.config();

import { buildBscSwapUnified } from "../src/bsc-swap-builder.js";

const TOKEN = (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })());
const AMOUNT_BNB = "0.001";
const WALLET = process.env.EVM_WALLET_ADDRESS?.trim() || "";
const SLIPPAGE = process.env.RESONANCE_SLIPPAGE_PERCENT || "20";

async function main() {
  if (!WALLET) throw new Error("请配置 EVM_WALLET_ADDRESS");
  console.log(`\n=== 测试买入 ${TOKEN} ===`);
  console.log(`金额: ${AMOUNT_BNB} BNB | 滑点: ${SLIPPAGE}%\n`);

  try {
    console.log("1. 检测代币平台...");
    const result = await buildBscSwapUnified({
      tokenAddress: TOKEN,
      amount: AMOUNT_BNB,
      slippagePercent: SLIPPAGE,
      walletAddress: WALLET,
      options: { buildTx: false }, // dry-run, 不构建真实交易
    });

    console.log(`   ✅ 平台: ${result.platform}`);
    console.log(`   ✅ 路由: ${result.route}`);
    console.log(`   ✅ 预估代币: ${result.estimatedTokens}`);
    if (result.fourmemeQuote) {
      console.log(`   📊 Four.meme 预估量: ${result.fourmemeQuote.estimatedAmount}`);
      console.log(`   📊 msgValue: ${result.fourmemeQuote.amountMsgValue}`);
    }
    if (result.flapQuote) {
      console.log(`   📊 Flap.sh 预估量: ${result.flapQuote.estimatedOutput}`);
    }
    if (result.okxQuote) {
      console.log(`   📊 OKX DEX 预估量: ${result.okxQuote.toTokenAmount}`);
    }
    console.log(`\n✅ 可以买入！`);
  } catch (error: any) {
    console.error(`\n❌ 无法买入: ${error.message}`);
  }
}

main().catch(console.error);
