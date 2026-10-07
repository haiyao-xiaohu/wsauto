import assert from "node:assert/strict";
import test from "node:test";
import type { OkxSwapData } from "../src/okx/types.js";
import { assertSwapSafe } from "../src/risk.js";

function swap(overrides: {
  honeyPot?: boolean;
  taxRate?: string;
  priceImpactPercent?: string;
} = {}): OkxSwapData {
  const token = {
    decimal: "18",
    isHoneyPot: overrides.honeyPot ?? false,
    taxRate: overrides.taxRate ?? "0",
    tokenContractAddress: "0x1",
    tokenSymbol: "TEST",
  };
  return {
    routerResult: {
      chainIndex: "56",
      fromToken: token,
      toToken: token,
      fromTokenAmount: "1",
      toTokenAmount: "1",
      priceImpactPercent: overrides.priceImpactPercent ?? "1",
    },
    tx: { from: "0x1", to: "0x2", data: "0x00", value: "0" },
  };
}

const limits = { maxPriceImpactPercent: 10, maxTokenTaxRate: 0.1 };

test("接受正常交易", () => {
  assert.doesNotThrow(() => assertSwapSafe(swap(), limits));
});

test("拒绝 honeypot", () => {
  assert.throws(() => assertSwapSafe(swap({ honeyPot: true }), limits));
});

test("拒绝高税代币", () => {
  assert.throws(() => assertSwapSafe(swap({ taxRate: "0.2" }), limits));
});

test("拒绝价格影响过大的交易", () => {
  assert.throws(
    () => assertSwapSafe(swap({ priceImpactPercent: "10.1" }), limits),
  );
});
