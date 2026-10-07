<template>
  <!-- Hero section -->
  <div class="analysis-hero">
    <div class="signals-summary">
      <h2>共振组合分析</h2>
      <p>
        统计历史共振事件中的钱包组合频率，识别高频共振对以便排除干扰。
      </p>
    </div>
    <div class="signals-stats">
      <div class="stat-chip">
        <span>组合总数</span>
        <strong>{{ combos.length }}</strong>
      </div>
      <div class="stat-chip">
        <span>共振总次数</span>
        <strong>{{ totalResonances }}</strong>
      </div>
    </div>
  </div>

  <!-- Table panel -->
  <div class="feed-grid" style="grid-template-columns: 1fr">
    <div class="panel">
      <div class="panel-head">
        <div>
          <span class="section-kicker">COMBO ANALYSIS</span>
          <h2>共振组合列表</h2>
        </div>
        <span class="panel-count">{{ combos.length }} 条</span>
      </div>

      <div v-if="combos.length === 0" class="empty-state compact">
        <div class="empty-orbit"></div>
        <strong>暂无数据</strong>
        <p>当产生共振记录后，钱包组合统计将在此显示。</p>
      </div>

      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>钱包组合</th>
              <th>涉及的币</th>
              <th>次数</th>
              <th>最近</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(combo, idx) in combos" :key="idx" class="combo-item">
              <!-- 钱包组合 -->
              <td>
                <div class="combo-wallets">
                  <span
                    v-for="addr in combo.wallets"
                    :key="addr"
                    class="combo-wallet-full"
                    title="点击复制"
                    @click="copyAddress(addr)"
                  >
                    <span class="wallet-addr">{{ addr }}</span>
                  </span>
                </div>
              </td>

              <!-- 涉及的币 -->
              <td>
                <div class="combo-tokens">
                  <a
                    v-for="token in combo.tokens"
                    :key="token"
                    :href="tokenUrl(token)"
                    target="_blank"
                    rel="noopener"
                    class="token-link"
                  >
                    {{ shortAddress(token, 8, 6) }}
                  </a>
                </div>
              </td>

              <!-- 次数 -->
              <td>
                <span :class="{ 'combo-count-warn': combo.count >= 3 }">
                  {{ combo.count }}
                </span>
              </td>

              <!-- 最近 -->
              <td>{{ timeAgo(combo.lastAtMs) }}</td>

              <!-- 操作 -->
              <td>
                <button class="combo-remove-btn" @click="quickExcludeCombo(combo.wallets)">
                  排除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed, onMounted } from 'vue'
import { shortAddress, timeAgo } from '../../composables/useFormat.js'
import { chainExplorerBase } from '../../composables/useChain.js'
import { api } from '../../api/index.js'
import state from '../../stores/dashboard.js'

export default {
  name: 'AnalysisTab',
  setup() {
    const combos = ref([])

    const totalResonances = computed(() => {
      return combos.value.reduce((sum, c) => sum + (c.count || 0), 0)
    })

    onMounted(async () => {
      try {
        const data = await api.getCombos()
        combos.value = data.combos || []
      } catch (err) {
        console.error('[AnalysisTab] failed to load combos:', err)
      }
    })

    function copyAddress(addr) {
      if (!addr) return
      navigator.clipboard.writeText(addr).catch(() => {})
    }

    async function quickExcludeCombo(wallets) {
      if (!wallets || wallets.length < 2) return
      try {
        await api.addExcludedCombo(wallets[0], wallets[1])
      } catch (e) {
        console.error('[AnalysisTab] exclude combo failed:', e)
      }
    }

    return {
      combos,
      totalResonances,
      shortAddress,
      timeAgo,
      copyAddress,
      quickExcludeCombo,
      tokenUrl(token) {
        return chainExplorerBase(state.activeChain, 'token') + '/' + token
      },
    }
  },
}
</script>
