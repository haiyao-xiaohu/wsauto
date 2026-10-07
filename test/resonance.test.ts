import assert from "node:assert/strict";
import test from "node:test";
import { ResonanceEngine } from "../src/resonance.js";
import type { BscBuySignal } from "../src/signals/bsc.js";

const TOKEN_A = "0x1111111111111111111111111111111111111111";
const TOKEN_B = "0x2222222222222222222222222222222222222222";
const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function signal(input: {
  timestampMs: number;
  wallet?: string;
  token?: string;
  tx?: string;
}): BscBuySignal {
  const txSuffix = input.tx ?? String(input.timestampMs).padStart(64, "0");
  return {
    chainId: 56,
    tokenAddress: input.token ?? TOKEN_A,
    walletAddress: input.wallet ?? WALLET_A,
    txHash: `0x${txSuffix}`,
    blockTimestampMs: input.timestampMs,
  };
}

function engine(): ResonanceEngine {
  return new ResonanceEngine({
    threshold: 2,
    windowMs: 30_000,
    cooldownMs: 600_000,
  });
}

test("两个不同钱包在 30 秒内买入同币时触发", () => {
  const subject = engine();

  assert.equal(
    subject.ingest(signal({ timestampMs: 1_000 })).reason,
    "accepted",
  );
  const result = subject.ingest(
    signal({ timestampMs: 30_999, wallet: WALLET_B }),
  );

  assert.equal(result.reason, "triggered");
  assert.equal(result.trigger?.tokenAddress, TOKEN_A);
  assert.deepEqual(
    result.trigger?.signals.map((item) => item.walletAddress),
    [WALLET_A, WALLET_B],
  );
});

test("同一钱包重复买入不增加共振计数", () => {
  const subject = engine();

  subject.ingest(signal({ timestampMs: 1_000 }));
  const result = subject.ingest(
    signal({ timestampMs: 2_000, tx: "2".padStart(64, "0") }),
  );

  assert.equal(result.reason, "accepted");
  assert.equal(result.uniqueWalletCount, 1);
});

test("超过 30 秒不触发", () => {
  const subject = engine();

  subject.ingest(signal({ timestampMs: 1_000 }));
  const result = subject.ingest(
    signal({ timestampMs: 31_001, wallet: WALLET_B }),
  );

  assert.equal(result.reason, "accepted");
  assert.equal(result.uniqueWalletCount, 1);
});

test("不同代币分别计算窗口", () => {
  const subject = engine();

  subject.ingest(signal({ timestampMs: 1_000, token: TOKEN_A }));
  const result = subject.ingest(
    signal({ timestampMs: 2_000, token: TOKEN_B, wallet: WALLET_B }),
  );

  assert.equal(result.reason, "accepted");
  assert.equal(result.uniqueWalletCount, 1);
});

test("Webhook 重复交易不会重复计数", () => {
  const subject = engine();
  const first = signal({ timestampMs: 1_000 });

  subject.ingest(first);
  const result = subject.ingest(first);

  assert.equal(result.reason, "duplicate");
});

test("触发后冷却期间不再次触发", () => {
  const subject = engine();

  subject.ingest(signal({ timestampMs: 1_000 }));
  subject.ingest(signal({ timestampMs: 2_000, wallet: WALLET_B }));
  const result = subject.ingest(
    signal({
      timestampMs: 3_000,
      tx: "3".padStart(64, "0"),
    }),
  );

  assert.equal(result.reason, "cooldown");
});

test("钱包白名单会排除无关钱包", () => {
  const subject = new ResonanceEngine({
    threshold: 2,
    windowMs: 30_000,
    cooldownMs: 600_000,
    watchedWallets: new Set([WALLET_A]),
  });

  assert.equal(
    subject.ingest(signal({ timestampMs: 1_000, wallet: WALLET_B })).reason,
    "not_watched",
  );
});

test("状态快照只返回当前 30 秒内的观察窗口", () => {
  const subject = engine();
  subject.ingest(signal({ timestampMs: 10_000 }));

  assert.equal(subject.snapshot(20_000).windows.length, 1);
  assert.equal(subject.snapshot(40_001).windows.length, 0);
});
