/**
 * 代币诊断脚本
 * 用法: node test/diagnose-token.mjs <TOKEN_ADDRESS>
 */
import { createPublicClient, http, decodeAbiParameters } from "viem";
import { bsc } from "viem/chains";
import { config } from "dotenv";

config();

const TOKEN = process.argv[2] || (process.env.TOKEN_ADDRESS?.trim() || (() => { throw new Error("请配置 TOKEN_ADDRESS 或传入目标代币地址"); })());
const RPC = process.env.BSC_RPC_URL;

if (!RPC) {
  console.error("BSC_RPC_URL 未配置");
  process.exit(1);
}

const client = createPublicClient({ chain: bsc, transport: http(RPC) });

const FOURMEME_HELPER = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034";
const FLAP_PORTAL    = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";

const FOURMEME_HELPER_ABI = [
  {
    name: "getTokenInfo",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "version", type: "uint256" },
      { name: "tokenManager", type: "address" },
      { name: "quote", type: "address" },
      { name: "lastPrice", type: "uint256" },
      { name: "tradingFeeRate", type: "uint256" },
      { name: "minTradingFee", type: "uint256" },
      { name: "launchTime", type: "uint256" },
      { name: "offers", type: "uint256" },
      { name: "maxOffers", type: "uint256" },
      { name: "funds", type: "uint256" },
      { name: "maxFunds", type: "uint256" },
      { name: "liquidityAdded", type: "bool" },
    ],
  },
];

const FLAP_PORTAL_ABI = [
  {
    name: "getTokenV8",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "state",
        type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "reserve", type: "uint256" },
          { name: "circulatingSupply", type: "uint256" },
          { name: "price", type: "uint256" },
          { name: "tokenVersion", type: "uint8" },
          { name: "r", type: "uint256" },
          { name: "h", type: "uint256" },
          { name: "k", type: "uint256" },
          { name: "dexSupplyThresh", type: "uint256" },
          { name: "quoteTokenAddress", type: "address" },
          { name: "nativeToQuoteSwapEnabled", type: "bool" },
          { name: "extensionID", type: "bytes32" },
          { name: "buyTaxRate", type: "uint256" },
          { name: "sellTaxRate", type: "uint256" },
          { name: "pool", type: "address" },
          { name: "progress", type: "uint256" },
          {
            name: "lpFeeProfile",
            type: "tuple",
            components: [
              { name: "lpFee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
            ],
          },
          { name: "dexId", type: "uint8" },
        ],
      },
    ],
  },
];

