import {
  createPublicClient,
  createWalletClient,
  http,
  parseGwei,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainConfig } from "../chains.js";
import type { OkxTransaction } from "../okx/types.js";

export async function getEvmWalletAddress(privateKey: string): Promise<string> {
  return privateKeyToAccount(normalizePrivateKey(privateKey)).address;
}

function normalizePrivateKey(value: string): Hex {
  const key = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("EVM_PRIVATE_KEY 必须是 32 字节十六进制私钥");
  }
  return key as Hex;
}

export async function broadcastEvmSwap(input: {
  chain: ChainConfig;
  rpcUrl: string;
  privateKey: string;
  tx: OkxTransaction;
}): Promise<Hex> {
  const account = privateKeyToAccount(normalizePrivateKey(input.privateKey));
  if (account.address.toLowerCase() !== input.tx.from.toLowerCase()) {
    throw new Error("OKX 交易发送地址与 EVM_PRIVATE_KEY 派生地址不一致");
  }

  const chain = {
    id: Number(input.chain.chainIndex),
    name: input.chain.name,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [input.rpcUrl] } },
  } as const;

  const publicClient = createPublicClient({ chain, transport: http(input.rpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(input.rpcUrl),
  });

  // BSC 最低 3 Gwei，OKX 有时返回 0；同时兼容 legacy 和 EIP-1559 字段
  const MIN_GAS_PRICE = parseGwei("3");
  const okxGasPrice = input.tx.gasPrice ? BigInt(input.tx.gasPrice) : 0n;
  const okxMaxFee = input.tx.maxPriorityFeePerGas ? BigInt(input.tx.maxPriorityFeePerGas) : 0n;
  // 取三者中最大值，确保不低于节点最低要求
  const effectiveGasPrice =
    okxGasPrice > okxMaxFee
      ? okxGasPrice > MIN_GAS_PRICE ? okxGasPrice : MIN_GAS_PRICE
      : okxMaxFee > MIN_GAS_PRICE ? okxMaxFee : MIN_GAS_PRICE;

  // 强制使用 legacy 交易（type:0），避免 EIP-1559 maxFeePerGas=0 被节点拒绝
  const request = await walletClient.prepareTransactionRequest({
    account,
    to: input.tx.to as Hex,
    data: input.tx.data as Hex,
    value: BigInt(input.tx.value || "0"),
    gas: input.tx.gas ? BigInt(input.tx.gas) : undefined,
    gasPrice: effectiveGasPrice,
    type: "legacy",
  });
  const signed = await walletClient.signTransaction(request);
  return publicClient.sendRawTransaction({ serializedTransaction: signed });
}
