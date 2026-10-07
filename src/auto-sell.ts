/**
 * 自动卖出模块
 *
 * 策略：
 *   - 涨 100% → 卖出 50%（出本回本）
 *   - 跌 50%  → 全部卖出（止损）
 *
 * 后台监控所有活跃持仓，满足条件时自动执行卖出。
 *
 * TODO: 预签名卖出交易（Pre-signed TX）
 *   - 买入成功后立刻构建 + 签名 approve + sell 交易
 *   - 价格达标时直接 sendRawTransaction，省 200-500ms
 *   - 参考 GMGN/DeBot 的做法
 *
 * TODO: 卖出阈值可调
 *   - 涨 150% 卖 50%（当前 100%）
 *   - 跌 40% 全卖（当前 50%）
 *   - 通过环境变量 TAKE_PROFIT_PERCENT / STOP_LOSS_PERCENT 配置
 */

import {
  parseAbi,
  parseGwei,
  encodeFunctionData,
  decodeAbiParameters,
  maxUint256,
  type Hex,
} from "viem";

import { positionTracker, type Position } from "./position-tracker.js";
import { INNER_MARKET_CONTRACTS } from "./inner-market-detector.js";
import { OkxClient } from "./okx/client.js";
import { CHAINS } from "./chains.js";
import { getOkxCredentials, getBscRpcUrl } from "./config.js";
import { getBscClients, type BscClients } from "./broadcast.js";
import * as runtimeConfig from "./runtime-config.js";

// ── 配置 ──

export interface AutoSellConfig {
  enabled: boolean;
  /** 止盈触发：涨幅百分比（如 100 = 涨 100%） */
  takeProfitPercent: number;
  /** 止盈卖出比例（如 0.5 = 卖出 50%） */
  takeProfitRatio: number;
  /** 止损触发：跌幅百分比（如 50 = 跌 50%） */
  stopLossPercent: number;
  /** 价格检查间隔（毫秒） */
  checkIntervalMs: number;
  /** 滑点百分比 */
  slippagePercent: string;
}

// ── ABIs ──

const FOURMEME_HELPER_ABI = parseAbi([
  "function trySell(address token, uint256 amount) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)",
]);

const FOURMEME_MANAGER_ABI = parseAbi([
  "function sellToken(address token, uint256 amount, uint256 minFunds) payable",
]);

const OPENFOUR_CORE_ABI = parseAbi([
  "function tokens(address token) external view returns (uint32 version, address creator, uint256 presetId, address token_, string name, string symbol, uint256 maxSupply, uint256 saleAmount, uint256 raiseAmount, address quoteAsset, address vault, address curveModule, address tradeModule, address migrateModule, address tokenModule, address customData, uint256 createBlock, bool exists, bool paused, bool antiSniperEnabled)",
  "function sell(address token, uint256 amount, uint256 minQuoteReceive, uint256 options, bytes calldata proof) external",
]);

const OPENFOUR_VAULT_ABI = parseAbi([
  "function totalRaised() external view returns (uint256)",
  "function remainingForSale() external view returns (uint256)",
]);

const OPENFOUR_CURVE_ABI = parseAbi([
  "function evaluateReverse(address token, bool isBuy, uint256 quoteBudget, uint256 remainingForSale, uint256 totalRaised, uint256 timestamp) external view returns (uint256 tokenAmount, uint256 curveQuote)",
]);

const OPEN_FOUR_CORE = INNER_MARKET_CONTRACTS.FOURMEME_OPENFOUR_CORE;

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const FLAP_PORTAL_ABI = parseAbi([
  "function swapExactInput((address inputToken, address outputToken, uint256 inputAmount, uint256 minOutputAmount, bytes permitData)) payable returns (uint256 outputAmount)",
]);

// ── 自动卖出引擎 ──

export class AutoSellEngine {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(private readonly config: AutoSellConfig) {}

