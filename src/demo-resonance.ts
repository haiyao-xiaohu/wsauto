import { signQuickNodeWebhook } from "./quicknode-signature.js";
import { ERC20_TRANSFER_TOPIC } from "./signals/bsc.js";

const DEMO_WALLETS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
] as const;
const DEMO_ROUTER = "0xcccccccccccccccccccccccccccccccccccccccc";
const DEMO_TOKEN = "0x1111111111111111111111111111111111111111";

function topicAddress(address: string): string {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function payload(walletAddress: string, hashDigit: string): string {
  const timestampSeconds = Math.floor(Date.now() / 1_000);
  return JSON.stringify({
    matchingReceipts: [
      {
        blockNumber: "0x1",
        from: walletAddress,
        status: "0x1",
        transactionHash: `0x${hashDigit.repeat(64)}`,
        logs: [
          {
            address: DEMO_TOKEN,
            blockTimestamp: `0x${timestampSeconds.toString(16)}`,
            data: "0x1",
            topics: [
              ERC20_TRANSFER_TOPIC,
              topicAddress(DEMO_ROUTER),
              topicAddress(walletAddress),
            ],
          },
        ],
      },
    ],
  });
}

async function send(index: number): Promise<void> {
  const port = process.env.WEBHOOK_PORT?.trim() || "8080";
  const endpoint =
    process.env.DEMO_WEBHOOK_URL?.trim() ||
    `http://127.0.0.1:${port}/webhook`;
  const body = payload(DEMO_WALLETS[index] ?? DEMO_WALLETS[0], String(index + 7));
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = `demo-${index}-${Date.now()}`;
  const secret = process.env.QUICKNODE_STREAM_SECRET?.trim();
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret) {
    headers["x-qn-nonce"] = nonce;
    headers["x-qn-timestamp"] = timestamp;
    headers["x-qn-signature"] = signQuickNodeWebhook(
      secret,
      { nonce, timestamp },
      body,
    );
  }

  const response = await fetch(endpoint, { method: "POST", headers, body });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(`demo webhook ${response.status}: ${JSON.stringify(result)}`);
  }
  console.log(`wallet ${index + 1}: ${JSON.stringify(result)}`);
}

async function main(): Promise<void> {
  await send(0);
  await new Promise((resolve) => setTimeout(resolve, 750));
  await send(1);
  const port = process.env.WEBHOOK_PORT?.trim() || "8080";
  console.log(`dashboard: http://127.0.0.1:${port}/`);
  console.log("演示只发送本地合成事件，不签名、不广播链上交易。");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`demo failed: ${message}`);
  process.exitCode = 1;
});