async function main() {
  console.log(`\n====== 诊断代币: ${TOKEN} ======\n`);

  // 1. 基本信息
  console.log("── 1. 基本链上信息 ──");
  const [code, balance] = await Promise.all([
    client.getBytecode({ address: TOKEN }),
    client.getBalance({ address: TOKEN }),
  ]);
  console.log(`  合约代码长度: ${code ? code.length : 0} bytes (十六进制字符)`);
  console.log(`  合约余额: ${balance} wei`);

  // 尝试读 name/symbol/decimals
  const ERC20_ABI = [
    { name: "name",     type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { name: "symbol",   type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  ];
  for (const fn of ERC20_ABI) {
    try {
      const val = await client.readContract({ address: TOKEN, abi: [fn], functionName: fn.name, args: [] });
      console.log(`  ${fn.name}: ${val}`);
    } catch (e) {
      console.log(`  ${fn.name}: ❌ ${e.shortMessage || e.message}`);
    }
  }

  // 2. Four.meme 检测
  console.log("\n── 2. Four.meme getTokenInfo ──");
  try {
    const result = await client.readContract({
      address: FOURMEME_HELPER,
      abi: FOURMEME_HELPER_ABI,
      functionName: "getTokenInfo",
      args: [TOKEN],
    });
    const [version, tokenManager, quote, lastPrice, , , launchTime, offers, maxOffers, funds, maxFunds, liquidityAdded] = result;
    console.log(`  version: ${version}`);
    console.log(`  tokenManager: ${tokenManager}`);
    console.log(`  quote: ${quote}`);
    console.log(`  lastPrice: ${lastPrice}`);
    console.log(`  launchTime: ${new Date(Number(launchTime) * 1000).toISOString()}`);
    console.log(`  offers/maxOffers: ${offers}/${maxOffers}`);
    console.log(`  funds: ${Number(funds)/1e18} BNB`);
    console.log(`  maxFunds: ${Number(maxFunds)/1e18} BNB`);
    console.log(`  liquidityAdded: ${liquidityAdded}`);

    if (tokenManager === "0x0000000000000000000000000000000000000000") {
      console.log(`  结论: ❌ 不在 Four.meme（tokenManager = zero address）`);
    } else {
      const progress = maxFunds > 0n ? Number((funds * 10000n) / maxFunds) / 100 : 0;
      const status = liquidityAdded ? "graduated" : "inner_market";
      console.log(`  结论: ✅ Four.meme 代币，状态=${status}，进度=${progress.toFixed(1)}%`);
    }
  } catch (e) {
    console.log(`  ❌ 调用失败: ${e.shortMessage || e.message}`);
  }

  // 3. Flap.sh 检测
  console.log("\n── 3. Flap.sh getTokenV8 ──");
  try {
    const result = await client.readContract({
      address: FLAP_PORTAL,
      abi: FLAP_PORTAL_ABI,
      functionName: "getTokenV8",
      args: [TOKEN],
    });
    const state = result;
    const FLAP_STATUS = { 0:"Invalid", 1:"Tradable", 2:"InDuel", 3:"Killed", 4:"DEX", 5:"Staged" };
    console.log(`  status: ${state.status} (${FLAP_STATUS[state.status] || "?"} )`);
    console.log(`  reserve: ${Number(state.reserve)/1e18} BNB`);
    console.log(`  price: ${Number(state.price)/1e18}`);
    console.log(`  progress: ${Number(state.progress)/1e16}%`);
    console.log(`  pool: ${state.pool}`);

    if (state.status === 0) {
      console.log(`  结论: ❌ 不在 Flap.sh（status=0 Invalid）`);
    } else {
      console.log(`  结论: ✅ Flap.sh 代币，状态=${FLAP_STATUS[state.status]}`);
    }
  } catch (e) {
    console.log(`  ❌ 调用失败: ${e.shortMessage || e.message}`);
  }

  // 4. 查最近创建代币的交易 (看看是哪个合约部署的)
  console.log("\n── 4. 查创建者 (eth_getTransactionByHash 方式查创建tx) ──");
  try {
    // 通过 debug_traceBlockByNumber 或 txpool 查不到，但可以查最近几个块内的 tx
    // 简单方式：直接查这个代币合约的 bytecode hash，判断是否是 Four.meme 代理合约
    const codeHex = code ? code : "0x";
    console.log(`  bytecode 前 20 bytes: ${codeHex.slice(0, 42)}`);
    console.log(`  bytecode 总长度: ${(codeHex.length - 2) / 2} bytes`);

    // Four.meme 代理合约通常是 EIP-1967 proxy，bytecode 很短
    if ((codeHex.length - 2) / 2 < 100) {
      console.log(`  ⚠️  bytecode 极短，可能是最小代理（EIP-1167 clone）`);
    }
  } catch (e) {
    console.log(`  ❌ ${e.message}`);
  }

  // 5. 查 Four.meme V3 Helper 合约本身是否有效
  console.log("\n── 5. 验证 Four.meme Helper 合约地址 ──");
  try {
    const helperCode = await client.getBytecode({ address: FOURMEME_HELPER });
    console.log(`  Helper ${FOURMEME_HELPER} 代码长度: ${helperCode ? (helperCode.length-2)/2 : 0} bytes`);
    const flapCode = await client.getBytecode({ address: FLAP_PORTAL });
    console.log(`  Flap Portal ${FLAP_PORTAL} 代码长度: ${flapCode ? (flapCode.length-2)/2 : 0} bytes`);
  } catch (e) {
    console.log(`  ❌ ${e.message}`);
  }

  // 6. 尝试查 Four.meme 最新 Manager 合约（看是否有新版本）
  console.log("\n── 6. 查 Four.meme Manager V2 是否认识这个代币 ──");
  const MANAGER_V2 = "0x5c952063c7fc8610FFDB798152D69F0B9550762b";
  const MANAGER_V2_ABI = [
    {
      name: "tokenInfoOf",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "token", type: "address" }],
      outputs: [
        { name: "quote", type: "address" },
        { name: "lastPrice", type: "uint256" },
        { name: "tradingFeeRate", type: "uint256" },
        { name: "minTradingFee", type: "uint256" },
        { name: "launchTime", type: "uint256" },
        { name: "offers", type: "uint256" },
        { name: "maxOffers", type: "uint256" },
        { name: "funds", type: "uint256" },
        { name: "maxFunds", type: "uint256" },
        { name: "liquidityAdded", type: "bool" },
      ],
    },
  ];
  try {
    const r = await client.readContract({ address: MANAGER_V2, abi: MANAGER_V2_ABI, functionName: "tokenInfoOf", args: [TOKEN] });
    console.log(`  tokenInfoOf: ${JSON.stringify(r, (_, v) => typeof v === "bigint" ? v.toString() : v)}`);
  } catch (e) {
    console.log(`  tokenInfoOf 失败: ${e.shortMessage || e.message}`);
  }

  console.log("\n====== 诊断完成 ======\n");
}

main().catch(console.error);
