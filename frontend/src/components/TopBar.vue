<template>
  <header class="topbar">
    <a class="brand" href="/">
      <span class="brand-mark">R</span>
      <span>
        <strong>RESONANCE</strong>
        <small>MULTI-CHAIN SIGNAL INTELLIGENCE</small>
      </span>
    </a>

    <nav class="tab-nav">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="tab-button"
        :class="{ 'is-active': store.activeTab === tab.id }"
        @click="switchTab(tab.id)"
      >
        {{ tab.label }}
        <span v-if="tab.badge" class="tab-badge" :class="tab.badgeClass">{{ tab.badge }}</span>
      </button>
    </nav>

    <div class="topbar-actions">
      <div class="chain-switcher">
        <button
          class="chain-btn" :class="{ 'is-active': store.activeChain === 'bsc' }"
          data-chain="bsc" @click="switchChain('bsc')"
        >BSC</button>
        <button
          class="chain-btn" :class="{ 'is-active': store.activeChain === 'rob' }"
          data-chain="rob" @click="switchChain('rob')"
        >ROB</button>
      </div>

      <button class="notify-button" @click="toggleAlerts" :class="{ 'is-enabled': store.sirenEnabled }">
        <span>{{ store.sirenEnabled ? '🔔' : '🔕' }}</span>
        <span>{{ store.sirenEnabled ? '已开启' : '通知' }}</span>
      </button>

      <div class="mode-pill" :class="chainConfig.isLive ? 'is-live' : 'is-dry'">
        <span class="mode-dot"></span>
        <span>{{ chainConfig.isLive ? 'LIVE' : 'DRY RUN' }}</span>
      </div>

      <div class="connection-pill" :class="'is-' + store.connection">
        <span class="status-dot"></span>
        <span>{{ connectionLabel }}</span>
      </div>

      <button class="refresh-button" @click="refresh">刷新</button>
    </div>
  </header>
</template>

<script>
import state, {
  switchChain, switchTab, toggleAlerts, loadState, showToast,
  filteredPositions, filteredTriggers, chainConfig,
} from '../stores/dashboard.js'
import { activePosCount } from '../stores/dashboard.js'

export default {
  setup() {
    const tabs = [
      { id: 'overview', label: '概览' },
      { id: 'signals', label: '信号', get badge() { return state.unreadTriggerCount || null }, badgeClass: 'is-unread' },
      { id: 'positions', label: '持仓', get badge() { return activePosCount.value || null } },
      { id: 'logs', label: '日志', get badge() { return state.logErrorCount ? Math.min(state.logErrorCount, 99) : null }, badgeClass: 'tab-badge-error' },
      { id: 'sniper', label: '🎯 狙击' },
      { id: 'analysis', label: '📊 分析' },
      { id: 'settings', label: '设置' },
    ]

    return {
      store: state, tabs,
      switchChain, switchTab, toggleAlerts, chainConfig,
      async refresh() {
        try { await loadState(); showToast('状态已刷新') } catch { showToast('刷新失败') }
      },
    }
  },
  computed: {
    connectionLabel() {
      return this.store.connection === 'online' ? '实时连接' : this.store.connection === 'offline' ? '连接中断' : '正在连接'
    },
  },
}
</script>
