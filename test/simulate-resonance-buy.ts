/**
 * 模拟共振→买入全流程
 *
 * 用法: npx tsx test/simulate-resonance-buy.ts
 *
 * 模拟两个钱包对同一代币产生共振信号，然后走线上 preSign + buildBscSwapUnified 流程。
 */
import { config } from "dotenv";
config();

import { createPublicClient, http, type Hex } from "viem";
import { bsc } from "viem/chains";
import { getBscRpcUrl } from "../src/rpc.js";
import { detectTokenMarket } from "../src/inner-market-detector.js";

const TOKEN = (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })());
const WALLET_1 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// ── 模拟共振信号 ──
const MOCK_SIGNALS = [
  {
    walletAddress: WALLET_1,
    tokenAddress: TOKEN,
    blockTimestampMs: Date.now() - 500,
    txHash: "0x".concat("11".repeat(32)),
  },
  {
    walletAddress: WALLET_2,
    tokenAddress: TOKEN,
    blockTimestampMs: Date.now(),
    txHash: "0x".concat("22".repeat(32)),
  },
];

// ── 当前线上 ABI（lpFeeProfile: uint256）──
const FLAP_ABI_CURRENT = [
  {
    name: "getTokenV8",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "state",
        type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "reserve", type: "uint256" },
          { name: "circulatingSupply", type: "uint256" },
          { name: "price", type: "uint256" },
          { name: "tokenVersion", type: "uint8" },
          { name: "r", type: "uint256" },
          { name: "h", type: "uint256" },
          { name: "k", type: "uint256" },
          { name: "dexSupplyThresh", type: "uint256" },
          { name: "quoteTokenAddress", type: "address" },
          { name: "nativeToQuoteSwapEnabled", type: "bool" },
          { name: "extensionID", type: "bytes32" },
          { name: "buyTaxRate", type: "uint256" },
          { name: "sellTaxRate", type: "uint256" },
          { name: "pool", type: "address" },
          { name: "progress", type: "uint256" },
          { name: "lpFeeProfile", type: "uint256" },
          { name: "dexId", type: "uint8" },
        ],
      },
    ],
  },
];

// ── 修正后的 ABI（lpFeeProfile: tuple(uint24, int24)）──
const FLAP_ABI_FIXED = [
  {
    name: "getTokenV8",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "state",
        type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "reserve", type: "uint256" },
          { name: "circulatingSupply", type: "uint256" },
          { name: "price", type: "uint256" },
          { name: "tokenVersion", type: "uint8" },
          { name: "r", type: "uint256" },
          { name: "h", type: "uint256" },
          { name: "k", type: "uint256" },
          { name: "dexSupplyThresh", type: "uint256" },
          { name: "quoteTokenAddress", type: "address" },
          { name: "nativeToQuoteSwapEnabled", type: "bool" },
          { name: "extensionID", type: "bytes32" },
          { name: "buyTaxRate", type: "uint256" },
          { name: "sellTaxRate", type: "uint256" },
          { name: "pool", type: "address" },
          { name: "progress", type: "uint256" },
          {
            name: "lpFeeProfile",
            type: "tuple",
            components: [
              { name: "lpFee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
            ],
          },
          { name: "dexId", type: "uint8" },
        ],
      },
    ],
  },
];

const FLAP_PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";

