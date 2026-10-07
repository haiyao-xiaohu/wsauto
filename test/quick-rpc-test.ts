import { config } from "dotenv";
config();

import { createPublicClient, http, type Hex } from "viem";
import { bsc } from "viem/chains";

async function main() {
  const rpc = process.env.BSC_RPC_URL?.split(",")[0] || "";
  console.log("RPC configured:", Boolean(rpc));
  const client = createPublicClient({ chain: bsc, transport: http(rpc) });

  // Test 1: getBlockNumber (basic RPC)
  try {
    const block = await client.getBlockNumber();
    console.log("✅ getBlockNumber:", block);
  } catch (e) {
    const err = e as any;
    console.log("❌ getBlockNumber:", err.shortMessage || err.message);
  }

  // Test 2: eth_call (getTokenV8 function selector)
  const TOKEN = (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })()) as Hex;
  const FLAP_PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0" as Hex;
  // Function selector for getTokenV8(address): 0xf1159a49
  const callData = `0xf1159a49000000000000000000000000${TOKEN.slice(2)}` as Hex;
  try {
    const data = await client.call({ to: FLAP_PORTAL, data: callData });
    if (data.data) {
      console.log("✅ eth_call success! data length:", (data.data.length - 2) / 2, "bytes");
      console.log("  data preview:", data.data.slice(0, 100), "...");
    } else {
      console.log("⚠️ eth_call returned no data");
    }
  } catch (e) {
    const err = e as any;
    console.log("❌ eth_call error:", err.shortMessage || err.message);
    if (err.metaMessages) console.log("  meta[0]:", err.metaMessages[0]);
    if (err.cause) console.log("  cause:", err.cause.shortMessage || err.cause.message || String(err.cause));
  }

  // Test 3: getBytecode (basic RPC)
  try {
    const code = await client.getBytecode({ address: TOKEN });
    console.log("✅ getBytecode:", code ? `${(code.length - 2) / 2} bytes` : "empty");
  } catch (e) {
    const err = e as any;
    console.log("❌ getBytecode:", err.shortMessage || err.message);
  }
}

main().catch(console.error);
