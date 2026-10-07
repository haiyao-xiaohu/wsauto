/**
 * REST API wrappers for all backend endpoints
 */

function settingsApi(method, path, body) {
  const opts = { method, headers: { 'content-type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  return fetch(`/api/settings/${path}`, opts).then(async (res) => {
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  })
}

export const api = {
  // ── State ──
  getState: () => fetch('/api/state', { cache: 'no-store' }).then((r) => r.json()),
  getSettings: () => fetch('/api/settings').then((r) => r.json()),
  getLogs: () => fetch('/api/logs').then((r) => r.json()),
  getCombos: () => fetch('/api/analysis/combos').then((r) => r.json()),
  testTrigger: () => fetch('/api/test/trigger').then((r) => r.json()),
  health: () => fetch('/health').then((r) => r.json()),

  // ── Wallets ──
  addWallets: (wallets) => settingsApi('POST', 'wallets', { wallets }),
  replaceWallets: (wallets) => settingsApi('PUT', 'wallets', { wallets }),
  downloadWallets: () => '/api/settings/wallets.txt',
  downloadBlacklist: () => '/api/settings/blacklist.txt',

  // ── Blacklist ──
  addBlacklist: (wallets) => settingsApi('POST', 'blacklist', { wallets }),
  replaceBlacklist: (wallets) => settingsApi('PUT', 'blacklist', { wallets }),

  // ── Order Amount ──
  saveOrderAmount: (amount) => settingsApi('PUT', 'order-amount', { amount }),

  // ── Executor ──
  saveExecutor: (privateKey) => settingsApi('PUT', 'executor', { privateKey }),

  // ── Excluded Combos ──
  getExcludedCombos: () => settingsApi('GET', 'excluded-combos'),
  addExcludedCombo: (walletA, walletB) => settingsApi('POST', 'excluded-combos', { walletA, walletB }),
  removeExcludedCombo: (walletA, walletB) => settingsApi('DELETE', 'excluded-combos', { walletA, walletB }),

  // ── Poison Wallets ──
  getPoisonWallets: () => settingsApi('GET', 'poison-wallets'),
  addPoisonWallet: (wallet) => settingsApi('POST', 'poison-wallets', { wallet }),
  removePoisonWallet: (wallet) => settingsApi('DELETE', 'poison-wallets', { wallet }),
  removeTokenBlacklist: (token) => settingsApi('DELETE', 'token-blacklist', { token }),

  // ── Dev Wallets ──
  getDevWallets: () => settingsApi('GET', 'dev-wallets'),
  addDevWallet: (wallet) => settingsApi('POST', 'dev-wallets', { wallet }),
  removeDevWallet: (wallet) => settingsApi('DELETE', 'dev-wallets', { wallet }),

  // ── Trading Config ──
  getTradingConfig: () => settingsApi('GET', 'trading'),
  saveTradingConfig: (body) => settingsApi('PUT', 'trading', body),

  // ── GMGN Orders ──
  getGmgnConfig: () => fetch('/api/gmgn/config').then(async (r) => {
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
    return data
  }),
  saveGmgnConfig: (config) => fetch('/api/gmgn/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  }).then(async (r) => {
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
    return data
  }),
  getGmgnOrders: (positionId) => fetch(`/api/gmgn/orders/${encodeURIComponent(positionId)}`).then(async (r) => {
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
    return data
  }),
  updateGmgnOrders: (positionId, body) => fetch(`/api/gmgn/orders/${encodeURIComponent(positionId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
    return data
  }),
  cancelGmgnOrder: (positionId, orderId) => fetch(`/api/gmgn/orders/${encodeURIComponent(positionId)}/${encodeURIComponent(orderId)}`, {
    method: 'DELETE',
  }).then(async (r) => {
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
    return data
  }),
}
