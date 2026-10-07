<template>
  <div class="settings-tab">

    <!-- ═══════════════ 1. Resonance Wallets ═══════════════ -->
    <section class="settings-section">
      <h2>
        Resonance 钱包
        <span class="settings-desc">（{{ state.data?.settings?.watchedWalletCount ?? 0 }} 个）</span>
      </h2>
      <p class="settings-desc">观察这些钱包的买入行为，用于共振检测。每行一个地址。</p>

      <textarea
        v-model="walletsText"
        class="textarea"
        rows="8"
        placeholder="0x1234567890abcdef1234567890abcdef12345678&#10;0x567890abcdef1234567890abcdef12345678"
      ></textarea>

      <div class="settings-actions">
        <button class="btn-primary" @click="addWallets">追加钱包</button>
        <button class="btn-secondary" @click="replaceWallets">替换全部</button>
        <button class="btn-secondary" @click="downloadWallets">下载列表</button>
        <label class="btn-secondary file-label">
          上传 txt
          <input type="file" accept=".txt" @change="uploadWallets" hidden />
        </label>
      </div>
    </section>

    <!-- ═══════════════ 2. Blacklist ═══════════════ -->
    <section class="settings-section">
      <h2>
        黑名单
        <span class="settings-desc">（{{ state.data?.settings?.blacklistedWalletCount ?? 0 }} 个）</span>
      </h2>
      <p class="settings-desc">黑名单中的钱包买入信号将被忽略。每行一个地址。</p>

      <textarea
        v-model="blacklistText"
        class="textarea"
        rows="6"
        placeholder="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
      ></textarea>

      <div class="settings-actions">
        <button class="btn-primary" @click="addBlacklist">追加黑名单</button>
        <button class="btn-secondary" @click="replaceBlacklist">替换全部</button>
        <button class="btn-secondary" @click="downloadBlacklist">下载列表</button>
        <label class="btn-secondary file-label">
          上传 txt
          <input type="file" accept=".txt" @change="uploadBlacklist" hidden />
        </label>
      </div>
    </section>

    <!-- ═══════════════ 3. Poison Wallets ☠️ ═══════════════ -->
    <section class="settings-section">
      <h2>☠️ 毒钱包</h2>
      <p class="settings-desc">
        毒钱包买入的代币将被自动拉黑，防止被毒信号触发。
      </p>

      <!-- Add form -->
      <div class="settings-form">
        <input
          v-model="newPoisonWallet"
          class="textarea"
          placeholder="输入毒钱包地址 0x..."
        />
        <button class="btn-danger" @click="addPoisonWallet">添加毒钱包</button>
      </div>

      <!-- Poison wallet list -->
      <ul v-if="poisonWallets.length" class="combo-list">
        <li v-for="w in poisonWallets" :key="w" class="combo-item">
          <span
            class="wallet-addr"
            :title="w"
            @click="copyAddress(w)"
          >{{ shortAddress(w) }}</span>
          <button class="combo-remove-btn" @click="removePoisonWallet(w)">移除</button>
        </li>
      </ul>
      <p v-else class="empty-state">暂无毒钱包</p>

      <!-- Token blacklist -->
      <template v-if="tokenBlacklist.length">
        <h3 style="margin-top:1rem;">被拉黑的代币</h3>
        <ul class="combo-list">
          <li v-for="t in tokenBlacklist" :key="t.token || t" class="combo-item">
            <div class="combo-wallets">
              <span
                class="wallet-addr"
                :title="t.token || t"
                @click="copyAddress(t.token || t)"
              >{{ shortAddress(t.token || t) }}</span>
              <small v-if="t.reason" class="token-reason">{{ t.reason }}</small>
            </div>
            <button class="combo-remove-btn" @click="removeTokenBlacklist(t.token || t)">解除</button>
          </li>
        </ul>
      </template>
    </section>

    <!-- ═══════════════ 4. Order Amount ═══════════════ -->
    <section class="settings-section">
      <h2>下单金额</h2>
      <p class="settings-desc">每次共振触发时的买入金额（{{ chainCurrency(activeChain) }}）。</p>

      <div class="settings-form settings-amount">
        <input
          v-model="orderAmount"
          type="number"
          step="0.001"
          min="0"
          class="textarea"
          placeholder="0.01"
        />
        <span class="amount-unit">{{ chainCurrency(activeChain) }}</span>
        <button class="btn-primary" @click="saveOrderAmount">保存</button>
      </div>
      <p class="settings-hint">
        当前値：<strong>{{ state.data?.settings?.orderAmountBnb ?? '—' }}</strong> {{ chainCurrency(activeChain) }}
      </p>
    </section>

    <!-- ═══════════════ 5. Executor Wallet ═══════════════ -->
    <section class="settings-section">
      <h2>执行钱包</h2>
      <p class="settings-desc">
        当前地址：<strong>{{ shortAddress(state.data?.settings?.executorAddress) }}</strong>
      </p>

      <div class="settings-form">
        <input
          v-model="executorKey"
          type="password"
          class="textarea"
          placeholder="输入新私钥（0x...）"
        />
        <button class="btn-danger" @click="saveExecutor">更换执行钱包</button>
      </div>
      <p class="settings-hint">私钥仅在服务端内存中使用，不会落盘。</p>
    </section>

    <!-- ═══════════════ 6. Excluded Combos ═══════════════ -->
    <section class="settings-section">
      <h2>排除组合</h2>
      <p class="settings-desc">
        以下钱包对即使同时共振也不会触发，用于排除关联钱包。
      </p>

      <!-- Add form -->
      <div class="combo-form">
        <div class="combo-inputs">
          <input
            v-model="newComboA"
            class="textarea"
            placeholder="钱包 A 地址"
          />
          <span class="combo-pair-icon swap-btn" title="交换 A/B" @click="swapComboInputs">⇆</span>
          <input
            v-model="newComboB"
            class="textarea"
            placeholder="钱包 B 地址"
          />
        </div>
        <button class="btn-primary" @click="addExcludedCombo">添加排除</button>
      </div>

      <!-- Combo list -->
      <ul v-if="excludedCombos.length" class="combo-list">
        <li v-for="(c, i) in excludedCombos" :key="i" class="combo-item">
          <div class="combo-wallets">
            <span
              class="combo-wallet wallet-addr"
              :title="c.walletA"
              @click="copyAddress(c.walletA)"
            >{{ shortAddress(c.walletA) }}</span>
            <span class="combo-pair-icon">⇆</span>
            <span
              class="combo-wallet wallet-addr"
              :title="c.walletB"
              @click="copyAddress(c.walletB)"
            >{{ shortAddress(c.walletB) }}</span>
          </div>
          <button class="combo-remove-btn" @click="removeExcludedCombo(c.walletA, c.walletB)">移除</button>
        </li>
      </ul>
      <p v-else class="empty-state">暂无排除组合</p>

      <div class="settings-actions">
        <button class="btn-secondary" @click="downloadExcludedCombos">下载列表</button>
        <button class="btn-danger" @click="clearExcludedCombos">清空全部</button>
      </div>
    </section>

    <!-- ═══════════════ 7. GMGN 限价挂单 ═══════════════ -->
    <section class="settings-section">
      <h2>GMGN 限价挂单</h2>
      <p class="settings-desc">买入成功后自动创建止损/止盈挂单，由 GMGN 服务端监控触发。</p>

      <div class="gmgn-config-form">
        <label class="gmgn-toggle-label">
          <input type="checkbox" v-model="gmgnConfig.enabled" class="gmgn-toggle" />
          <span>启用自动挂单</span>
        </label>

        <div class="gmgn-fields-grid">
          <label>止损跌幅 %
            <input type="number" v-model.number="gmgnConfig.stopLossPercent" min="1" max="99" step="1" />
          </label>
          <label>止盈1 涨幅 %
            <input type="number" v-model.number="gmgnConfig.takeProfit1Percent" min="1" max="9999" step="10" />
          </label>
          <label>止盈1 卖出 %
            <input type="number" v-model.number="gmgnConfig.takeProfit1Ratio" min="1" max="100" step="5" />
          </label>
          <label>止盈2 涨幅 %
            <input type="number" v-model.number="gmgnConfig.takeProfit2Percent" min="1" max="99999" step="50" />
          </label>
          <label>止盈2 卖出 %
            <input type="number" v-model.number="gmgnConfig.takeProfit2Ratio" min="1" max="100" step="5" />
          </label>
        </div>

        <button class="btn-primary" @click="saveGmgnConfig">保存配置</button>
      </div>
      <p class="settings-hint">配置修改后对新买入生效，已有挂单可在持仓页单独修改。</p>
    </section>

  </div>
