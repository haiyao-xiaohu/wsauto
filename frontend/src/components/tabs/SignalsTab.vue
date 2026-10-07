<template>
  <!-- Hero section -->
  <div class="signals-hero">
    <div class="signals-summary">
      <h2>Signals &amp; Triggers</h2>
      <p>
        监听链上 Webhook 信号，检测多钱包共振并自动构建交易路由。
        <br />阈值 {{ chainConfig.threshold }} · 窗口 {{ chainConfig.windowSeconds }}s
      </p>
    </div>
    <div class="signals-stats">
      <div class="stat-chip">
        <span>信号总数</span>
        <strong>{{ formatNumber(metrics.totalSignals) }}</strong>
      </div>
      <div class="stat-chip">
        <span>共振触发</span>
        <strong>{{ formatNumber(metrics.triggers) }}</strong>
      </div>
      <div class="stat-chip">
        <span>路由构建</span>
        <strong>{{ formatNumber(metrics.routesBuilt) }}</strong>
      </div>
      <div class="stat-chip">
        <span>冷却拒绝</span>
        <strong>{{ formatNumber(metrics.cooldowns) }}</strong>
      </div>
    </div>
  </div>

  <!-- Feed grid: triggers (left) + signals (right) -->
  <div class="feed-grid">
    <!-- Left panel: Trigger list -->
    <div class="panel">
      <div class="panel-head">
        <div>
          <span class="section-kicker">RESONANCE</span>
          <h2>触发记录</h2>
        </div>
        <span class="panel-count accent">{{ filteredTriggers.length }} 条</span>
      </div>

      <div v-if="filteredTriggers.length === 0" class="empty-state compact">
        <div class="empty-orbit"></div>
        <strong>暂无触发</strong>
        <p>当多钱包信号在同一窗口内共振时，将在此显示。</p>
      </div>

      <div v-else class="trigger-list">
        <div
          v-for="trigger in filteredTriggers"
          :key="trigger.id"
          class="trigger-card"
        >
          <!-- Top row: chain + token + badges -->
          <div class="trigger-top">
            <div class="trigger-token">
              <span :class="['chain-badge', `chain-badge--${trigger.chain || 'bsc'}`]">
                {{ (trigger.chain || 'bsc').toUpperCase() }}
              </span>
              &nbsp;
              <a
                :href="`${chainExplorerBase(trigger.chain || 'bsc', 'token')}/${trigger.tokenAddress}`"
                target="_blank"
                rel="noopener"
                class="token-link"
              >
                {{ shortAddress(trigger.tokenAddress, 8, 6) }}
              </a>
            </div>
            <div class="trigger-badges">
              <span :class="['trigger-badge', trigger.status]">
                {{ triggerStatusLabels[trigger.status] || trigger.status }}
              </span>
              <span
                v-for="route in triggerRoutes(trigger)"
                :key="route"
                :class="['route-badge', `route-${route}`]"
              >
                {{ routeEmoji[route] || route }}
              </span>
            </div>
          </div>

          <!-- Detail line: delta + tx -->
          <div class="trigger-detail">
            <span v-if="trigger.deltaSeconds != null">Δ {{ trigger.deltaSeconds }}s</span>
            <a
              v-if="trigger.broadcastTxHash"
              :href="`${chainExplorerBase(trigger.chain || 'bsc', 'tx')}/${trigger.broadcastTxHash}`"
              target="_blank"
              rel="noopener"
              class="tx-link"
            >
              TX {{ shortAddress(trigger.broadcastTxHash, 6, 4) }}
            </a>
            <span v-if="trigger.createdAtMs">{{ timeAgo(trigger.createdAtMs) }}</span>
          </div>

          <!-- OKX/Flap/Uniswap swap detail line -->
          <div v-if="triggerSwapDetail(trigger)" class="trigger-detail">
            <span>{{ triggerSwapDetail(trigger) }}</span>
          </div>

          <!-- Wallet chips -->
          <div class="trigger-wallets">
            <a
              v-for="addr in (trigger.wallets || [])"
              :key="addr"
              class="wallet-chip"
              :href="walletExplorerUrl(trigger.chain || 'bsc', addr)"
              target="_blank"
              rel="noopener"
            >
              {{ walletLabel(addr) }}
            </a>
          </div>

          <!-- Bottom: timestamp -->
          <div class="trigger-bottom">
            <span>{{ localTime(trigger.createdAtMs) }}</span>
          </div>

          <!-- Error -->
          <div v-if="trigger.error" class="trigger-error">
            {{ trigger.error }}
          </div>
        </div>
      </div>
    </div>

    <!-- Right panel: Signal table -->
    <div class="panel">
      <div class="panel-head">
        <div>
          <span class="section-kicker">WEBHOOK FEED</span>
          <h2>信号流</h2>
        </div>
        <span class="panel-count">{{ filteredSignals.length }} 条</span>
      </div>

      <div v-if="filteredSignals.length === 0" class="empty-state compact">
        <div class="empty-orbit"></div>
        <strong>等待信号</strong>
        <p>Webhook 接收到的链上买入信号将在此显示。</p>
      </div>

      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>链 / 时间</th>
              <th>钱包</th>
              <th>代币</th>
              <th>决策</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(signal, idx) in filteredSignals" :key="idx">
              <!-- Chain + time + delay -->
              <td>
                <span :class="['chain-badge', `chain-badge--${signal.chain || 'bsc'}`]">
                  {{ (signal.chain || 'bsc').toUpperCase() }}
                </span>
                {{ localTime(signal.blockTimestampMs) }}
                <span
                  v-if="signalDelay(signal) != null"
                  :class="['signal-delay', delayClass(signalDelay(signal))]"
                >
                  +{{ signalDelay(signal) }}s
                </span>
              </td>

              <!-- Wallet -->
              <td>
                <a
                  class="wallet-chip"
                  :href="walletExplorerUrl(signal.chain || 'bsc', signal.walletAddress)"
                  target="_blank"
                  rel="noopener"
                >
                  {{ walletLabel(signal.walletAddress) }}
                </a>
              </td>

              <!-- Token -->
              <td>
                <a
                  :href="`${chainExplorerBase(signal.chain || 'bsc', 'token')}/${signal.tokenAddress}`"
                  target="_blank"
                  rel="noopener"
                  class="token-link"
                >
                  {{ shortAddress(signal.tokenAddress, 8, 6) }}
                </a>
              </td>

              <!-- Decision -->
              <td>
                <span :class="['signal-status', signal.decision]">
                  {{ decisionLabels[signal.decision] || signal.decision }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script>
import state, { filteredSignals, filteredTriggers, chainConfig } from '../../stores/dashboard.js'
import {
  formatNumber, shortAddress, localTime, timeAgo,
  decisionLabels, triggerStatusLabels, routeEmoji,
} from '../../composables/useFormat.js'
import { chainExplorerBase } from '../../composables/useChain.js'

export default {
  name: 'SignalsTab',
  setup() {
    return {
      state,
      filteredSignals,
      filteredTriggers,
      chainConfig,
      formatNumber,
      shortAddress,
      localTime,
      timeAgo,
      decisionLabels,
      triggerStatusLabels,
      routeEmoji,
      chainExplorerBase,
    }
  },
  computed: {
    metrics() {
      const m = this.state.data?.metrics || {}
      return {
        totalSignals: m.totalSignals ?? this.filteredSignals.length ?? 0,
        triggers: m.triggers ?? this.filteredTriggers.length ?? 0,
        routesBuilt: m.routesBuilt ?? 0,
        cooldowns: m.cooldowns ?? 0,
      }
    },
    walletBook() {
      return this.state.data?.walletBook || {}
    },
  },
  methods: {
    /** Signal delay in seconds (receivedAt - blockTimestamp) */
    signalDelay(signal) {
      if (signal.receivedAtMs == null || signal.blockTimestampMs == null) return null
      return ((signal.receivedAtMs - signal.blockTimestampMs) / 1000).toFixed(1)
    },

    /** CSS class for delay indicator */
    delayClass(seconds) {
      const s = parseFloat(seconds)
      if (s < 5) return 'delay-fast'
      if (s <= 10) return 'delay-mid'
      return 'delay-slow'
    },

    /** Swap detail string for trigger card */
    triggerSwapDetail(trigger) {
      const swap = trigger.swap
      if (!swap) return null
      if (swap.okx) {
        const o = swap.okx
        const parts = []
        if (o.expectedToAmount && o.toToken) parts.push(`${o.expectedToAmount} ${o.toToken}`)
        if (o.priceImpact) parts.push(`impact ${o.priceImpact}%`)
        if (o.latencyMs) parts.push(`${o.latencyMs}ms`)
        return parts.join(' · ') || 'OKX DEX'
      }
      if (swap.fourmeme) return 'Four.meme 内盘买入'
      if (swap.flap) return 'Flap.sh 内盘买入'
      if (swap.uniswap) return 'Uniswap V3 路由'
      return null
    },

    /** Extract route badges from trigger.swap */
    triggerRoutes(trigger) {
      const routes = []
      const swap = trigger.swap
      if (!swap) return routes
      if (swap.route) routes.push(swap.route)
      if (swap.flap && !routes.includes('flap_inner')) routes.push('flap_inner')
      if (swap.okx && !routes.includes('okx_dex')) routes.push('okx_dex')
      if (swap.uniswap && !routes.includes('uniswap_v3')) routes.push('uniswap_v3')
      return routes
    },

    /** Explorer URL for a wallet address */
    walletExplorerUrl(chain, address) {
      if (!address) return '#'
      if (chain === 'rob') {
        return `https://robinhoodchain.blockscout.com/address/${address}`
      }
      return `https://bscscan.com/address/${address}`
    },

    /** Wallet display label: book name/emoji or shortened address */
    walletLabel(address) {
      if (!address) return '—'
      const entry = this.walletBook[address.toLowerCase()]
      if (entry) {
        const name = entry.name || entry.emoji || ''
        if (name) return name
      }
      return shortAddress(address)
    },
  },
}
</script>
