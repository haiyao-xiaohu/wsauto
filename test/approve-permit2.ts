import { config } from "dotenv";
config();

import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, parseGwei, maxUint256 } from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

async function main() {
  const tokenAddress = process.argv[2] || (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })());
  const permit2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
  const privateKey = process.env.EVM_PRIVATE_KEY?.trim() || "";
  const rpcUrl = process.env.BSC_RPC_URL || "";

  const account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey as `0x${string}` : `0x${privateKey}` as `0x${string}`);
  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: bsc, transport: http(rpcUrl) });

  const data = encodeFunctionData({
    abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
    functionName: "approve",
    args: [permit2 as `0x${string}`, maxUint256],
  });

  const networkGasPrice = await publicClient.getGasPrice();
  const gasPrice = networkGasPrice > parseGwei("1") ? networkGasPrice : parseGwei("1");

  const request = await walletClient.prepareTransactionRequest({
    account,
    to: tokenAddress as `0x${string}`,
    data,
    value: 0n,
    gas: 100000n,
    gasPrice,
    type: "legacy",
  });

  const signed = await walletClient.signTransaction(request);
  const txHash = await publicClient.sendRawTransaction({ serializedTransaction: signed });
  console.log(`[Approve Permit2] txHash=${txHash}`);
}

main().catch(console.error);
