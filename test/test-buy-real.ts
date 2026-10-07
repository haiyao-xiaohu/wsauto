import { buildBscSwapUnified } from '../src/bsc-swap-builder.js';
import { broadcastSwap } from '../src/broadcast.js';

const TOKEN = (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })());
const WALLET = process.env.EVM_WALLET_ADDRESS || '';
const AMOUNT = '0.0017';

console.log('🎯 测试买入代币:', TOKEN);
console.log('💼 钱包:', WALLET);
console.log('💰 金额:', AMOUNT, 'BNB');

try {
  const result = await buildBscSwapUnified({
    tokenAddress: TOKEN,
    amount: AMOUNT,
    slippagePercent: '30',
    walletAddress: WALLET,
    options: { buildTx: true },
  });

  console.log('\n📊 路由结果:');
  console.log('  路由:', result.route);
  console.log('  平台:', result.tokenMarket.platform);
  console.log('  状态:', result.tokenMarket.status);
  console.log('  进度:', result.tokenMarket.progress + '%');
  console.log('  原因:', result.reason);

  if (result.flapQuote) {
    const tokens = (BigInt(result.flapQuote.estimatedOutput) / BigInt(1e18)).toLocaleString();
    const costBnb = (Number(BigInt(result.flapQuote.inputAmount)) / 1e18).toFixed(6);
    console.log(`  预估获得: ${tokens} 代币`);
    console.log(`  实际花费: ${costBnb} BNB`);
  }

  if (result.fourmemeQuote) {
    const { estimatedAmount, amountMsgValue } = result.fourmemeQuote;
    const tokens = (BigInt(estimatedAmount) / BigInt(1e18)).toLocaleString();
    const bnbCost = (Number(BigInt(amountMsgValue)) / 1e18).toFixed(6);
    console.log(`  预估获得: ${tokens} 代币`);
    console.log(`  实际花费: ${bnbCost} BNB`);
  }

  console.log('\n📡 广播交易...');
  const tx = await broadcastSwap(result);
  console.log('✅ 成功!');
  console.log('  TxHash:', tx.txHash);
  console.log('  BSCScan: https://bscscan.com/tx/' + tx.txHash);
} catch (e) {
  console.error('❌ 失败:', e instanceof Error ? e.message : String(e));
}
