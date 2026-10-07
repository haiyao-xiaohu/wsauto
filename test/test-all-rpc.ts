import { config } from "dotenv";
config();

import { createPublicClient, http, type Hex } from "viem";
import { bsc } from "viem/chains";

const TOKEN = (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })()) as Hex;
const FLAP_PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0" as Hex;
// getTokenV8(address) selector: 0xf1159a49
const callData = `0xf1159a49000000000000000000000000${TOKEN.slice(2)}` as Hex;

const urls = (process.env.BSC_RPC_URL || "").split(",").map((s) => s.trim()).filter(Boolean);

async function main() {
  console.log(`Testing ${urls.length} RPC URLs\n`);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    const label = `RPC endpoint #${i}`;
    console.log(`[${i}] ${label}...`);

    const client = createPublicClient({
      chain: bsc,
      transport: http(url, { timeout: 10_000, retryCount: 0 }),
    });

    // Test 1: getBlockNumber
    try {
      const block = await client.getBlockNumber();
      console.log(`  ✅ getBlockNumber: ${block}`);
    } catch (e) {
      const err = e as any;
      console.log(`  ❌ getBlockNumber: ${err.shortMessage || err.message}`);
    }

    // Test 2: eth_call getTokenV8 (raw, no ABI decoding)
    try {
      const data = await client.call({ to: FLAP_PORTAL, data: callData });
      if (data.data && data.data !== "0x") {
        const dataLen = (data.data.length - 2) / 2;
        console.log(`  ✅ getTokenV8 raw: ${dataLen} bytes`);
        // Parse first 32 bytes as uint8 status
        const status = parseInt(data.data.slice(2, 66).padEnd(64, "0").slice(-2), 16);
        const FLAP_STATUS: Record<number, string> = {
          0: "Invalid",
          1: "Tradable",
          2: "InDuel",
          3: "Killed",
          4: "DEX",
          5: "Staged",
        };
        console.log(`     status=${status} (${FLAP_STATUS[status] || "?"})`);
        // Total return size for tuple with lpFeeProfile as uint256 = 17*32 = 544 bytes
        // Total return size for tuple with lpFeeProfile as tuple(uint24,int24) = 18*32 = 576 bytes
        if (dataLen === 544) console.log(`     → lpFeeProfile = uint256 (old ABI, 17 words)`);
        else if (dataLen === 576) console.log(`     → lpFeeProfile = tuple (new ABI, 18 words)`);
        else console.log(`     → unexpected size, neither 544 nor 576`);
      } else {
        console.log(`  ⚠️ getTokenV8 returned empty data`);
      }
    } catch (e) {
      const err = e as any;
      console.log(`  ❌ getTokenV8: ${err.shortMessage || err.message}`);
      if (err.metaMessages) console.log(`     meta: ${err.metaMessages[0]}`);
    }
    console.log("");
  }
}

main().catch(console.error);