  /**
   * 启动后台监控。
   */
  start(): void {
    if (this.intervalId) return;
    if (!this.config.enabled) {
      console.log("[AutoSell] 未启用，跳过");
      return;
    }

    console.log(
      `[AutoSell] 启动: 涨${this.config.takeProfitPercent}%出本(${this.config.takeProfitRatio * 100}%), 跌${this.config.stopLossPercent}%止损, 间隔${this.config.checkIntervalMs / 1000}s`,
    );

    this.intervalId = setInterval(() => {
      void this.checkAndSell();
    }, this.config.checkIntervalMs);
  }

  /**
   * 停止监控。
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * 检查所有活跃持仓并执行卖出。
   */
  private async checkAndSell(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const positions = positionTracker.getActivePositions();
      if (positions.length === 0) return;

      for (const position of positions) {
        await this.checkPosition(position);
      }
    } catch (error) {
      console.error("[AutoSell] 检查失败:", error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 检查单个持仓。
   */
  private async checkPosition(position: Position): Promise<void> {
    try {
      const currentPrice = await this.getCurrentPrice(position);
      if (currentPrice <= 0n) return;

      const entryPrice = position.entryPrice;
      const profitPercent = Number((currentPrice - entryPrice) * 10000n / entryPrice) / 100;

      console.log(
        `[AutoSell] ${position.tokenAddress.slice(0, 10)}... 当前涨幅: ${profitPercent.toFixed(1)}% (入场: ${entryPrice}, 现价: ${currentPrice})`,
      );

      // 止盈：涨 100% → 卖 50%
      if (profitPercent >= this.config.takeProfitPercent) {
        const sellAmount = position.remainingAmount / 2n;
        await this.executeTakeProfit(position, sellAmount, currentPrice);
        return;
      }

      // 止损：跌 50% → 全卖
      if (profitPercent <= -this.config.stopLossPercent) {
        await this.executeStopLoss(position, position.remainingAmount, currentPrice);
        return;
      }
    } catch (error) {
      console.error(`[AutoSell] 检查持仓 ${position.id} 失败:`, error);
    }
  }

  /**
   * 获取当前价格。
   */
  private async getCurrentPrice(position: Position): Promise<bigint> {
    const { publicClient } = getBscClients();

    switch (position.platform) {
      case "fourmeme":
        return this.getFourMemePrice(publicClient, position.tokenAddress);
      case "flap":
        return this.getFlapPrice(publicClient, position.tokenAddress);
      case "okx_dex":
        return this.getOkxPrice(position.tokenAddress, position.remainingAmount);
      default:
        return 0n;
    }
  }

  private async getFourMemePrice(
    publicClient: BscClients["publicClient"],
    tokenAddress: string,
  ): Promise<bigint> {
    // 用 1 个代币的价格作为基准
    const oneToken = 10n ** 18n;

    // 先尝试旧版 Helper
    try {
      const result = await publicClient.readContract({
        address: INNER_MARKET_CONTRACTS.FOURMEME_HELPER as `0x${string}`,
        abi: FOURMEME_HELPER_ABI,
        functionName: "trySell",
        args: [tokenAddress as `0x${string}`, oneToken],
      });
      // result is a tuple: [tokenManager, quote, estimatedAmount, ...]
      const estimatedAmount = (result as readonly [`0x${string}`, `0x${string}`, bigint, bigint, bigint, bigint, bigint, bigint])[2];
      if (estimatedAmount > 0n) return estimatedAmount;
    } catch {
      // 旧版失败 → 继续尝试 OpenFour
    }

    // 新版 OpenFour：用 1 个代币作为 quoteBudget 的反向计算近似价格
    try {
      const info = (await publicClient.readContract({
        address: OPEN_FOUR_CORE,
        abi: OPENFOUR_CORE_ABI,
        functionName: "tokens",
        args: [tokenAddress as `0x${string}`],
      })) as unknown as any[];

      const vault = info[10] as `0x${string}`;
      const curveModule = info[11] as `0x${string}`;

      const [totalRaised, remainingForSale] = await Promise.all([
        publicClient.readContract({ address: vault, abi: OPENFOUR_VAULT_ABI, functionName: "totalRaised" }),
        publicClient.readContract({ address: vault, abi: OPENFOUR_VAULT_ABI, functionName: "remainingForSale" }),
      ]);

      const now = BigInt(Math.floor(Date.now() / 1000));
      const reverse = await publicClient.readContract({
        address: curveModule,
        abi: OPENFOUR_CURVE_ABI,
        functionName: "evaluateReverse",
        args: [tokenAddress as `0x${string}`, false, oneToken, remainingForSale, totalRaised, now],
      });

      return reverse[1]; // curveQuote 即 BNB 价格
    } catch {
      return 0n;
    }
  }

  private async getFlapPrice(
    publicClient: BscClients["publicClient"],
    tokenAddress: string,
  ): Promise<bigint> {
    const oneToken = 10n ** 18n;
    const { account } = getBscClients();
    try {
      // 用 swapExactInput eth_call（卖出 1 个代币，minOutput=0）获取预估 BNB
      const data = encodeFunctionData({
        abi: FLAP_PORTAL_ABI,
        functionName: "swapExactInput",
        args: [{
          inputToken: tokenAddress as `0x${string}`,
          outputToken: "0x0000000000000000000000000000000000000000" as `0x${string}`,
          inputAmount: oneToken,
          minOutputAmount: 0n,
          permitData: "0x" as Hex,
        }],
      });
      const result = await publicClient.call({
        to: INNER_MARKET_CONTRACTS.FLAP_PORTAL as `0x${string}`,
        data,
        account: account.address,
      });
      if (!result.data) return 0n;
      const [bnbOut] = decodeAbiParameters([{ type: "uint256" }], result.data as Hex);
      return bnbOut;
    } catch {
      return 0n;
    }
  }

  private async getOkxPrice(
    tokenAddress: string,
    remainingAmount: bigint,
  ): Promise<bigint> {
    // 用 OKX 报价：卖出当前持仓，预估能拿到多少 BNB（wei）
    // 以此作为当前估值，与 entryPrice 比较涨跌幅
    try {
      const credentials = getOkxCredentials();
      const okxClient = new OkxClient(credentials);
      const walletAddress = process.env.EVM_WALLET_ADDRESS || "";
      const result = await okxClient.getSwap({
        chainIndex: CHAINS.bsc.chainIndex,
        fromTokenAddress: tokenAddress,
        toTokenAddress: CHAINS.bsc.nativeTokenAddress,
        amount: remainingAmount.toString(),
        userWalletAddress: walletAddress,
        slippagePercent: "5",
      });
      // toTokenAmount 是能换到的 BNB wei 字符串
      return BigInt(result.swap.routerResult.toTokenAmount);
    } catch {
      return 0n;
    }
  }

  private async buildOkxSell(
    publicClient: BscClients["publicClient"],
    tokenAddress: string,
    amount: bigint,
    slippagePercent: string,
  ): Promise<{ to: string; data: Hex; value: bigint; spender: string }> {
    const credentials = getOkxCredentials();
    const okxClient = new OkxClient(credentials);
    const walletAddress = process.env.EVM_WALLET_ADDRESS || "";
    const result = await okxClient.getSwap({
      chainIndex: CHAINS.bsc.chainIndex,
      fromTokenAddress: tokenAddress,
      toTokenAddress: CHAINS.bsc.nativeTokenAddress,
      amount: amount.toString(),
      userWalletAddress: walletAddress,
      slippagePercent,
    });
    const tx = result.swap.tx;

    return {
      to: tx.to,
      data: tx.data as Hex,
      value: BigInt(tx.value || "0"),
      // OKX 卖出需要 approve 给 router 合约（tx.to）
      spender: tx.to,
    };
  }

  /**
   * 执行止盈（卖出 50%）。
   */
  private async executeTakeProfit(
    position: Position,
    amount: bigint,
    currentPrice: bigint,
  ): Promise<void> {
    console.log(
      `[AutoSell] 🎯 止盈触发! ${position.tokenAddress.slice(0, 10)}... 卖出 50%`,
    );

    const txHash = await this.executeSell(position, amount);
    if (txHash) {
      positionTracker.recordTakeProfit(position.id, txHash, amount, currentPrice);
      console.log(`[AutoSell] ✅ 止盈成功: ${txHash}`);
    }
  }

  /**
   * 执行止损（全部卖出）。
   */
  private async executeStopLoss(
    position: Position,
    amount: bigint,
    currentPrice: bigint,
  ): Promise<void> {
    console.log(
      `[AutoSell] 🛑 止损触发! ${position.tokenAddress.slice(0, 10)}... 全部卖出`,
    );

    const txHash = await this.executeSell(position, amount);
    if (txHash) {
      positionTracker.recordStopLoss(position.id, txHash, amount, currentPrice);
      console.log(`[AutoSell] ✅ 止损成功: ${txHash}`);
    }
  }

  /**
   * 执行卖出交易。
   */
  private async executeSell(position: Position, amount: bigint): Promise<string | null> {
    const { account, publicClient, walletClient } = getBscClients();

    try {
      // 0. 卖前检查：链上实际余额是否足够，避免手动卖出后继续尝试浪费 gas
      const balance = await publicClient.readContract({
        address: position.tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      const isActive = positionTracker.syncBalance(position.id, balance);
      if (!isActive) {
        console.log(`[AutoSell] 链上余额为 0，已手动卖出或转出，关闭持仓 ${position.id.slice(0, 12)}`);
        return null;
      }
      const sellAmount = balance < amount ? balance : amount;
      if (sellAmount < amount) {
        console.log(`[AutoSell] 链上余额不足，调整卖出数量 ${amount.toString()} → ${sellAmount.toString()}，持仓 ${position.id.slice(0, 12)}`);
      }

      // 2. 构建卖出交易
      let txData: Hex;
      let txTo: string;
      let txValue: bigint;
      let approveSpender: string | undefined;

      switch (position.platform) {
        case "fourmeme": {
          const sellTx = await this.buildFourMemeSell(position.tokenAddress, sellAmount);
          txData = sellTx.data;
          txTo = sellTx.to;
          txValue = sellTx.value;
          approveSpender = sellTx.spender;
          break;
        }
        case "flap": {
          const sellTx = await this.buildFlapSell(position.tokenAddress, sellAmount);
          txData = sellTx.data;
          txTo = sellTx.to;
          txValue = sellTx.value;
          approveSpender = INNER_MARKET_CONTRACTS.FLAP_PORTAL;
          break;
        }
        case "okx_dex": {
          const sellTx = await this.buildOkxSell(publicClient, position.tokenAddress, sellAmount, this.config.slippagePercent);
          txData = sellTx.data;
          txTo = sellTx.to;
          txValue = sellTx.value;
          approveSpender = sellTx.spender;
          break;
        }
        default:
          console.error("[AutoSell] 不支持的平台:", position.platform);
          return null;
      }

      // 1. 先 approve（用实际 spender）
      if (approveSpender) {
        await this.approveIfNeeded(position.tokenAddress, sellAmount, account.address, approveSpender);
      }

      // 3. 动态 gasPrice + estimateGas
      const MIN_GAS_PRICE = parseGwei("1");
      const networkGasPrice = await publicClient.getGasPrice();
      const gasPrice = networkGasPrice > MIN_GAS_PRICE ? networkGasPrice : MIN_GAS_PRICE;
      const estimated = await publicClient.estimateGas({
        account: account.address,
        to: txTo as Hex,
        data: txData,
        value: txValue,
      });
      const gasLimit = (estimated * 120n) / 100n;

      // 4. 签名广播
      const request = await walletClient.prepareTransactionRequest({
        account,
        to: txTo as Hex,
        data: txData,
        value: txValue,
        gas: gasLimit,
        gasPrice,
        type: "legacy",
      });
      const signed = await walletClient.signTransaction(request);
      const txHash = await publicClient.sendRawTransaction({
        serializedTransaction: signed,
      });

      return txHash;
    } catch (error) {
      console.error("[AutoSell] 卖出失败:", error);
      return null;
    }
  }

  /**
   * 检查 allowance，不足时发 approve。
   */
  private async approveIfNeeded(
    tokenAddress: string,
    amount: bigint,
    ownerAddress: string,
    spender: string,
  ): Promise<void> {
    const { account, publicClient, walletClient } = getBscClients();

    // 检查当前 allowance（不是 balanceOf）
    const allowance = await publicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [ownerAddress as `0x${string}`, spender as `0x${string}`],
    });

    if (allowance >= amount) return; // 已有足够授权

    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender as `0x${string}`, maxUint256], // 一次 approve 最大额度，避免重复授权
    });

