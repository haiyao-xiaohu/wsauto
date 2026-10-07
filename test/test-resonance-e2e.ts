/**
 * 端到端共振买入测试
 *
 * 模拟线上真实链路：preSignBuyTx → broadcastPreSigned → waitForTx
 * 跳过 GMGN 挂单，只测买入主链路。
 *
 * 用法: npx tsx test/test-resonance-e2e.ts
 */
import { config } from "dotenv";
config();

import { prepareBuyTx, executePreparedTx, waitForTx, WaitForTxTimeoutError, type PreparedTransaction } from "../src/broadcast.js";

// ── 测试参数 ──
const TOKEN = (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })());
const WALLET_1 = process.env.TEST_WATCH_WALLET_1?.trim() || "";
const WALLET_2 = process.env.TEST_WATCH_WALLET_2?.trim() || "";
if (!/^0x[0-9a-fA-F]{40}$/.test(WALLET_1) || !/^0x[0-9a-fA-F]{40}$/.test(WALLET_2)) {
  throw new Error("请配置 TEST_WATCH_WALLET_1 和 TEST_WATCH_WALLET_2");
}
const AMOUNT = "0.0017"; // ~$1
const SLIPPAGE = "30";
const GAS_MULTIPLIER = 1.2;

const EXECUTOR_WALLET = process.env.EVM_WALLET_ADDRESS || "";

console.log("=".repeat(70));
console.log("  端到端共振买入测试（真实交易）");
console.log("=".repeat(70));
console.log(`  代币:    ${TOKEN}`);
console.log(`  共振钱包1: ${WALLET_1}`);
console.log(`  共振钱包2: ${WALLET_2}`);
console.log(`  执行钱包:  ${EXECUTOR_WALLET}`);
console.log(`  买入金额:  ${AMOUNT} BNB (~$1)`);
console.log(`  滑点:     ${SLIPPAGE}%`);
console.log(`  Gas倍率:   ${GAS_MULTIPLIER}x`);
console.log(`  GMGN挂单:  跳过`);
console.log("=".repeat(70));

// ── Step 0: 模拟共振信号 ──
console.log("\n── Step 0: 模拟共振信号到达 ──");
console.log(`  信号1: wallet=${WALLET_1.slice(0, 10)}... token=${TOKEN.slice(0, 10)}...`);
console.log(`  信号2: wallet=${WALLET_2.slice(0, 10)}... token=${TOKEN.slice(0, 10)}...`);
console.log("  → 2个钱包共振，触发买入流程");

// ── Step 1: preSignBuyTx（线上第一个信号到达时启动）──
console.log("\n── Step 1: prepareBuyTx（预构建：detect + build + estimateGas + gasPrice，不取 nonce）──");
const t1 = Date.now();
let prepared: PreparedTransaction;
try {
  prepared = await prepareBuyTx(TOKEN, AMOUNT, SLIPPAGE, EXECUTOR_WALLET, GAS_MULTIPLIER);
  const elapsed = Date.now() - t1;
  console.log(`  ✅ 预构建完成 (${elapsed}ms)`);
  console.log(`  route: ${prepared.result.route}`);
  console.log(`  gasLimit: ${prepared.gasLimit.toString()}`);
  console.log(`  gasPrice: ${(Number(prepared.gasPrice) / 1e9).toFixed(4)} Gwei`);
  console.log(`  nonce: 未分配（延迟到广播时）`);

  if (prepared.result.flapQuote) {
    const tokens = (BigInt(prepared.result.flapQuote.estimatedOutput) / BigInt(1e18)).toLocaleString();
    console.log(`  预估获得: ${tokens} 代币`);
  }
  if (prepared.result.fourmemeQuote) {
    const tokens = (BigInt(prepared.result.fourmemeQuote.estimatedAmount) / BigInt(1e18)).toLocaleString();
    console.log(`  预估获得: ${tokens} 代币`);
  }
  if (prepared.result.okxResult) {
    console.log(`  OKX toTokenAmount: ${prepared.result.okxResult.toTokenAmount}`);
  }
} catch (err) {
  const elapsed = Date.now() - t1;
  console.error(`  ❌ 预签名失败 (${elapsed}ms):`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.error(`  Stack: ${err.stack.split("\n").slice(0, 3).join("\n  ")}`);
  }
  process.exit(1);
}

// ── Step 2: broadcastPreSigned（线上共振触发后执行）──
console.log("\n── Step 2: executePreparedTx（获取 nonce → 签名 → 多 RPC 并行广播）──");
const t2 = Date.now();
let broadcastResult;
try {
  broadcastResult = await executePreparedTx(prepared);
  const elapsed = Date.now() - t2;
  console.log(`  ✅ 广播成功 (${elapsed}ms)`);
  console.log(`  txHash: ${broadcastResult.txHash}`);
  console.log(`  BSCScan: https://bscscan.com/tx/${broadcastResult.txHash}`);
} catch (err) {
  const elapsed = Date.now() - t2;
  console.error(`  ❌ 广播失败 (${elapsed}ms):`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ── Step 3: waitForTx（等待链上确认）──
console.log("\n── Step 3: waitForTx（等待链上确认）──");
const t3 = Date.now();
try {
  const receipt = await waitForTx(broadcastResult.txHash);
  const elapsed = Date.now() - t3;
  console.log(`  ✅ 交易确认 (${elapsed}ms)`);
  console.log(`  status: ${receipt.status}`);
  console.log(`  block: ${receipt.blockNumber}`);

  if (receipt.status === "success") {
    console.log("\n" + "=".repeat(70));
    console.log("  🎉 买入成功！");
    console.log("=".repeat(70));

    // 计算实际获得代币数量
    const r = prepared.result;
    const tokenAmount = r.fourmemeQuote
      ? BigInt(r.fourmemeQuote.estimatedAmount)
      : r.flapQuote
        ? BigInt(r.flapQuote.estimatedOutput)
        : r.okxResult
          ? BigInt(r.okxResult.toTokenAmount)
          : 0n;
    const costBnb = r.fourmemeQuote
      ? BigInt(r.fourmemeQuote.amountMsgValue)
      : r.flapQuote
        ? BigInt(r.flapQuote.inputAmount)
        : BigInt(r.tx!.value);

    console.log(`  代币:    ${TOKEN}`);
    console.log(`  TxHash:  ${broadcastResult.txHash}`);
    console.log(`  花费:    ${(Number(costBnb) / 1e18).toFixed(6)} BNB`);
    console.log(`  获得:    ${(Number(tokenAmount) / 1e18).toLocaleString()} 代币`);
    console.log(`  总耗时:   ${Date.now() - t1}ms (preSign + broadcast + confirm)`);
    console.log("=".repeat(70));
  } else {
    console.log("\n" + "=".repeat(70));
    console.log("  ⚠️ 交易被回滚 (reverted)");
    console.log("=".repeat(70));
    console.log(`  TxHash: ${broadcastResult.txHash}`);
    console.log(`  BSCScan: https://bscscan.com/tx/${broadcastResult.txHash}`);
  }
} catch (err) {
  const elapsed = Date.now() - t3;
  if (err instanceof WaitForTxTimeoutError) {
    console.log(`  ⏳ 确认超时 (${elapsed}ms)，tx 已广播，可能延迟上链`);
    console.log(`  TxHash: ${broadcastResult.txHash}`);
    console.log(`  BSCScan: https://bscscan.com/tx/${broadcastResult.txHash}`);
  } else {
    console.error(`  ❌ 等待确认失败 (${elapsed}ms):`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("\n测试完成。");
