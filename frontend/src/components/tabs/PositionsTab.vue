<template>
  <section>
    <!-- Hero -->
    <div class="positions-hero">
      <div class="positions-summary">
        <h2>持仓监控</h2>
        <p>自动止盈止损 · 实时仓位追踪 · {{ currency }} 计价</p>
      </div>
      <div class="positions-stats">
        <div class="stat-chip">
          <span>活跃仓位</span>
          <strong>{{ activeCount }}</strong>
        </div>
        <div class="stat-chip">
          <span>已止盈</span>
          <strong>{{ takeProfitCount }}</strong>
        </div>
        <div class="stat-chip">
          <span>已止损</span>
          <strong>{{ stopLossCount }}</strong>
        </div>
        <div class="stat-chip">
          <span>总成本</span>
          <strong>{{ totalCost }} {{ currency }}</strong>
        </div>
      </div>
    </div>

    <!-- Auto-sell banner -->
    <div class="auto-sell-banner" v-if="autoSell">
      <div class="auto-sell-info">
        <span class="auto-sell-icon">AS</span>
        <div>
          <strong>自动止盈止损策略</strong>
          <small>
            止盈 {{ autoSell.takeProfitPercent }}% · 止损 {{ autoSell.stopLossPercent }}%
          </small>
        </div>
      </div>
      <span class="auto-sell-status">{{ autoSellStatusText }}</span>
    </div>

    <!-- Position grid -->
    <div class="positions-grid">
      <div v-if="positions.length === 0" class="empty-state">
        <div class="empty-orbit"></div>
        <strong>暂无持仓</strong>
        <p>当前链上暂无持仓数据，等待共振信号触发买入</p>
      </div>

      <div v-else class="position-list">
        <div
          v-for="pos in positions"
          :key="pos.tokenAddress + pos.buyTxHash"
          class="position-card"
          :class="'status-' + pos.status"
        >
          <!-- Top row: token + badges -->
          <div class="position-top">
            <div class="position-token">
              <span
                class="chain-badge"
                :class="'chain-badge--' + getChain(pos)"
              >{{ getChain(pos).toUpperCase() }}</span>
              <a
                :href="tokenUrl(pos)"
                target="_blank"
                rel="noopener"
                class="token-link"
              >{{ shortAddr(pos.tokenAddress) }}</a>
              <span
                v-if="pos.route || pos.platform"
                class="route-badge"
                :class="'route-' + (pos.route || pos.platform)"
              >{{ routeLabel(pos.route || pos.platform) }}</span>
            </div>
            <span
              class="position-status"
              :class="pos.status"
            >{{ statusLabel(pos.status) }}</span>
          </div>

          <!-- Info row -->
          <div class="position-info">
            <span>{{ costDisplay(pos) }} {{ currency }}</span>
            <span>{{ ageDisplay(pos) }}</span>
          </div>

          <!-- TX link -->
          <div class="position-tx" v-if="pos.buyTxHash">
            <a :href="txUrl(pos)" target="_blank" rel="noopener">
              TX {{ shortAddr(pos.buyTxHash, 8, 6) }} ↗
            </a>
          </div>

          <!-- Action history -->
          <div class="position-actions" v-if="pos.actions && pos.actions.length">
            <span
              v-for="(act, i) in pos.actions"
              :key="i"
              class="position-action"
              :class="'action-' + act.type"
            >{{ actionLabel(act.type) }}</span>
          </div>

          <!-- GMGN 挂单面板 -->
          <div v-if="pos.gmgnOrders && pos.gmgnOrders.length" class="gmgn-orders">
            <div class="gmgn-orders-header">
              <span>GMGN 挂单</span>
              <button
                v-if="pos.status === 'active'"
                class="gmgn-edit-btn"
                title="修改挂单"
                @click="openGmgnEdit(pos)"
              >⚙</button>
            </div>
            <div
              v-for="o in pos.gmgnOrders"
              :key="o.orderId"
              class="gmgn-order-item"
              :class="gmgnStatusClass(o.status)"
            >
              <span class="gmgn-type">{{ o.type === 'stop_loss' ? '🛡' : '📈' }}</span>
              <span class="gmgn-label">{{ o.label }}</span>
              <span class="gmgn-price">{{ formatSmallPrice(o.checkPriceUsd) }}</span>
              <span class="gmgn-sell">{{ o.sellPercent }}%</span>
              <span class="gmgn-status" :class="gmgnStatusClass(o.status)">{{ gmgnStatusLabel(o.status) }}</span>
            </div>
          </div>
          <div v-else-if="pos.status === 'active'" class="gmgn-orders gmgn-empty">
            <span>GMGN 挂单未创建</span>
          </div>
        </div>
      </div>
    </div>

    <!-- GMGN 编辑弹窗 -->
    <Teleport to="body">
      <div v-if="gmgnEditPos" class="gmgn-modal-overlay" @click.self="gmgnEditPos = null">
        <div class="gmgn-modal">
          <h3>修改 GMGN 挂单</h3>
          <p class="gmgn-modal-token">{{ shortAddr(gmgnEditPos.tokenAddress, 10, 6) }}</p>
          <div class="gmgn-form-grid">
            <label>止损跌幅 %
              <input type="number" v-model.number="gmgnForm.stopLossPercent" min="1" max="99" step="1" />
            </label>
            <label>止盈1 涨幅 %
              <input type="number" v-model.number="gmgnForm.takeProfit1Percent" min="1" max="9999" step="10" />
            </label>
            <label>止盈1 卖出 %
              <input type="number" v-model.number="gmgnForm.takeProfit1Ratio" min="1" max="100" step="5" />
            </label>
            <label>止盈2 涨幅 %
              <input type="number" v-model.number="gmgnForm.takeProfit2Percent" min="1" max="99999" step="50" />
            </label>
            <label>止盈2 卖出 %
              <input type="number" v-model.number="gmgnForm.takeProfit2Ratio" min="1" max="100" step="5" />
            </label>
          </div>
          <div class="gmgn-modal-actions">
            <button class="btn-secondary" @click="gmgnEditPos = null">取消</button>
            <button class="btn-primary" :disabled="gmgnSaving" @click="saveGmgnOrders">
              {{ gmgnSaving ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<script>
import { ref, reactive } from 'vue'
import state, { filteredPositions, isLive, loadState, showToast } from '../../stores/dashboard.js'
import { shortAddress, routeEmoji, positionStatusLabels } from '../../composables/useFormat.js'
import { inferChain, chainCurrency, chainExplorerBase } from '../../composables/useChain.js'
import { api } from '../../api/index.js'

const actionLabels = {
  buy: '买入',
  take_profit: '止盈',
  stop_loss: '止损',
  manual_sell: '手动卖出',
}

const gmgnStatusMap = {
  open: '生效中',
  prepare: '待触发',
  triggered: '已触发',
  cancelled: '已取消',
  unknown: '未知',
}

export default {
  setup() {
    const gmgnEditPos = ref(null)
    const gmgnSaving = ref(false)
    const gmgnForm = reactive({
      stopLossPercent: 30,
      takeProfit1Percent: 100,
      takeProfit1Ratio: 20,
      takeProfit2Percent: 400,
      takeProfit2Ratio: 30,
    })

    function openGmgnEdit(pos) {
      const orders = pos.gmgnOrders || []
      const stopLoss = orders.find(o => o.type === 'stop_loss')
      const tp1 = orders.find(o => o.type === 'take_profit' && o.sellPercent <= 25)
      const tp2 = orders.find(o => o.type === 'take_profit' && o.sellPercent > 25)
      gmgnForm.stopLossPercent = stopLoss ? Math.abs(parseFloat(stopLoss.label) || 30) : 30
      gmgnForm.takeProfit1Percent = tp1 ? parseFloat(tp1.label) || 100 : 100
      gmgnForm.takeProfit1Ratio = tp1 ? tp1.sellPercent : 20
      gmgnForm.takeProfit2Percent = tp2 ? parseFloat(tp2.label) || 400 : 400
      gmgnForm.takeProfit2Ratio = tp2 ? tp2.sellPercent : 30
      gmgnEditPos.value = pos
    }

    async function saveGmgnOrders() {
      if (!gmgnEditPos.value) return
      gmgnSaving.value = true
      try {
        await api.updateGmgnOrders(gmgnEditPos.value.id, {
          stopLossPercent: gmgnForm.stopLossPercent,
          takeProfit1Percent: gmgnForm.takeProfit1Percent,
          takeProfit1Ratio: gmgnForm.takeProfit1Ratio,
          takeProfit2Percent: gmgnForm.takeProfit2Percent,
          takeProfit2Ratio: gmgnForm.takeProfit2Ratio,
        })
        showToast('挂单已更新')
        gmgnEditPos.value = null
        await loadState()
      } catch (e) {
        showToast(`更新失败: ${e.message}`)
      } finally {
        gmgnSaving.value = false
      }
    }

    return {
      store: state,
      filteredPositions,
      isLive,
      shortAddress,
      inferChain,
      chainCurrency,
      chainExplorerBase,
      gmgnEditPos,
      gmgnSaving,
      gmgnForm,
      openGmgnEdit,
      saveGmgnOrders,
    }
  },
  computed: {
    positions() {
      return this.filteredPositions
    },
    currency() {
      return this.chainCurrency(this.store.activeChain)
    },
    autoSell() {
      return this.store.data?.autoSell || null
    },
    autoSellStatusText() {
      if (!this.autoSell) return 'OFF'
      if (this.autoSell.enabled && this.isLive) return 'MONITORING'
      if (this.isLive) return 'STANDBY'
      return 'OFF'
    },
    activeCount() {
      return this.positions.filter(p => p.status === 'active').length
    },
    takeProfitCount() {
      return this.positions.filter(p => p.status === 'take_profit_done').length
    },
    stopLossCount() {
      return this.positions.filter(p => p.status === 'stop_loss_done').length
    },
    totalCost() {
      let total = 0n
      for (const p of this.positions) {
        try { total += BigInt(p.costBnb || '0') } catch { /* ignore */ }
      }
      return (Number(total) / 1e18).toFixed(4)
    },
  },
  methods: {
    shortAddr(addr, left = 6, right = 4) {
      return shortAddress(addr, left, right)
    },
    getChain(pos) {
      return inferChain(pos)
    },
    tokenUrl(pos) {
      const chain = inferChain(pos)
      return chainExplorerBase(chain, 'token') + '/' + pos.tokenAddress
    },
    txUrl(pos) {
      const chain = inferChain(pos)
      return chainExplorerBase(chain, 'tx') + '/' + pos.buyTxHash
    },
    routeLabel(route) {
      return routeEmoji[route] || route || '—'
    },
    statusLabel(status) {
      return positionStatusLabels[status] || status
    },
    actionLabel(type) {
      return actionLabels[type] || type
    },
    costDisplay(pos) {
      try { return (Number(BigInt(pos.costBnb || '0')) / 1e18).toFixed(4) } catch { return '0.0000' }
    },
    ageDisplay(pos) {
      if (!pos.boughtAtMs) return '—'
      const ms = Date.now() - pos.boughtAtMs
      const minutes = Math.floor(ms / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      return `${hours}h ${minutes % 60}m`
    },
    gmgnStatusClass(status) {
      if (status === 'open') return 'open'
      if (status === 'prepare') return 'prepare'
      if (status === 'cancelled') return 'cancelled'
      return 'unknown'
    },
    gmgnStatusLabel(status) {
      return gmgnStatusMap[status] || status
    },
    formatSmallPrice(priceStr) {
      if (!priceStr) return '—'
      const num = parseFloat(priceStr)
      if (isNaN(num)) return priceStr
      if (num === 0) return '0'
      if (num < 0.00001) return num.toExponential(2)
      return num.toFixed(8)
    },
  },
}
</script>