    const MIN_GAS_PRICE = parseGwei("1");
    const networkGasPrice = await publicClient.getGasPrice();
    const gasPrice = networkGasPrice > MIN_GAS_PRICE ? networkGasPrice : MIN_GAS_PRICE;

    const request = await walletClient.prepareTransactionRequest({
      account,
      to: tokenAddress as Hex,
      data,
      value: 0n,
      gas: 100000n,
      gasPrice,
      type: "legacy",
    });
    const signed = await walletClient.signTransaction(request);
    await publicClient.sendRawTransaction({ serializedTransaction: signed });

    // 等待确认
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  /**
   * 构建 Four.meme 卖出交易（自动识别旧版 TokenManager / 新版 OpenFour）。
   */
  private async buildFourMemeSell(
    tokenAddress: string,
    amount: bigint,
  ): Promise<{ to: string; data: Hex; value: bigint; spender: string }> {
    const { publicClient } = getBscClients();

    // 先尝试旧版 Helper
    try {
      const result = await publicClient.readContract({
        address: INNER_MARKET_CONTRACTS.FOURMEME_HELPER as `0x${string}`,
        abi: FOURMEME_HELPER_ABI,
        functionName: "trySell",
        args: [tokenAddress as `0x${string}`, amount],
      });
      // result is a tuple: [tokenManager, quote, estimatedAmount, estimatedCost, estimatedFee, amountMsgValue, ...]
      type TrySellResult = readonly [`0x${string}`, `0x${string}`, bigint, bigint, bigint, bigint, bigint, bigint];
      const tokenManager = (result as TrySellResult)[0];
      const amountMsgValue = (result as TrySellResult)[5];

      if (tokenManager !== "0x0000000000000000000000000000000000000000") {
        // 滑点保护
        const slippage = Number(this.config.slippagePercent);
        const estimatedBnb = amountMsgValue;
        const minFunds = (estimatedBnb * BigInt(Math.floor((100 - slippage) * 100))) / 10000n;

        const data = encodeFunctionData({
          abi: FOURMEME_MANAGER_ABI,
          functionName: "sellToken",
          args: [tokenAddress as `0x${string}`, amount, minFunds],
        });

        return { to: tokenManager, data, value: amountMsgValue, spender: tokenManager };
      }
    } catch {
      // 旧版失败 → 尝试 OpenFour
    }

    // 新版 OpenFour 卖出
    const info = (await publicClient.readContract({
      address: OPEN_FOUR_CORE,
      abi: OPENFOUR_CORE_ABI,
      functionName: "tokens",
      args: [tokenAddress as `0x${string}`],
    })) as unknown as any[];

    const vault = info[10] as `0x${string}`;
    const curveModule = info[11] as `0x${string}`;

    const [totalRaised, remainingForSale] = await Promise.all([
      publicClient.readContract({ address: vault, abi: OPENFOUR_VAULT_ABI, functionName: "totalRaised" }),
      publicClient.readContract({ address: vault, abi: OPENFOUR_VAULT_ABI, functionName: "remainingForSale" }),
    ]);

    const now = BigInt(Math.floor(Date.now() / 1000));
    const reverse = await publicClient.readContract({
      address: curveModule,
      abi: OPENFOUR_CURVE_ABI,
      functionName: "evaluateReverse",
      args: [tokenAddress as `0x${string}`, false, amount, remainingForSale, totalRaised, now],
    });

    const curveQuote = reverse[1];
    const slippage = Number(this.config.slippagePercent);
    const minQuoteReceive = (curveQuote * BigInt(Math.floor((100 - slippage) * 100))) / 10000n;

    const data = encodeFunctionData({
      abi: OPENFOUR_CORE_ABI,
      functionName: "sell",
      args: [tokenAddress as `0x${string}`, amount, minQuoteReceive, 0n, "0x"],
    });

    return { to: OPEN_FOUR_CORE, data, value: 0n, spender: OPEN_FOUR_CORE };
  }

