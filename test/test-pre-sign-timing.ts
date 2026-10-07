/**
 * 测试 Pre-sign 预签名优化的时序改进
 *
 * 测量两条路径的延迟：
 *   1. 正常流程: build + estimateGas + sign + broadcast
 *   2. 预签名流程: pre-sign(upfront) → trigger → broadcast(只做 send)
 *
 * 用法:
 *   npx tsx test/test-pre-sign-timing.ts
 *   TOKEN_ADDRESS=0x... npx tsx test/test-pre-sign-timing.ts
 */
import "dotenv/config";
import { preSignBuyTx, broadcastPreSigned } from "../src/broadcast.js";
import { buildBscSwapUnified } from "../src/bsc-swap-builder.js";
import { getBscClients } from "../src/broadcast.js";

const TOKEN = process.env.TOKEN_ADDRESS || (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })());
const AMOUNT = "0.001"; // BNB
const SLIPPAGE = "30";
const WALLET = process.env.EVM_WALLET_ADDRESS || "";

function ms(label: string, t: number): void {
  const elapsed = Date.now() - t;
  console.log(`  ${label}: ${elapsed}ms`);
}

/** 临时覆盖 BSC_RPC_URL 环境变量，跳过失效的 Ankr key */
function patchRpc(): void {
  const urls = (process.env.BSC_RPC_URL || "").split(",");
  // 过滤掉 ankr（已失效）
  const working = urls.filter((u) => !u.includes("ankr"));
  if (working.length > 0) {
    process.env.BSC_RPC_URL = working.join(",");
    console.log(`[INFO] 已切换 RPC，可用节点数: ${working.length}`);
  }
}

async function main() {
  patchRpc();

  console.log("═══ Pre-sign 时序测试 ═══");
  console.log(`Token: ${TOKEN}`);
  console.log(`Amount: ${AMOUNT} BNB, Slippage: ${SLIPPAGE}%\n`);

  // ── Phase 1: 正常流程（不广播，只测 build + sign 耗时）──
  console.log("【Phase 1】正常流程 (build + estimateGas + sign)");
  const t1 = Date.now();
  let result;
  try {
    result = await buildBscSwapUnified({
      tokenAddress: TOKEN,
      amount: AMOUNT,
      slippagePercent: SLIPPAGE,
      walletAddress: WALLET,
      options: { buildTx: true },
    });
  } catch (e) {
    console.log(`  buildBscSwapUnified 失败: ${(e as Error).message}`);
    console.log("  (代币可能不在内盘或 RPC 不可用，改用纯 RPC 测量)\n");
    await pureRpcTiming();
    return;
  }
  ms("buildBscSwapUnified", t1);

  if (!result.tx) {
    console.log("  交易构建失败（无 tx data）");
    return;
  }

  console.log(`  route: ${result.route}, platform: ${result.tokenMarket.platform}`);

  // 模拟 doBroadcast 中的 estimateGas + sign（不发送）
  const { publicClient, walletClient, account } = getBscClients();
  const { to, data, value } = result.tx;

  const tGas = Date.now();
  const estimated = await publicClient.estimateGas({
    account: account.address,
    to: to as `0x${string}`,
    data,
    value,
  });
  ms("estimateGas", tGas);

  const tPrice = Date.now();
  const gasPrice = await publicClient.getGasPrice();
  ms("getGasPrice", tPrice);

  const tNonce = Date.now();
  const nonce = await publicClient.getTransactionCount({
    address: account.address,
    includePending: true,
  });
  ms("getTransactionCount", tNonce);

  const tSign = Date.now();
  const request = await walletClient.prepareTransactionRequest({
    account,
    to: to as `0x${string}`,
    data,
    value,
    gas: (estimated * 120n) / 100n,
    gasPrice,
    nonce,
    type: "legacy",
  });
  await walletClient.signTransaction(request);
  ms("signTransaction", tSign);

  const normalTotal = Date.now() - t1;
  console.log(`  ── 正常流程总计: ${normalTotal}ms（trigger 后需走完全部步骤）\n`);

  // ── Phase 2: 预签名流程 ──
  console.log("【Phase 2】预签名流程 (preSignBuyTx = build + estimateGas + sign 一体)");
  const t2 = Date.now();
  const preSign = await preSignBuyTx(TOKEN, AMOUNT, SLIPPAGE, WALLET, 1.2);
  const preSignTime = Date.now() - t2;
  ms("preSignBuyTx (total upfront)", t2);
  console.log(`  route: ${preSign.result.route}, nonce: ${preSign.nonce}`);
  console.log(`  gasPrice: ${(Number(preSign.gasPrice) / 1e9).toFixed(4)} Gwei`);
  console.log(`  ── 预签名完成（第一个信号到达时执行）\n`);

  // ── Phase 3: trigger 后只需 sendRaw ──
  console.log("【Phase 3】trigger 后: broadcastPreSigned（只做 sendRaw）");
  console.log("  (不实际发送，避免花费 BNB。实际耗时 ~100-300ms)\n");

  // ── 汇总 ──
  console.log("════════════════════════════════════════════");
  console.log("  时序对比");
  console.log("════════════════════════════════════════════");
  console.log(`  正常流程 trigger→广播完成:  ${normalTotal}ms + sendRaw ~150ms ≈ ${normalTotal + 150}ms`);
  console.log(`  预签名 trigger→广播完成:    ~150ms (只做 sendRawTransaction)`);
  console.log(`  ──────────────────────────────────────────`);
  console.log(`  节省: ~${normalTotal}ms（约 ${Math.round((normalTotal / (normalTotal + 150)) * 100)}% 提速）`);
  console.log(`  你之前比第二个钱包慢 ~3s → 优化后预期慢 ~${Math.max(0, 3000 - normalTotal)}ms`);
}

