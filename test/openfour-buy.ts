import { config } from "dotenv";
config();

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  formatEther,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { positionTracker } from "../src/position-tracker.js";

const OPEN_FOUR_CORE = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3" as `0x${string}`;
const TOKEN = (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })()) as `0x${string}`;
const BUY_BNB = "0.01";
const SLIPPAGE_PERCENT = 5;

const CORE_ABI = parseAbi([
  "function tokens(address token) external view returns (uint32 version, address creator, uint256 presetId, address token_, string name, string symbol, uint256 maxSupply, uint256 saleAmount, uint256 raiseAmount, address quoteAsset, address vault, address curveModule, address tradeModule, address migrateModule, address tokenModule, address customData, uint256 createBlock, bool exists, bool paused, bool antiSniperEnabled)",
  "function buyByBudget(address token, uint256 maxQuotePayAmount, uint256 minAmountOut, uint256 options, bytes calldata proof) external payable",
]);

const CURVE_ABI = parseAbi([
  "function evaluateReverse(address token, bool isBuy, uint256 quoteBudget, uint256 remainingForSale, uint256 totalRaised, uint256 timestamp) external view returns (uint256 tokenAmount, uint256 curveQuote)",
]);

const VAULT_ABI = parseAbi([
  "function totalRaised() external view returns (uint256)",
  "function remainingForSale() external view returns (uint256)",
]);

async function main() {
  const rpcUrl = process.env.BSC_RPC_URL || "";
  const privateKey = process.env.EVM_PRIVATE_KEY;
  if (!privateKey) throw new Error("EVM_PRIVATE_KEY missing");
  const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;

  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const account = privateKeyToAccount(key as Hex);
  const walletClient = createWalletClient({ account, chain: bsc, transport: http(rpcUrl) });

  console.log("Wallet:", account.address);
  console.log("Token:", TOKEN);
  console.log("Buy BNB:", BUY_BNB);

  const tokenInfo = await publicClient.readContract({
    address: OPEN_FOUR_CORE,
    abi: CORE_ABI,
    functionName: "tokens",
    args: [TOKEN],
  }) as any[];

  if (!tokenInfo[17]) {
    throw new Error("Token not found in OpenFourCore");
  }

  const vault = tokenInfo[10] as `0x${string}`;
  const curveModule = tokenInfo[11] as `0x${string}`;

  const [totalRaised, remainingForSale] = await Promise.all([
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "totalRaised" }),
    publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "remainingForSale" }),
  ]);

  const budget = parseEther(BUY_BNB);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const reverse = await publicClient.readContract({
    address: curveModule,
    abi: CURVE_ABI,
    functionName: "evaluateReverse",
    args: [TOKEN, true, budget, remainingForSale, totalRaised, now],
  });

  const tokenAmount = reverse[0];
  const curveQuote = reverse[1];
  const minAmountOut = (tokenAmount * BigInt(100 - SLIPPAGE_PERCENT)) / 100n;
  const maxQuotePayAmount = (curveQuote * 103n) / 100n;

  console.log("Token amount:", tokenAmount.toString());
  console.log("Curve quote:", formatEther(curveQuote), "BNB");
  console.log("Min amount out:", minAmountOut.toString());
  console.log("Max quote pay:", formatEther(maxQuotePayAmount), "BNB");

  const gasPrice = 5000000000n; // 5 gwei

  console.log("\nExecuting buyByBudget with gas=1,500,000 ...");
  const txHash = await walletClient.writeContract({
    address: OPEN_FOUR_CORE,
    abi: CORE_ABI,
    functionName: "buyByBudget",
    args: [TOKEN, maxQuotePayAmount, minAmountOut, 0n, "0x"],
    value: maxQuotePayAmount,
    gas: 1500000n,
    gasPrice,
    type: "legacy",
  });

  console.log("Tx hash:", txHash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("Status:", receipt.status);
  console.log("Gas used:", receipt.gasUsed.toString());

  if (receipt.status === "success") {
    positionTracker.addPosition({
      tokenAddress: TOKEN,
      platform: "fourmeme_inner",
      tokenPlatform: "fourmeme",
      buyTxHash: txHash,
      costBnb: maxQuotePayAmount,
      tokenAmount,
    });
    console.log("Position recorded.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
