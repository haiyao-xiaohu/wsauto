export type ChainKind = "evm" | "solana";

export interface ChainConfig {
  readonly name: string;
  readonly chainIndex: string;
  readonly kind: ChainKind;
  readonly nativeDecimals: number;
  readonly nativeTokenAddress: string;
  readonly rpcEnv: string;
}

export const CHAINS = {
  ethereum: {
    name: "Ethereum",
    chainIndex: "1",
    kind: "evm",
    nativeDecimals: 18,
    nativeTokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    rpcEnv: "ETHEREUM_RPC_URL",
  },
  bsc: {
    name: "BNB Smart Chain",
    chainIndex: "56",
    kind: "evm",
    nativeDecimals: 18,
    nativeTokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    rpcEnv: "BSC_RPC_URL",
  },
  base: {
    name: "Base",
    chainIndex: "8453",
    kind: "evm",
    nativeDecimals: 18,
    nativeTokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    rpcEnv: "BASE_RPC_URL",
  },
  robinhood: {
    name: "Robinhood Chain",
    chainIndex: "4663",
    kind: "evm",
    nativeDecimals: 18,
    nativeTokenAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    rpcEnv: "ROBINHOOD_RPC_URL",
  },
  solana: {
    name: "Solana",
    chainIndex: "501",
    kind: "solana",
    nativeDecimals: 9,
    nativeTokenAddress: "11111111111111111111111111111111",
    rpcEnv: "SOLANA_RPC_URL",
  },
} as const satisfies Record<string, ChainConfig>;

export type ChainName = keyof typeof CHAINS;

export function getChain(value: string): ChainConfig {
  const chain = CHAINS[value.toLowerCase() as ChainName];
  if (!chain) {
    throw new Error(
      `不支持的链 "${value}"。可选值：${Object.keys(CHAINS).join(", ")}`,
    );
  }
  return chain;
}
