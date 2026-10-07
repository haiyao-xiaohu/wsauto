/**
 * RPC 统一解析模块
 *
 * 支持 BSC 和 Robinhood Chain 两条链，各自读取独立环境变量。
 * RPC URL 列表以逗号分隔，去重保序，支持 fallback。
 */

// ── BSC ──

/**
 * 从 BSC_RPC_URL 解析出所有 RPC URL（逗号分隔），去重保序。
 */
export function parseBscRpcUrls(): string[] {
  const raw = process.env.BSC_RPC_URL?.trim() ?? "";
  const urls = new Set<string>();
  for (const part of raw.split(",")) {
    const url = part.trim();
    if (url) urls.add(url);
  }
  return [...urls];
}

/**
 * 获取第一个可用的 BSC RPC URL（逗号列表中的第一个）。
 */
export function getBscRpcUrl(): string {
  const urls = parseBscRpcUrls();
  if (urls.length === 0) throw new Error("BSC_RPC_URL 未配置");
  return urls[0]!;
}

// ── Robinhood Chain ──

/**
 * 从 ROBINHOOD_RPC_URL 解析出所有 RPC URL（逗号分隔），去重保序。
 */
export function parseRobRpcUrls(): string[] {
  const raw = process.env.ROBINHOOD_RPC_URL?.trim() ?? "";
  const urls = new Set<string>();
  for (const part of raw.split(",")) {
    const url = part.trim();
    if (url) urls.add(url);
  }
  return [...urls];
}

/**
 * 获取第一个可用的 Robinhood Chain RPC URL。
 */
export function getRobRpcUrl(): string {
  const urls = parseRobRpcUrls();
  if (urls.length === 0) throw new Error("ROBINHOOD_RPC_URL 未配置");
  return urls[0]!;
}
