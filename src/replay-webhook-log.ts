import fs from "node:fs";
import path from "node:path";
import { getResonanceConfig } from "./resonance-config.js";
import { ResonanceEngine, type ResonanceTrigger } from "./resonance.js";
import {
  extractBscBuySignals,
  type BscBuySignal,
} from "./signals/bsc.js";

interface LoggedWebhookRequest {
  body?: unknown;
  timestamp?: unknown;
}

function parseLogEntries(raw: string): LoggedWebhookRequest[] {
  return raw
    .trim()
    .split(/\n\n(?=\{)/)
    .filter(Boolean)
    .map((entry, index) => {
      try {
        return JSON.parse(entry) as LoggedWebhookRequest;
      } catch (error) {
        throw new Error(
          `无法解析日志中的第 ${index + 1} 条请求：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
}

function parsePayload(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function triggerSummary(trigger: ResonanceTrigger) {
  const sorted = [...trigger.signals].sort(
    (left, right) => left.blockTimestampMs - right.blockTimestampMs,
  );
  const first = sorted[0];
  const last = sorted.at(-1);
  return {
    tokenAddress: trigger.tokenAddress,
    triggeredAt: new Date(trigger.triggeredAtMs).toISOString(),
    deltaSeconds:
      first && last
        ? (last.blockTimestampMs - first.blockTimestampMs) / 1_000
        : 0,
    wallets: sorted.map((signal) => signal.walletAddress),
    txHashes: sorted.map((signal) => signal.txHash),
  };
}

function main(): void {
  const logPath = path.resolve(process.argv[2] ?? "test/webhook.log");
  const entries = parseLogEntries(fs.readFileSync(logPath, "utf8"));
  const signals: BscBuySignal[] = entries
    .flatMap((entry) => extractBscBuySignals(parsePayload(entry.body)))
    .sort(
      (left, right) =>
        left.blockTimestampMs - right.blockTimestampMs ||
        (left.blockNumber ?? 0) - (right.blockNumber ?? 0),
    );

  const config = getResonanceConfig();
  const watchedWallets =
    config.watchedWallets.size > 0 ? config.watchedWallets : undefined;
  const engine = new ResonanceEngine({
    threshold: config.threshold,
    windowMs: config.windowMs,
    cooldownMs: config.cooldownMs,
    ...(watchedWallets ? { watchedWallets } : {}),
  });
  const triggers: ResonanceTrigger[] = [];
  let watchedSignals = 0;

  for (const signal of signals) {
    const decision = engine.ingest(signal);
    if (decision.reason !== "not_watched") watchedSignals += 1;
    if (decision.trigger) triggers.push(decision.trigger);
  }

  console.log(
    JSON.stringify(
      {
        mode: "HISTORICAL_REPLAY_ONLY",
        logPath,
        deliveries: entries.length,
        extractedBuySignals: signals.length,
        uniqueSignalWallets: new Set(
          signals.map((signal) => signal.walletAddress),
        ).size,
        uniqueSignalTokens: new Set(
          signals.map((signal) => signal.tokenAddress),
        ).size,
        watchlistMode:
          config.watchedWallets.size > 0
            ? `${config.watchedWallets.size} configured wallets`
            : "all wallets in log (demo only)",
        watchedSignals,
        threshold: config.threshold,
        windowSeconds: config.windowMs / 1_000,
        cooldownSeconds: config.cooldownMs / 1_000,
        triggerCount: triggers.length,
        triggers: triggers.map(triggerSummary),
        transactionBroadcast: false,
      },
      null,
      2,
    ),
  );
}

main();