/** 当 buildBscSwapUnified 失败时，用纯 RPC 测量各步骤耗时 */
async function pureRpcTiming(): Promise<void> {
  const { createPublicClient, http } = await import("viem");
  const { bsc } = await import("viem/chains");
  const { privateKeyToAccount } = await import("viem/accounts");

  const urls = (process.env.BSC_RPC_URL || "").split(",").filter(Boolean);
  const url = urls[0] || "https://bsc-rpc.publicnode.com";
  const pk = process.env.EVM_PRIVATE_KEY?.trim();
  if (!pk) { console.log("EVM_PRIVATE_KEY 未配置"); return; }
  const key = pk.startsWith("0x") ? pk : `0x${pk}`;
  const account = privateKeyToAccount(key as `0x${string}`);
  const client = createPublicClient({ chain: bsc, transport: http(url, { timeout: 15_000 }) });

  console.log("【纯 RPC 时序测量】");
  console.log(`  RPC configured: ${Boolean(url)}\n`);

  // 模拟 detectTokenMarket: 2 个并行 eth_call
  const tDetect = Date.now();
  const [four, flap] = await Promise.allSettled([
    client.readContract({
      address: "0x5c952063c7fc8610FFDB798152D69F0B9550762b" as `0x${string}`,
      abi: [{ inputs: [{ name: "token", type: "address" }], name: "getTokenInfo", outputs: [{ name: "tokenManager", type: "address" }], stateMutability: "view", type: "function" }],
      functionName: "getTokenInfo",
      args: [TOKEN as `0x${string}`],
    }),
    client.readContract({
      address: "0x4f70D04F72F5B1C7E5aF2E5A52ef7f6b5C7E6c3E" as `0x${string}`,
      abi: [{ inputs: [{ name: "token", type: "address" }], name: "getTokenV8", outputs: [{ name: "exists", type: "bool" }], stateMutability: "view", type: "function" }],
      functionName: "getTokenV8",
      args: [TOKEN as `0x${string}`],
    }),
  ]);
  ms("detectTokenMarket (2 RPC 并行)", tDetect);
  console.log(`  Four.meme: ${four.status === "fulfilled" ? JSON.stringify(four.value) : "not found"}`);
  console.log(`  Flap.sh:   ${flap.status === "fulfilled" ? JSON.stringify(flap.value) : "not found"}\n`);

  // 模拟 estimateGas
  const tGas = Date.now();
  try {
    await client.estimateGas({ account: account.address, to: account.address, value: 0n });
  } catch { /* expected to fail for simple transfer, just measuring latency */ }
  ms("estimateGas (模拟)", tGas);

  // 模拟 getGasPrice
  const tPrice = Date.now();
  await client.getGasPrice();
  ms("getGasPrice", tPrice);

  // 模拟 getTransactionCount
  const tNonce = Date.now();
  await client.getTransactionCount({ address: account.address, includePending: true });
  ms("getTransactionCount", tNonce);

  // 签名（本地，无 RPC）
  console.log("  signTransaction: <5ms (本地 ECDSA)");

  const buildEstimate = Date.now() - tDetect + 300; // +300ms for buildBuyTx RPC
  console.log(`\n  正常流程 trigger 后预估: ~${buildEstimate}ms + sendRaw ~150ms ≈ ${buildEstimate + 150}ms`);
  console.log(`  预签名 trigger 后:       ~150ms (只做 sendRaw)`);
  console.log(`  节省: ~${buildEstimate}ms`);
}

main().catch(console.error);
