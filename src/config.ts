import "dotenv/config";

export interface OkxCredentials {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  projectId: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`环境变量 ${name} 必须是非负数字`);
  }
  return value;
}

export function getOkxCredentials(): OkxCredentials {
  return {
    apiKey: required("OKX_API_KEY"),
    secretKey: required("OKX_SECRET_KEY"),
    passphrase: required("OKX_API_PASSPHRASE"),
    projectId: required("OKX_PROJECT_ID"),
  };
}

export function getRuntimeConfig() {
  return {
    liveTrading:
      process.env.LIVE_TRADING === "true" &&
      process.env.I_UNDERSTAND_LIVE_TRADING_RISK === "true",
    requestTimeoutMs: numberFromEnv("OKX_REQUEST_TIMEOUT_MS", 3_000),
    maxPriceImpactPercent: numberFromEnv(
      "MAX_PRICE_IMPACT_PERCENT",
      10,
    ),
    maxTokenTaxRate: numberFromEnv("MAX_TOKEN_TAX_RATE", 0.1),
  };
}

export function requireEnv(name: string): string {
  return required(name);
}

/**
 * 获取 BSC RPC URL（从逗号分隔的列表中取第一个）。
 */
export function getBscRpcUrl(): string {
  const raw = required("BSC_RPC_URL");
  const first = raw.split(",")[0]?.trim();
  if (!first) throw new Error("BSC_RPC_URL 为空");
  return first;
}
