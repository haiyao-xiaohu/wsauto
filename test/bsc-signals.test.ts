import assert from "node:assert/strict";
import test from "node:test";
import {
  ERC20_TRANSFER_TOPIC,
  extractBscBuySignals,
} from "../src/signals/bsc.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROUTER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN = "0x1111111111111111111111111111111111111111";
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const HASH = `0x${"1".repeat(64)}`;

function topicAddress(address: string): string {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function transfer(input: {
  token: string;
  from: string;
  to: string;
  amount: bigint;
}) {
  return {
    address: input.token,
    blockTimestamp: "0x64",
    data: `0x${input.amount.toString(16)}`,
    topics: [
      ERC20_TRANSFER_TOPIC,
      topicAddress(input.from),
      topicAddress(input.to),
    ],
  };
}

test("从成功 receipt 中提取目标代币净流入", () => {
  const payload = {
    matchingReceipts: [
      {
        blockNumber: "0x38",
        from: WALLET,
        status: "0x1",
        transactionHash: HASH,
        logs: [
          transfer({
            token: USDT,
            from: WALLET,
            to: ROUTER,
            amount: 10n,
          }),
          transfer({
            token: TOKEN,
            from: ROUTER,
            to: WALLET,
            amount: 1_000n,
          }),
        ],
      },
    ],
  };

  assert.deepEqual(extractBscBuySignals(payload), [
    {
      chainId: 56,
      tokenAddress: TOKEN,
      walletAddress: WALLET,
      txHash: HASH,
      blockTimestampMs: 100_000,
      blockNumber: 56,
    },
  ]);
});

test("失败交易和计价代币净流入不会成为买入信号", () => {
  const failed = {
    matchingReceipts: [
      {
        from: WALLET,
        status: "0x0",
        transactionHash: HASH,
        logs: [
          transfer({
            token: TOKEN,
            from: ROUTER,
            to: WALLET,
            amount: 1n,
          }),
        ],
      },
    ],
  };
  const quoteOnly = {
    matchingReceipts: [
      {
        from: WALLET,
        status: "0x1",
        transactionHash: HASH,
        logs: [
          transfer({
            token: USDT,
            from: ROUTER,
            to: WALLET,
            amount: 1n,
          }),
        ],
      },
    ],
  };

  assert.deepEqual(extractBscBuySignals(failed), []);
  assert.deepEqual(extractBscBuySignals(quoteOnly), []);
});

test("钱包卖出目标代币不会被识别为买入", () => {
  const sell = {
    matchingReceipts: [
      {
        from: WALLET,
        status: "0x1",
        transactionHash: HASH,
        logs: [
          transfer({
            token: TOKEN,
            from: WALLET,
            to: ROUTER,
            amount: 1_000n,
          }),
          transfer({
            token: USDT,
            from: ROUTER,
            to: WALLET,
            amount: 10n,
          }),
        ],
      },
    ],
  };

  assert.deepEqual(extractBscBuySignals(sell), []);
});