  /**
   * 构建 Flap.sh 卖出交易。
   */
  private async buildFlapSell(
    tokenAddress: string,
    amount: bigint,
  ): Promise<{ to: string; data: Hex; value: bigint }> {
    const { publicClient, account } = getBscClients();

    // 用 swapExactInput eth_call（minOutput=0）预估能拿到多少 BNB
    const quoteData = encodeFunctionData({
      abi: FLAP_PORTAL_ABI,
      functionName: "swapExactInput",
      args: [{
        inputToken: tokenAddress as `0x${string}`,
        outputToken: "0x0000000000000000000000000000000000000000" as `0x${string}`,
        inputAmount: amount,
        minOutputAmount: 0n,
        permitData: "0x" as Hex,
      }],
    });
    const quoteResult = await publicClient.call({
      to: INNER_MARKET_CONTRACTS.FLAP_PORTAL as `0x${string}`,
      data: quoteData,
      account: account.address,
    });
    const estimatedBnb = quoteResult.data
      ? decodeAbiParameters([{ type: "uint256" }], quoteResult.data as Hex)[0]
      : 0n;

    // 滑点保护
    const slippage = Number(this.config.slippagePercent);
    const minOutputAmount = (estimatedBnb * BigInt(Math.floor((100 - slippage) * 100))) / 10000n;

    const data = encodeFunctionData({
      abi: FLAP_PORTAL_ABI,
      functionName: "swapExactInput",
      args: [{
        inputToken: tokenAddress as `0x${string}`,
        outputToken: "0x0000000000000000000000000000000000000000" as `0x${string}`,
        inputAmount: amount,
        minOutputAmount,
        permitData: "0x" as Hex,
      }],
    });

    return { to: INNER_MARKET_CONTRACTS.FLAP_PORTAL, data, value: 0n };
  }
}

// ── 配置解析 ──

export function getAutoSellConfig(): AutoSellConfig {
  return {
    enabled: process.env.AUTO_SELL_ENABLED === "true",
    takeProfitPercent: Number(process.env.AUTO_SELL_TAKE_PROFIT_PERCENT || "100"),
    takeProfitRatio: Number(process.env.AUTO_SELL_TAKE_PROFIT_RATIO || "0.5"),
    stopLossPercent: Number(process.env.AUTO_SELL_STOP_LOSS_PERCENT || "50"),
    checkIntervalMs: Number(process.env.AUTO_SELL_CHECK_INTERVAL_MS || "5000"),
    slippagePercent: runtimeConfig.getSellSlippagePercent(),
  };
}
