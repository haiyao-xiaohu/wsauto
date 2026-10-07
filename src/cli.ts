import { parseUnits } from "viem";
import { getChain } from "./chains.js";
import {
  getOkxCredentials,
  getRuntimeConfig,
  requireEnv,
} from "./config.js";
import {
  broadcastEvmSwap,
  getEvmWalletAddress,
} from "./execution/evm.js";
import {
  broadcastSolanaSwap,
  getSolanaWalletAddress,
} from "./execution/solana.js";
import { OkxClient } from "./okx/client.js";
import { assertSwapSafe } from "./risk.js";

function args(): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        "用法: npm run trade -- --chain bsc --to <代币地址> --amount 0.001 [--slippage 1]",
      );
    }
    values[key.slice(2)] = value;
  }
  return values;
}

async function main(): Promise<void> {
  const input = args();
  const chain = getChain(input.chain ?? "");
  const toTokenAddress = input.to;
  const humanAmount = input.amount;
  if (!toTokenAddress || !humanAmount) {
    throw new Error("必须提供 --to 和 --amount");
  }

  const runtime = getRuntimeConfig();
  const privateKey =
    chain.kind === "evm"
      ? process.env.EVM_PRIVATE_KEY?.trim()
      : process.env.SOLANA_PRIVATE_KEY?.trim();
  const configuredAddress =
    chain.kind === "evm"
      ? process.env.EVM_WALLET_ADDRESS?.trim()
      : process.env.SOLANA_WALLET_ADDRESS?.trim();
  const walletAddress = privateKey
    ? chain.kind === "evm"
      ? await getEvmWalletAddress(privateKey)
      : getSolanaWalletAddress(privateKey)
    : configuredAddress;
  if (!walletAddress) {
    throw new Error(
      chain.kind === "evm"
        ? "dry-run 至少需要 EVM_WALLET_ADDRESS；真实交易还需要 EVM_PRIVATE_KEY"
        : "dry-run 至少需要 SOLANA_WALLET_ADDRESS；真实交易还需要 SOLANA_PRIVATE_KEY",
    );
  }
  const amount = parseUnits(humanAmount, chain.nativeDecimals).toString();
  const okx = new OkxClient(getOkxCredentials(), runtime.requestTimeoutMs);

  const signalAt = performance.now();
  const result = await okx.getSwap({
    chainIndex: chain.chainIndex,
    amount,
    fromTokenAddress: chain.nativeTokenAddress,
    toTokenAddress,
    slippagePercent: input.slippage ?? "1",
    userWalletAddress: walletAddress,
    disableRFQ: true,
    gasLevel: "fast",
    ...(chain.kind === "solana"
      ? { directRoute: true, forJitoBundle: true }
      : {}),
  });

  assertSwapSafe(result.swap, runtime);
  const totalBeforeBroadcastMs = performance.now() - signalAt;
  const route = result.swap.routerResult;

  console.log(
    JSON.stringify(
      {
        mode: runtime.liveTrading ? "LIVE" : "DRY_RUN",
        chain: chain.name,
        walletAddress,
        fromAmount: route.fromTokenAmount,
        expectedToAmount: route.toTokenAmount,
        toSymbol: route.toToken.tokenSymbol,
        priceImpactPercent: route.priceImpactPercent,
        okxLatencyMs: Number(result.elapsedMs.toFixed(2)),
        preBroadcastLatencyMs: Number(totalBeforeBroadcastMs.toFixed(2)),
        routerAddress: result.swap.tx.to,
      },
      null,
      2,
    ),
  );

  if (!runtime.liveTrading) {
    console.log("DRY_RUN：交易已组装并通过本地风控，未签名、未广播。");
    return;
  }

  if (!privateKey) {
    throw new Error("实时交易已开启，但未配置测试钱包私钥");
  }
  const rpcUrl = requireEnv(chain.rpcEnv);
  const hash =
    chain.kind === "evm"
      ? await broadcastEvmSwap({
          chain,
          rpcUrl,
          privateKey,
          tx: result.swap.tx,
        })
      : await broadcastSolanaSwap({
          rpcUrl,
          privateKey,
          tx: result.swap.tx,
        });

  console.log(`已广播：${hash}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`失败：${message}`);
  process.exitCode = 1;
});
