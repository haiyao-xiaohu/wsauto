import type { OkxSwapData } from "./okx/types.js";

export interface RiskLimits {
  maxPriceImpactPercent: number;
  maxTokenTaxRate: number;
}

export function assertSwapSafe(
  swap: OkxSwapData,
  limits: RiskLimits,
): void {
  const { fromToken, toToken, priceImpactPercent } = swap.routerResult;

  if (fromToken.isHoneyPot || toToken.isHoneyPot) {
    throw new Error("风控拒绝：OKX 将输入或输出代币标记为 honeypot");
  }

  for (const token of [fromToken, toToken]) {
    const taxRate = Number(token.taxRate);
    if (!Number.isFinite(taxRate)) {
      throw new Error(`风控拒绝：${token.tokenSymbol} 的税率无法解析`);
    }
    if (taxRate > limits.maxTokenTaxRate) {
      throw new Error(
        `风控拒绝：${token.tokenSymbol} 税率 ${taxRate} 超过上限 ${limits.maxTokenTaxRate}`,
      );
    }
  }

  const impact = Math.abs(Number(priceImpactPercent));
  if (!Number.isFinite(impact)) {
    throw new Error("风控拒绝：价格影响无法解析");
  }
  if (impact > limits.maxPriceImpactPercent) {
    throw new Error(
      `风控拒绝：价格影响 ${impact}% 超过上限 ${limits.maxPriceImpactPercent}%`,
    );
  }
}
