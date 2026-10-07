export interface SwapParams {
  chainIndex: string;
  amount: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  slippagePercent: string;
  userWalletAddress: string;
  swapMode?: "exactIn" | "exactOut";
  disableRFQ?: boolean;
  directRoute?: boolean;
  gasLevel?: "slow" | "average" | "fast";
  tips?: string;
  forJitoBundle?: boolean;
}

export interface OkxToken {
  decimal: string;
  isHoneyPot: boolean;
  taxRate: string;
  tokenContractAddress: string;
  tokenSymbol: string;
  tokenUnitPrice?: string;
}

export interface OkxTransaction {
  from: string;
  to: string;
  data: string;
  value: string;
  gas?: string;
  gasPrice?: string;
  maxPriorityFeePerGas?: string;
  minReceiveAmount?: string;
  signatureData?: string[];
}

export interface OkxRouterResult {
  chainIndex: string;
  fromToken: OkxToken;
  toToken: OkxToken;
  fromTokenAmount: string;
  toTokenAmount: string;
  priceImpactPercent: string;
  tradeFee?: string;
}

export interface OkxSwapData {
  routerResult: OkxRouterResult;
  tx: OkxTransaction;
}

export interface OkxApiResponse<T> {
  code: string;
  msg: string;
  data: T[];
}

export interface TimedSwapResult {
  elapsedMs: number;
  swap: OkxSwapData;
}
