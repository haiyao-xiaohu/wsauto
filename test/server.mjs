import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 8080;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_FILE = path.join(__dirname, "webhook.log");

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summarizePayload(payload) {
  const receiptCount = Array.isArray(payload?.matchingReceipts)
    ? payload.matchingReceipts.length
    : 0;
  const txCount = Array.isArray(payload?.matchingTransactions)
    ? payload.matchingTransactions.length
    : 0;
  const firstTxHash =
    payload?.matchingTransactions?.[0]?.hash ||
    payload?.matchingTransactions?.[0]?.transactionHash ||
    payload?.matchingReceipts?.[0]?.transactionHash ||
    null;

  return { receiptCount, txCount, firstTxHash };
}

const server = http.createServer((req, res) => {
  const chunks = [];

  req.on("data", (chunk) => chunks.push(chunk));

  req.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const payload = safeJsonParse(rawBody);
    const summary = summarizePayload(payload);
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: rawBody,
    };

    fs.appendFile(
      LOG_FILE,
      `${JSON.stringify(logEntry, null, 2)}\n\n`,
      "utf8",
      (error) => {
        if (error) {
          console.error("写入日志文件失败:", error.message);
        }
      },
    );

    console.log(`\n[${timestamp}] 收到请求: ${req.method} ${req.url}`);
    console.log("来源 Host:", req.headers.host || "-");
    console.log("QN 时间戳:", req.headers["x-qn-timestamp"] || "-");
    console.log("QN 签名:", req.headers["x-qn-signature"] || "-");
    console.log("匹配 receipts:", summary.receiptCount);
    console.log("匹配 transactions:", summary.txCount);
    console.log("首个交易哈希:", summary.firstTxHash || "-");
    console.log(`完整日志文件: ${LOG_FILE}`);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`本地服务已启动: http://${HOST}:${PORT}`);
  console.log("QuickNode 回调地址示例: /webhooks/quicknode");
  console.log(`完整请求日志文件: ${LOG_FILE}`);
});
