/**
 * Formatting utilities extracted from dashboard.js
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function shortAddress(value, left = 6, right = 4) {
  if (!value || value.length <= left + right) return value || '—'
  return `${value.slice(0, left)}…${value.slice(-right)}`
}

export function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(Number(value || 0))
}

export function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = String(Math.floor(seconds / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
  const remaining = String(seconds % 60).padStart(2, '0')
  return `${hours}:${minutes}:${remaining}`
}

export function timeAgo(timestampMs) {
  if (!timestampMs) return '等待中'
  const seconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000))
  if (seconds < 3) return '刚刚'
  if (seconds < 60) return `${seconds}s 前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m 前`
  return `${Math.floor(minutes / 60)}h 前`
}

export function localTime(timestampMs) {
  if (!timestampMs) return '—'
  return new Date(timestampMs).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

// ── Route labels ──

export const routeLabels = {
  fourmeme_inner: 'Four.meme 内盘',
  flap_inner: 'Flap.sh 内盘',
  okx_dex: 'OKX DEX',
  flap_rob: 'Flap.sh ROB',
  uniswap_v3: 'Uniswap V3',
  dry_run: 'DRY RUN',
}

export const routeEmoji = {
  fourmeme_inner: '4M',
  flap_inner: 'FL',
  okx_dex: 'OKX',
  flap_rob: 'FL',
  uniswap_v3: 'UNI',
  dry_run: 'DR',
}

// ── Decision labels ──

export const decisionLabels = {
  accepted: '观察中',
  triggered: '已共振',
  cooldown: '冷却中',
  duplicate: '已去重',
  not_watched: '已过滤',
  blacklisted: '已黑名单',
  excluded_combo: '排除组合',
  out_of_order_stale: '乱序过期',
  stale: '到达过期',
}

// ── Trigger status labels ──

export const triggerStatusLabels = {
  detected: '共振确认',
  building: '路由构建中',
  built: '路由成功',
  broadcasting: '广播中',
  broadcasted: '已上链',
  rejected: '拒绝',
}

// ── Log level labels ──

export const logLevelLabels = {
  info: '信息',
  warn: '警告',
  error: '错误',
  success: '成功',
}

export const logEventLabels = {
  errorEventCount: '错误事件',
  RESONANCE_TRIGGER: '共振触发',
  SWAP_BUILT: '路由构建',
  TX_BROADCAST: '交易广播',
  POSITION_ADDED: '买入成功',
  TX_REVERTED: '交易回滚',
  BROADCAST_FAILED: '广播失败',
  SWAP_REJECTED: '路由失败',
}

// ── Position status labels ──

export const positionStatusLabels = {
  active: '监控中',
  take_profit_done: '已止盈',
  stop_loss_done: '已止损',
  sold: '已清仓',
}
