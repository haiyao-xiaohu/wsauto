import { config } from "dotenv";
config();

import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";

async function main() {
  const rpcUrl = process.env.BSC_RPC_URL || "";
  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const proxy = "0x1de460f363af910f51726def188f9004276bf4bc" as `0x${string}`;

  // EIP-1967 implementation slot
  const slot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as `0x${string}`;

  const storage = await publicClient.getStorageAt({
    address: proxy,
    slot,
  });

  if (storage) {
    const implementation = "0x" + storage.slice(-40);
    console.log("Implementation address:", implementation);
  } else {
    console.log("无法读取 implementation");
  }
}

main().catch(console.error);
