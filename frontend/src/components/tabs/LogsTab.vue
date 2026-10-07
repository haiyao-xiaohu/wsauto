<template>
  <!-- Hero section -->
  <div class="logs-hero">
    <div class="logs-summary">
      <h2>事件日志</h2>
      <p>系统运行日志与事件追踪，实时展示交易流程中的关键节点。</p>
    </div>
    <div class="logs-stats">
      <div class="stat-chip">
        <span>日志总数</span>
        <strong>{{ formatNumber(logsLength) }}</strong>
      </div>
      <div class="stat-chip">
        <span>错误事件</span>
        <strong>{{ formatNumber(errorEventCount) }}</strong>
      </div>
      <div class="stat-chip">
        <span>已过滤</span>
        <strong>{{ formatNumber(filteredLogs.length) }}</strong>
      </div>
    </div>
  </div>

  <!-- Filter bar + clear -->
  <div class="logs-controls">
    <div class="log-filter-bar">
      <button
        v-for="filter in filters"
        :key="filter.value"
        :class="['log-filter', { 'is-active': state.logFilter === filter.value }]"
        @click="setLogFilter(filter.value)"
      >
        {{ filter.label }}
      </button>
    </div>
    <button class="log-clear-btn" @click="clearLogs">清空日志</button>
  </div>

  <!-- Log list panel -->
  <div class="logs-panel">
    <div v-if="filteredLogs.length === 0" class="empty-state compact">
      <div class="empty-orbit"></div>
      <strong>暂无日志</strong>
      <p>当事件发生时，将在此显示。</p>
    </div>

    <div v-else class="log-list">
      <div
        v-for="(entry, idx) in filteredLogs"
        :key="idx"
        :class="['log-entry', `log-${entry.level}`]"
      >
        <span class="log-time">{{ localTime(entry.ts) }}</span>
        <span :class="['log-level', `log-${entry.level}`]">
          {{ logLevelLabels[entry.level] || entry.level }}
        </span>
        <span class="log-event">
          {{ logEventLabels[entry.event] || entry.event }}
        </span>
        <span class="log-msg">{{ entry.message }}</span>

        <a
          v-if="entry.tokenAddress"
          class="log-token"
          :href="logTokenUrl(entry)"
          target="_blank"
          rel="noopener"
        >
          {{ shortAddress(entry.tokenAddress, 8, 6) }}
        </a>

        <pre v-if="entry.data" class="log-data">{{ JSON.stringify(entry.data, null, 2) }}</pre>
      </div>
    </div>
  </div>
</template>

<script>
import state, { filteredLogs, logsLength, errorEventCount, setLogFilter, clearLogs } from '../../stores/dashboard.js'
import {
  formatNumber,
  shortAddress,
  localTime,
  logLevelLabels,
  logEventLabels,
} from '../../composables/useFormat.js'
import { chainExplorerBase } from '../../composables/useChain.js'

export default {
  name: 'LogsTab',

  data() {
    return {
      filters: [
        { label: '全部', value: '' },
        { label: '错误', value: 'error' },
        { label: '成功', value: 'success' },
        { label: '信息', value: 'info' },
      ],
    }
  },

  setup() {
    return {
      state,
      filteredLogs,
      logsLength,
      errorEventCount,
      setLogFilter,
      clearLogs,
      formatNumber,
      shortAddress,
      localTime,
      logLevelLabels,
      logEventLabels,
      chainExplorerBase,
    }
  },

  methods: {
    /** 链感知的 token 浏览器链接 */
    logTokenUrl(entry) {
      const chain = entry.chain || 'bsc'
      return chainExplorerBase(chain, 'token') + '/' + entry.tokenAddress
    },
  },
}
</script>

<style scoped>
.logs-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 20px;
}

.logs-summary h2 {
  margin: 0 0 6px;
  font-size: 22px;
  letter-spacing: -0.02em;
}

.logs-summary p {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}

.logs-stats {
  display: flex;
  gap: 10px;
}

.logs-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}

.log-filter-bar {
  display: flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
}

.log-filter {
  padding: 5px 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--muted);
  cursor: pointer;
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.04em;
  background: transparent;
  transition: all 140ms ease;
}

.log-filter:hover {
  color: #c9d0cb;
  background: rgba(255, 255, 255, 0.03);
}

.log-filter.is-active {
  color: var(--accent);
  border-color: rgba(184, 255, 99, 0.18);
  background: var(--accent-soft);
}

.log-clear-btn {
  padding: 6px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 600;
  background: transparent;
  transition: all 140ms ease;
}

.log-clear-btn:hover {
  color: var(--danger);
  border-color: rgba(255, 119, 119, 0.2);
}

.logs-panel {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  backdrop-filter: blur(14px);
}

.log-list {
  max-height: 600px;
  overflow-y: auto;
}

.log-entry {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  font-family: var(--mono);
  font-size: 9px;
}

.log-entry:last-child {
  border-bottom: 0;
}

.log-time {
  flex: 0 0 64px;
  color: var(--muted);
}

.log-level {
  flex: 0 0 32px;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 8px;
  font-weight: 700;
  text-align: center;
  letter-spacing: 0.04em;
}

.log-event {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--muted);
  font-size: 8px;
  background: rgba(255, 255, 255, 0.04);
}

.log-msg {
  flex: 1 1 auto;
  min-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #c9d0cb;
}

.log-token {
  color: var(--cyan);
  padding: 2px 5px;
  border: 1px solid rgba(101, 230, 203, 0.15);
  border-radius: 4px;
  font-size: 8px;
  background: rgba(101, 230, 203, 0.04);
}

.log-token:hover {
  border-color: rgba(101, 230, 203, 0.3);
}

.log-data {
  color: var(--muted);
  font-size: 8px;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
  margin: 0;
}

.log-info .log-level {
  color: var(--cyan);
  background: rgba(101, 230, 203, 0.1);
}

.log-success .log-level {
  color: var(--accent);
  background: var(--accent-soft);
}

.log-warn .log-level {
  color: var(--warning);
  background: rgba(255, 202, 107, 0.1);
}

.log-error .log-level {
  color: var(--danger);
  background: rgba(255, 119, 119, 0.1);
}

.log-error {
  background: rgba(255, 119, 119, 0.025);
}

.log-error .log-msg {
  color: var(--danger);
}

@media (max-width: 1100px) {
  .logs-hero {
    flex-direction: column;
    align-items: flex-start;
  }
}

@media (max-width: 760px) {
  .log-entry {
    font-size: 8px;
    padding: 8px 12px;
  }

  .log-data {
    display: none;
  }
}
</style>
