import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { OkxTransaction } from "../okx/types.js";

function loadKeypair(value: string): Keypair {
  const trimmed = value.trim();
  const bytes = trimmed.startsWith("[")
    ? Uint8Array.from(JSON.parse(trimmed) as number[])
    : bs58.decode(trimmed);
  return Keypair.fromSecretKey(bytes);
}

export function getSolanaWalletAddress(privateKey: string): string {
  return loadKeypair(privateKey).publicKey.toBase58();
}

export async function broadcastSolanaSwap(input: {
  rpcUrl: string;
  privateKey: string;
  tx: OkxTransaction;
}): Promise<string> {
  const signer = loadKeypair(input.privateKey);
  if (signer.publicKey.toBase58() !== input.tx.from) {
    throw new Error("OKX 交易发送地址与 SOLANA_PRIVATE_KEY 派生地址不一致");
  }

  const transaction = VersionedTransaction.deserialize(
    Buffer.from(input.tx.data, "base64"),
  );
  transaction.sign([signer]);

  const connection = new Connection(input.rpcUrl, {
    commitment: "processed",
    confirmTransactionInitialTimeout: 5_000,
  });
  return connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
  });
}
