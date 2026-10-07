/**
 * Dashboard reactive store using Vue's built-in reactivity.
 * No Pinia needed -- just reactive() + computed().
 */
import { reactive, computed } from 'vue'
import { inferChain } from '../composables/useChain.js'
import { api } from '../api/index.js'

const MAX_LOG_ENTRIES = 200

const state = reactive({
  data: null,           // full SSE state snapshot
  activeTab: 'overview',
  activeChain: 'bsc',
  connection: 'connecting',  // connecting | online | offline
  logs: [],
  logFilter: '',
  logErrorCount: 0,
  toast: '',
  toastVisible: false,
  notifiedTriggerIds: new Set(),
  unreadTriggerCount: 0,
  sirenEnabled: false,
})

// ── Computed filters ──

export const filteredSignals = computed(() =>
  (state.data?.recentSignals || []).filter((s) => s.chain === state.activeChain)
)

export const filteredTriggers = computed(() =>
  (state.data?.triggers || []).filter((t) => t.chain === state.activeChain)
)

export const filteredPositions = computed(() =>
  (state.data?.positions || []).filter((p) => inferChain(p) === state.activeChain)
)

export const isLive = computed(() => state.data?.mode === 'LIVE')

export const chainConfig = computed(() => {
  const d = state.data
  if (!d) return { threshold: 0, windowSeconds: 0, isLive: false }
  const isRob = state.activeChain === 'rob'
  const robCfg = d.robConfig
  return {
    threshold: isRob && robCfg ? robCfg.threshold : (d.config?.threshold || 0),
    windowSeconds: isRob && robCfg ? robCfg.windowSeconds : (d.config?.windowSeconds || 0),
    isLive: isRob ? Boolean(robCfg?.transactionBroadcast) : isLive.value,
  }
})

export const filteredLogs = computed(() =>
  state.logFilter ? state.logs.filter((e) => e.level === state.logFilter) : state.logs
)

export const logsLength = computed(() => state.logs.length)

export const errorEventCount = computed(() =>
  state.logs.filter((e) => e.level === 'error' || e.level === 'warn').length
)

export const activePosCount = computed(() =>
  filteredPositions.value.filter((p) => p.status === 'active').length
)

// ── Toast ──

let toastTimer = null
export function showToast(message) {
  state.toast = message
  state.toastVisible = true
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { state.toastVisible = false }, 1400)
}

// ── SSE connections ──

export function connectSSE() {
  state.connection = 'connecting'
  const events = new EventSource('/events')
  events.addEventListener('open', () => { state.connection = 'online' })
  events.addEventListener('state', (event) => {
    state.connection = 'online'
    const newData = JSON.parse(event.data)
    checkNewTriggers(newData)
    state.data = newData
  })
  events.addEventListener('error', () => { state.connection = 'offline' })
}

export function connectLogSSE() {
  const logStream = new EventSource('/log-events')
  logStream.addEventListener('log', (event) => {
    const entry = JSON.parse(event.data)
    state.logs.push(entry)
    if (state.logs.length > MAX_LOG_ENTRIES) state.logs.shift()
    if (entry.level === 'error') state.logErrorCount += 1
  })
  logStream.addEventListener('error', () => {
    setTimeout(async () => {
      try {
        state.logs = await api.getLogs()
        state.logErrorCount = state.logs.filter((e) => e.level === 'error').length
      } catch { /* ignore */ }
    }, 2000)
  })
}

// ── Trigger notifications ──

let sirenHowl = null

function checkNewTriggers(newData) {
  const triggers = newData?.triggers || []
  for (const trigger of triggers) {
    if (state.notifiedTriggerIds.has(trigger.id)) continue
    state.notifiedTriggerIds.add(trigger.id)
    if (state.sirenEnabled && sirenHowl) {
      sirenHowl.stop()
      sirenHowl.play()
    }
    if (state.activeTab !== 'signals') {
      state.unreadTriggerCount += 1
    }
    // Desktop notification
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      try {
        new Notification('Resonance 触发', {
          body: `${trigger.wallets?.length || '?'} 钱包共振 · ${trigger.tokenAddress?.slice(0, 10)}...`,
          tag: trigger.id,
        })
      } catch { /* ignore */ }
    }
  }
  // Cap set size
  if (state.notifiedTriggerIds.size > 200) {
    const iter = state.notifiedTriggerIds.values()
    for (let i = 0; i < 50; i++) {
      const v = iter.next().value
      if (v) state.notifiedTriggerIds.delete(v)
    }
  }
}

export function markTriggersRead() {
  state.unreadTriggerCount = 0
}

// ── Actions ──

export function switchChain(chain) {
  state.activeChain = chain
}

export function switchTab(tab) {
  state.activeTab = tab
  if (tab === 'signals') markTriggersRead()
}

export function setLogFilter(filter) {
  state.logFilter = filter
}

export function clearLogs() {
  state.logs = []
  state.logErrorCount = 0
  showToast('日志已清空')
}

export async function loadState() {
  const data = await api.getState()
  for (const trigger of data.triggers || []) {
    state.notifiedTriggerIds.add(trigger.id)
  }
  state.data = data
}

export function initAlerts() {
  state.sirenEnabled = localStorage.getItem('resonanceNotifyEnabled') === 'true'
  if (typeof Howl === 'function') {
    sirenHowl = new Howl({
      src: ['/siren.mp3?v=2', '/siren.wav?v=2'],
      volume: 1.0,
      html5: true,
      onloaderror: () => {},
    })
  }
}

export function toggleAlerts() {
  state.sirenEnabled = !state.sirenEnabled
  localStorage.setItem('resonanceNotifyEnabled', String(state.sirenEnabled))
  showToast(state.sirenEnabled ? '共振通知已开启' : '共振通知已关闭')
  if (state.sirenEnabled && !('Notification' in window)) {
    showToast('浏览器不支持通知')
  } else if (state.sirenEnabled && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

export default state
