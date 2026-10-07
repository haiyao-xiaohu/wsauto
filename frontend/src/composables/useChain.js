/**
 * Chain helpers for multi-chain filtering and display
 */

export function inferChain(item) {
  if (item.chain) return item.chain
  if (item.platform === 'flap_rob' || item.platform === 'uniswap_v3') return 'rob'
  return 'bsc'
}

export function chainCurrency(chain) {
  return chain === 'rob' ? 'ETH' : 'BNB'
}

export function chainExplorerBase(chain, type) {
  if (chain === 'rob') {
    return type === 'token'
      ? 'https://robinhoodchain.blockscout.com/token'
      : 'https://robinhoodchain.blockscout.com/tx'
  }
  return type === 'token'
    ? 'https://bscscan.com/token'
    : 'https://bscscan.com/tx'
}
