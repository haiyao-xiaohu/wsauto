import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';
import { detectTokenMarket } from '../src/inner-market-detector.js';

const rpc = process.env.BSC_RPC_URL?.split(',')[0] || 'https://bsc-rpc.publicnode.com';
const client = createPublicClient({ chain: bsc, transport: http(rpc) });
const token = (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })());

const result = await detectTokenMarket(client, token);
console.log(JSON.stringify(result, null, 2));
