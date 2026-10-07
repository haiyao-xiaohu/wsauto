import { createHmac } from "node:crypto";
import type { OkxCredentials } from "../config.js";
import type {
  OkxApiResponse,
  OkxSwapData,
  SwapParams,
  TimedSwapResult,
} from "./types.js";

const BASE_URL = "https://web3.okx.com";
const SWAP_PATH = "/api/v6/dex/aggregator/swap";

function toQuery(params: SwapParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return `?${query.toString()}`;
}

export function signOkxRequest(
  secretKey: string,
  timestamp: string,
  method: string,
  requestPathWithQuery: string,
  body = "",
): string {
  const prehash = `${timestamp}${method}${requestPathWithQuery}${body}`;
  return createHmac("sha256", secretKey).update(prehash).digest("base64");
}

export class OkxClient {
  constructor(
    private readonly credentials: OkxCredentials,
    private readonly timeoutMs = 3_000,
  ) {}

  async getSwap(params: SwapParams): Promise<TimedSwapResult> {
    const query = toQuery({ swapMode: "exactIn", ...params });
    const requestPath = `${SWAP_PATH}${query}`;
    const timestamp = new Date().toISOString();
    const signal = AbortSignal.timeout(this.timeoutMs);
    const startedAt = performance.now();

    const response = await fetch(`${BASE_URL}${requestPath}`, {
      method: "GET",
      signal,
      headers: {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": this.credentials.apiKey,
        "OK-ACCESS-SIGN": signOkxRequest(
          this.credentials.secretKey,
          timestamp,
          "GET",
          requestPath,
        ),
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": this.credentials.passphrase,
        "OK-ACCESS-PROJECT": this.credentials.projectId,
      },
    });

    const elapsedMs = performance.now() - startedAt;
    const payload = (await response.json()) as OkxApiResponse<OkxSwapData>;

    if (!response.ok) {
      throw new Error(`OKX HTTP ${response.status}: ${payload.msg || "请求失败"}`);
    }
    if (payload.code !== "0") {
      throw new Error(`OKX ${payload.code}: ${payload.msg || "请求失败"}`);
    }
    const swap = payload.data[0];
    if (!swap?.tx?.data) {
      throw new Error("OKX 响应中没有可执行交易数据");
    }

    return { elapsedMs, swap };
  }
}