</template>

<script>
import { ref, reactive, onMounted } from 'vue'
import state, { showToast, loadState } from '../../stores/dashboard.js'
import { api } from '../../api/index.js'
import { shortAddress } from '../../composables/useFormat.js'
import { chainCurrency } from '../../composables/useChain.js'

function parseAddresses(text) {
  return [
    ...new Set(
      (text || '')
        .split(/[\r\n,;\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^0x[0-9a-f]{40}$/.test(s))
    ),
  ]
}

export default {
  name: 'SettingsTab',

  setup() {
    // ── Reactive state ──
    const walletsText = ref('')
    const blacklistText = ref('')
    const newPoisonWallet = ref('')
    const orderAmount = ref('')
    const executorKey = ref('')
    const newComboA = ref('')
    const newComboB = ref('')

    const poisonWallets = ref([])
    const tokenBlacklist = ref([])
    const excludedCombos = ref([])

    const gmgnConfig = reactive({
      enabled: true,
      stopLossPercent: 30,
      takeProfit1Percent: 100,
      takeProfit1Ratio: 20,
      takeProfit2Percent: 400,
      takeProfit2Ratio: 30,
    })

    // ── Load on mount ──
    onMounted(async () => {
      try {
        const pw = await api.getPoisonWallets()
        poisonWallets.value = pw.wallets || []
        tokenBlacklist.value = pw.tokenBlacklist || []
      } catch {
        /* ignore */
      }
      try {
        const ec = await api.getExcludedCombos()
        excludedCombos.value = ec.combos || []
      } catch {
        /* ignore */
      }
      try {
        const gc = await api.getGmgnConfig()
        Object.assign(gmgnConfig, gc)
      } catch {
        /* ignore */
      }
      // Sync order amount from state
      if (state.data?.settings?.orderAmountBnb != null) {
        orderAmount.value = String(state.data.settings.orderAmountBnb)
      }
    })

    // ── Wallets ──
    async function addWallets() {
      const addrs = parseAddresses(walletsText.value)
      if (!addrs.length) return showToast('未检测到有效地址')
      try {
        await api.addWallets(addrs)
        showToast(`已追加 ${addrs.length} 个钱包`)
        walletsText.value = ''
        await loadState()
      } catch (e) {
        showToast(`追加失败: ${e.message}`)
      }
    }

    async function replaceWallets() {
      const addrs = parseAddresses(walletsText.value)
      if (!addrs.length) return showToast('未检测到有效地址')
      if (!confirm(`确定用这 ${addrs.length} 个钱包替换全部？`)) return
      try {
        await api.replaceWallets(addrs)
        showToast(`已替换为 ${addrs.length} 个钱包`)
        walletsText.value = ''
        await loadState()
      } catch (e) {
        showToast(`替换失败: ${e.message}`)
      }
    }

    function downloadWallets() {
      window.open('/api/settings/wallets.txt')
    }

    async function uploadWallets(event) {
      const file = event.target.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const addrs = parseAddresses(text)
        if (!addrs.length) return showToast('文件中未检测到有效地址')
        await api.addWallets(addrs)
        showToast(`已从文件追加 ${addrs.length} 个钱包`)
        await loadState()
      } catch (e) {
        showToast(`上传失败: ${e.message}`)
      }
      event.target.value = ''
    }

    // ── Blacklist ──
    async function addBlacklist() {
      const addrs = parseAddresses(blacklistText.value)
      if (!addrs.length) return showToast('未检测到有效地址')
      try {
        await api.addBlacklist(addrs)
        showToast(`已追加 ${addrs.length} 个黑名单`)
        blacklistText.value = ''
        await loadState()
      } catch (e) {
        showToast(`追加失败: ${e.message}`)
      }
    }

    async function replaceBlacklist() {
      const addrs = parseAddresses(blacklistText.value)
      if (!addrs.length) return showToast('未检测到有效地址')
      if (!confirm(`确定用这 ${addrs.length} 个地址替换全部黑名单？`)) return
      try {
        await api.replaceBlacklist(addrs)
        showToast(`已替换为 ${addrs.length} 个黑名单`)
        blacklistText.value = ''
        await loadState()
      } catch (e) {
        showToast(`替换失败: ${e.message}`)
      }
    }

    function downloadBlacklist() {
      window.open('/api/settings/blacklist.txt')
    }

    async function uploadBlacklist(event) {
      const file = event.target.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const addrs = parseAddresses(text)
        if (!addrs.length) return showToast('文件中没有有效地址')
        await api.addBlacklist(addrs)
        showToast(`已从文件上传 ${addrs.length} 个黑名单`)
        await loadState()
      } catch (e) {
        showToast(`上传失败: ${e.message}`)
      }
      event.target.value = ''
    }

    // ── Poison Wallets ──
    async function addPoisonWallet() {
      const w = newPoisonWallet.value.trim().toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(w)) return showToast('地址格式无效')
      try {
        await api.addPoisonWallet(w)
        showToast('已添加毒钱包')
        newPoisonWallet.value = ''
        const pw = await api.getPoisonWallets()
        poisonWallets.value = pw.wallets || []
        tokenBlacklist.value = pw.tokenBlacklist || []
      } catch (e) {
        showToast(`添加失败: ${e.message}`)
      }
    }

    async function removePoisonWallet(wallet) {
      try {
        await api.removePoisonWallet(wallet)
        showToast('已移除毒钱包')
        const pw = await api.getPoisonWallets()
        poisonWallets.value = pw.wallets || []
        tokenBlacklist.value = pw.tokenBlacklist || []
      } catch (e) {
        showToast(`移除失败: ${e.message}`)
      }
    }

    async function removeTokenBlacklist(token) {
      try {
        await api.removeTokenBlacklist(token)
        showToast('已解除代币黑名单')
        const pw = await api.getPoisonWallets()
        poisonWallets.value = pw.wallets || []
        tokenBlacklist.value = pw.tokenBlacklist || []
      } catch (e) {
        showToast(`解除失败: ${e.message}`)
      }
    }

    // ── Order Amount ──
    async function saveOrderAmount() {
      const amount = parseFloat(orderAmount.value)
      if (isNaN(amount) || amount <= 0) return showToast('请输入有效金额')
      try {
        await api.saveOrderAmount(String(amount))  // 发送字符串而非数字
        showToast('下单金额已保存')
        await loadState()
      } catch (e) {
        showToast(`保存失败: ${e.message}`)
      }
    }

    // ── Executor ──
    async function saveExecutor() {
      const key = executorKey.value.trim()
      if (!key) return showToast('请输入私钥')
      if (!confirm('确定更换执行钱包？旧私钥将被替换。')) return
      try {
        await api.saveExecutor(key)
        showToast('执行钱包已更换')
        executorKey.value = ''
        await loadState()
      } catch (e) {
        showToast(`更换失败: ${e.message}`)
      }
    }

    // ── Excluded Combos ──
    async function addExcludedCombo() {
      const a = newComboA.value.trim().toLowerCase()
      const b = newComboB.value.trim().toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(a) || !/^0x[0-9a-f]{40}$/.test(b)) {
        return showToast('请输入有效的钱包地址')
      }
      if (a === b) return showToast('两个地址不能相同')
      try {
        await api.addExcludedCombo(a, b)
        showToast('已添加排除组合')
        newComboA.value = ''
        newComboB.value = ''
        const ec = await api.getExcludedCombos()
        excludedCombos.value = ec.combos || []
      } catch (e) {
        showToast(`添加失败: ${e.message}`)
      }
    }

    async function removeExcludedCombo(walletA, walletB) {
      try {
        await api.removeExcludedCombo(walletA, walletB)
        showToast('已移除排除组合')
        const ec = await api.getExcludedCombos()
        excludedCombos.value = ec.combos || []
      } catch (e) {
        showToast(`移除失败: ${e.message}`)
      }
    }

    function swapComboInputs() {
      const tmp = newComboA.value
      newComboA.value = newComboB.value
      newComboB.value = tmp
    }

    function downloadExcludedCombos() {
      const lines = excludedCombos.value.map((c) => `${c.walletA}\t${c.walletB}`).join('\n')
      const blob = new Blob([lines], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'excluded-combos.txt'
      a.click()
      URL.revokeObjectURL(url)
    }

    async function clearExcludedCombos() {
      if (!confirm('确定清空所有排除组合？')) return
      try {
        const combos = excludedCombos.value
        for (const c of combos) {
          await api.removeExcludedCombo(c.walletA, c.walletB)
        }
        excludedCombos.value = []
        showToast('已清空全部排除组合')
      } catch (e) {
        showToast(`清空失败: ${e.message}`)
      }
    }

    // ── Helpers ──
    function copyAddress(addr) {
      navigator.clipboard.writeText(addr).then(
        () => showToast('已复制地址'),
        () => showToast('复制失败')
      )
    }

    // ── GMGN Config ──
    async function saveGmgnConfig() {
      try {
        await api.saveGmgnConfig({ ...gmgnConfig })
        showToast('GMGN 配置已保存')
      } catch (e) {
        showToast(`保存失败: ${e.message}`)
      }
    }

    return {
      state,
      shortAddress,
      chainCurrency,
      get activeChain() { return state.activeChain },
      // refs
      walletsText,
      blacklistText,
      newPoisonWallet,
      orderAmount,
      executorKey,
      newComboA,
      newComboB,
      poisonWallets,
      tokenBlacklist,
      excludedCombos,
      // wallet methods
      addWallets,
      replaceWallets,
      downloadWallets,
      uploadWallets,
      // blacklist methods
      addBlacklist,
      replaceBlacklist,
      downloadBlacklist,
      uploadBlacklist,
      // poison methods
      addPoisonWallet,
      removePoisonWallet,
      removeTokenBlacklist,
      // order amount
      saveOrderAmount,
      // executor
      saveExecutor,
      // excluded combos
      addExcludedCombo,
      removeExcludedCombo,
      swapComboInputs,
      downloadExcludedCombos,
      clearExcludedCombos,
      // helpers
      copyAddress,
      // gmgn
      gmgnConfig,
      saveGmgnConfig,
    }
  },
}
</script>
