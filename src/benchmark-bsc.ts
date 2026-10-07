import { parseUnits } from "viem";
import { CHAINS } from "./chains.js";
import { getOkxCredentials, getRuntimeConfig, requireEnv } from "./config.js";
import { OkxClient } from "./okx/client.js";
import { assertSwapSafe } from "./risk.js";

const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
const SAMPLE_COUNT = 5;
const MIN_REQUEST_INTERVAL_MS = 550;

function percentile(sorted: number[], value: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * value) - 1),
  );
  return sorted[index] ?? 0;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const runtime = getRuntimeConfig();
  if (runtime.liveTrading) {
    throw new Error("延迟基准测试只允许在 LIVE_TRADING=false 时运行");
  }

  const walletAddress = requireEnv("EVM_WALLET_ADDRESS");
  const client = new OkxClient(getOkxCredentials(), runtime.requestTimeoutMs);
  const samples: number[] = [];

  for (let index = 0; index < SAMPLE_COUNT + 1; index += 1) {
    const requestStartedAt = performance.now();
    const result = await client.getSwap({
      chainIndex: CHAINS.bsc.chainIndex,
      amount: parseUnits("0.001", CHAINS.bsc.nativeDecimals).toString(),
      fromTokenAddress: CHAINS.bsc.nativeTokenAddress,
      toTokenAddress: BSC_USDT,
      slippagePercent: "1",
      userWalletAddress: walletAddress,
      disableRFQ: true,
      gasLevel: "fast",
    });
    assertSwapSafe(result.swap, runtime);

    if (index === 0) {
      console.log(`warm-up: ${result.elapsedMs.toFixed(2)} ms`);
    } else {
      samples.push(result.elapsedMs);
      console.log(`sample ${index}: ${result.elapsedMs.toFixed(2)} ms`);
    }

    const requestDuration = performance.now() - requestStartedAt;
    if (requestDuration < MIN_REQUEST_INTERVAL_MS) {
      await wait(MIN_REQUEST_INTERVAL_MS - requestDuration);
    }
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  console.log(
    JSON.stringify(
      {
        samples: samples.length,
        minMs: Number(sorted[0]?.toFixed(2)),
        averageMs: Number(average.toFixed(2)),
        p50Ms: Number(percentile(sorted, 0.5).toFixed(2)),
        p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
        maxMs: Number(sorted.at(-1)?.toFixed(2)),
        rfqDisabled: true,
        connectionReusedWithinProcess: true,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`benchmark failed: ${message}`);
  process.exitCode = 1;
});