async function main() {
  const rpcUrl = getBscRpcUrl();
  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });

  console.log("=".repeat(70));
  console.log(`  模拟共振→买入全流程`);
  console.log(`  代币: ${TOKEN}`);
  console.log(`  RPC configured: ${Boolean(rpcUrl)}`);
  console.log(`  钱包1: ${WALLET_1}`);
  console.log(`  钱包2: ${WALLET_2}`);
  console.log(`  信号数: ${MOCK_SIGNALS.length} (共振阈值=2)`);
  console.log("=".repeat(70));

  // ── Step 0: 模拟共振触发 ──
  console.log("\n── Step 0: 模拟共振信号到达 ──");
  for (const s of MOCK_SIGNALS) {
    console.log(`  信号: wallet=${s.walletAddress.slice(0, 10)}... token=${s.tokenAddress.slice(0, 10)}...`);
  }
  console.log("  → 共振触发！开始 preSign 流程（第一个信号到达时启动）");

  // ── Step 1: detectTokenMarket（线上代码，直接调用）──
  console.log("\n── Step 1: detectTokenMarket（线上代码）──");
  const t1 = Date.now();
  try {
    const market = await detectTokenMarket(publicClient, TOKEN);
    const elapsed = Date.now() - t1;
    console.log(`  耗时: ${elapsed}ms`);
    console.log(`  platform: ${market.platform}`);
    console.log(`  status: ${market.status}`);
    console.log(`  progress: ${market.progress.toFixed(1)}%`);
    console.log(`  managerAddress: ${market.managerAddress}`);
    if (market.platform === null) {
      console.log("  ❌ 检测失败！platform=null，线上会抛 '未匹配任何已知平台' 错误");
    } else {
      console.log(`  ✅ 检测成功: ${market.platform}`);
    }
  } catch (err) {
    const elapsed = Date.now() - t1;
    console.log(`  耗时: ${elapsed}ms`);
    console.log(`  ❌ detectTokenMarket 抛异常: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Step 2: 用线上 ABI 直接调用 getTokenV8 ──
  console.log("\n── Step 2: getTokenV8 用线上 ABI (lpFeeProfile=uint256) ──");
  const t2 = Date.now();
  try {
    const result = await publicClient.readContract({
      address: FLAP_PORTAL as Hex,
      abi: FLAP_ABI_CURRENT,
      functionName: "getTokenV8",
      args: [TOKEN as Hex],
    });
    const elapsed = Date.now() - t2;
    console.log(`  耗时: ${elapsed}ms`);
    console.log(`  ✅ 调用成功 (不应该成功)`);
    console.log(`  status: ${(result as any).status}`);
  } catch (err: any) {
    const elapsed = Date.now() - t2;
    console.log(`  耗时: ${elapsed}ms`);
    console.log(`  ❌ 调用失败 (符合预期)`);
    console.log(`  错误类型: ${err.constructor.name}`);
    console.log(`  错误消息: ${err.shortMessage || err.message}`);
    if (err.metaMessages) {
      console.log(`  metaMessages: ${JSON.stringify(err.metaMessages)}`);
    }
    if (err.cause) {
      console.log(`  cause: ${err.cause.shortMessage || err.cause.message || String(err.cause)}`);
    }
  }

  // ── Step 3: 用修正 ABI 调用 getTokenV8 ──
  console.log("\n── Step 3: getTokenV8 用修正 ABI (lpFeeProfile=tuple) ──");
  const t3 = Date.now();
  try {
    const result = await publicClient.readContract({
      address: FLAP_PORTAL as Hex,
      abi: FLAP_ABI_FIXED,
      functionName: "getTokenV8",
      args: [TOKEN as Hex],
    });
    const elapsed = Date.now() - t3;
    const state = result as any;
    console.log(`  耗时: ${elapsed}ms`);
    console.log(`  ✅ 调用成功！`);
    console.log(`  status: ${state.status} (${["Invalid", "Tradable", "InDuel", "Killed", "DEX", "Staged"][state.status] || "?"})`);
    console.log(`  reserve: ${Number(state.reserve) / 1e18} BNB`);
    console.log(`  price: ${Number(state.price) / 1e18}`);
    console.log(`  progress: ${Number(state.progress) / 1e16}%`);
    console.log(`  tokenVersion: ${state.tokenVersion}`);
    console.log(`  buyTaxRate: ${Number(state.buyTaxRate)}`);
    console.log(`  sellTaxRate: ${Number(state.sellTaxRate)}`);
    console.log(`  pool: ${state.pool}`);
    console.log(`  lpFeeProfile: ${JSON.stringify(state.lpFeeProfile)}`);
    console.log(`  dexId: ${state.dexId}`);
  } catch (err: any) {
    const elapsed = Date.now() - t3;
    console.log(`  耗时: ${elapsed}ms`);
    console.log(`  ❌ 修正 ABI 也失败了`);
    console.log(`  错误消息: ${err.shortMessage || err.message}`);
    if (err.cause) {
      console.log(`  cause: ${err.cause.shortMessage || err.cause.message || String(err.cause)}`);
    }
  }

  // ── Step 4: 尝试线上 buildBscSwapUnified（模拟真实买入） ──
  console.log("\n── Step 4: buildBscSwapUnified（线上买入流程，dry-run）──");
  const t4 = Date.now();
  try {
    const { buildBscSwapUnified } = await import("../src/bsc-swap-builder.js");
    const result = await buildBscSwapUnified({
      tokenAddress: TOKEN,
      amount: "0.0017", // ~$1
      slippagePercent: "10",
      walletAddress: process.env.EVM_WALLET_ADDRESS || WALLET_1,
      options: { buildTx: false },
    });
    const elapsed = Date.now() - t4;
    console.log(`  耗时: ${elapsed}ms`);
    console.log(`  ✅ 构建成功！`);
    console.log(`  route: ${result.route}`);
    console.log(`  reason: ${result.reason}`);
    if (result.flapQuote) {
      console.log(`  flapQuote.estimatedOutput: ${result.flapQuote.estimatedOutput}`);
      console.log(`  flapQuote.inputAmount: ${result.flapQuote.inputAmount}`);
      console.log(`  flapQuote.minOutputAmount: ${result.flapQuote.minOutputAmount}`);
    }
    if (result.tx) {
      console.log(`  tx.to: ${result.tx.to}`);
      console.log(`  tx.value: ${result.tx.value.toString()}`);
      console.log(`  tx.data length: ${result.tx.data.length}`);
    }
  } catch (err: any) {
    const elapsed = Date.now() - t4;
    console.log(`  耗时: ${elapsed}ms`);
    console.log(`  ❌ 构建失败 (符合预期：线上 ABI 有 bug)`);
    console.log(`  错误消息: ${err.message}`);
  }

  // ── 总结 ──
  console.log("\n" + "=".repeat(70));
  console.log("  总结");
  console.log("=".repeat(70));
  console.log("  如果 Step 1 失败但 Step 3 成功 → 确认 lpFeeProfile ABI 类型不匹配");
  console.log("  修复: 将 inner-market-detector.ts 中 lpFeeProfile 从 uint256 改为 tuple(uint24, int24)");
  console.log("");
}

main().catch(console.error);
