<template>
  <div class="sniper-layout">
    <!-- ═══════════════ Left Column: Dev Wallets ═══════════════ -->
    <div class="sniper-col">
      <section class="settings-section">
        <h2>🎯 狙击钱包</h2>
        <p class="settings-desc">
          管理狙击钱包列表。当这些钱包出现在链上时，系统将自动跟随买入。
          已加载 <strong>{{ devWallets.length }}</strong> 个钱包。
        </p>

        <!-- Add wallet form -->
        <div class="combo-form">
          <div class="combo-inputs">
            <input
              v-model="newWallet"
              type="text"
              placeholder="输入钱包地址 0x..."
              @keyup.enter="addWallet"
            />
            <button class="btn-primary" @click="addWallet" :disabled="!newWallet.trim()">
              添加
            </button>
          </div>
        </div>

        <!-- Download button -->
        <div class="settings-actions">
          <button class="btn-secondary" @click="downloadWallets">
            下载钱包列表
          </button>
        </div>

        <!-- Wallet list -->
        <div class="combo-list" v-if="devWallets.length">
          <div v-for="w in devWallets" :key="w" class="combo-item">
            <div class="combo-wallets">
              <div class="combo-wallet-full" @click="copyAddress(w)" :title="'点击复制: ' + w">
                <span class="combo-pair-icon">W</span>
                <span class="wallet-addr">{{ w }}</span>
              </div>
            </div>
            <button class="combo-remove-btn" @click="removeWallet(w)">移除</button>
          </div>
        </div>

        <!-- Empty state -->
        <div v-else class="empty-state compact">
          <div class="empty-orbit"></div>
          <strong>暂无狙击钱包</strong>
          <p>添加钱包地址后，系统将监控这些钱包的链上活动并自动狙击。</p>
        </div>
      </section>
    </div>

    <!-- ═══════════════ Right Column: Config ═══════════════ -->
    <div class="sniper-col">
      <!-- Sniper Config -->
      <section class="settings-section">
        <h2>🎯 狙击参数</h2>
        <p class="settings-desc">
          狙击专用参数。Gas 越高越容易被打包，滑点越大容忍度越高。
        </p>

        <div class="trading-config-grid">
          <div class="config-row">
            <label>狙击 Gas Price (Gwei)</label>
            <input v-model="sniper.gasPriceGwei" type="text" placeholder="10" />
            <span class="config-hint" v-if="sniper.gasPriceGwei">
              ≈ {{ gasBnb(sniper.gasPriceGwei, 300000).toFixed(6) }} BNB
              (≈ ${{ gasUsd(sniper.gasPriceGwei, 300000).toFixed(2) }})
            </span>
            <span class="config-hint" v-else></span>
          </div>

          <div class="config-row">
            <label>狙击滑点 (%)</label>
            <input v-model="sniper.slippagePercent" type="text" placeholder="30" />
            <span class="config-hint">交易最大可接受滑点</span>
          </div>

          <div class="config-row">
            <label>狙击买入金额 (BNB)</label>
            <input v-model="sniper.orderAmountBnb" type="text" placeholder="0.01" />
            <span class="config-hint">每笔狙击买入的 BNB 数量</span>
          </div>

          <div class="config-row">
            <label>狙击冷却 (秒)</label>
            <input v-model="sniper.cooldownSeconds" type="text" placeholder="600" />
            <span class="config-hint">同一代币两次狙击的最小间隔</span>
          </div>
        </div>

        <div class="config-actions">
          <button class="btn-primary" @click="saveSniperConfig">保存狙击参数</button>
        </div>
      </section>

      <!-- Trading Config -->
      <section class="settings-section">
        <h2>⚙️ 交易参数</h2>
        <p class="settings-desc">
          全局交易参数，控制各路由的 Gas 和滑点。
        </p>

        <div class="trading-config-grid">
          <div class="config-row">
            <label>Gas Price (Gwei)</label>
            <input v-model="trading.gasPriceGwei" type="text" placeholder="5" />
            <span class="config-hint" v-if="trading.gasPriceGwei">
              ≈ {{ gasBnb(trading.gasPriceGwei, 300000).toFixed(6) }} BNB
              (≈ ${{ gasUsd(trading.gasPriceGwei, 300000).toFixed(2) }})
            </span>
            <span class="config-hint" v-else></span>
          </div>

          <div class="config-row">
            <label>Four.meme 内盘</label>
            <input v-model="trading.fourmemeInner" type="text" placeholder="5" />
            <span class="config-hint" v-if="trading.fourmemeInner">
              ≈ {{ gasBnb(trading.fourmemeInner, 500000).toFixed(6) }} BNB
              (≈ ${{ gasUsd(trading.fourmemeInner, 500000).toFixed(2) }})
            </span>
            <span class="config-hint" v-else></span>
          </div>

          <div class="config-row">
            <label>Flap.sh 内盘</label>
            <input v-model="trading.flapInner" type="text" placeholder="5" />
            <span class="config-hint" v-if="trading.flapInner">
              ≈ {{ gasBnb(trading.flapInner, 500000).toFixed(6) }} BNB
              (≈ ${{ gasUsd(trading.flapInner, 500000).toFixed(2) }})
            </span>
            <span class="config-hint" v-else></span>
          </div>

          <div class="config-row">
            <label>OKX DEX 外盘</label>
            <input v-model="trading.okxDex" type="text" placeholder="5" />
            <span class="config-hint" v-if="trading.okxDex">
              ≈ {{ gasBnb(trading.okxDex, 300000).toFixed(6) }} BNB
              (≈ ${{ gasUsd(trading.okxDex, 300000).toFixed(2) }})
            </span>
            <span class="config-hint" v-else></span>
          </div>

          <div class="config-row">
            <label>Gas 上限 (BNB)</label>
            <input v-model="trading.maxGasCostBnb" type="text" placeholder="0.005" />
            <span class="config-hint">单笔交易最大 Gas 花费</span>
          </div>

          <div class="config-row">
            <label>买入滑点 (%)</label>
            <input v-model="trading.buySlippagePercent" type="text" placeholder="30" />
            <span class="config-hint">外盘买入滑点容忍度</span>
          </div>

          <div class="config-row">
            <label>卖出滑点 (%)</label>
            <input v-model="trading.sellSlippagePercent" type="text" placeholder="30" />
            <span class="config-hint">卖出滑点容忍度</span>
          </div>

          <div class="config-row">
            <label>二次买入冷却 (秒)</label>
            <input v-model="trading.secondBuyCooldownSeconds" type="number" min="10" step="10" placeholder="600" />
            <span class="config-hint">第1次→第2次：首次买入后的等待间隔</span>
          </div>

          <div class="config-row">
            <label>三次买入冷却 (秒)</label>
            <input v-model="trading.defaultCooldownSeconds" type="number" min="10" step="10" placeholder="600" />
            <span class="config-hint">第2次→第3次：第二次买入后的等待间隔</span>
          </div>

          <div class="config-row">
            <label>共振触发限流 (秒)</label>
            <input v-model="trading.resonanceTriggerThrottleSeconds" type="number" min="0" step="1" placeholder="4" />
            <span class="config-hint">全局限流：N 秒内只触发一次共振买入，第二次忽略</span>
          </div>

          <div class="config-row">
            <label>信心检查 (秒)</label>
            <input v-model="trading.confidenceCheckSeconds" type="number" min="0" step="1" placeholder="10" />
            <span class="config-hint">共振买入后 N 秒内无其他钱包跟进则立即卖出，0=禁用</span>
          </div>
        </div>

        <p class="settings-hint" v-if="trading.gasPriceGwei">
          Gas 参考: <strong>{{ gasBnb(trading.gasPriceGwei, 300000).toFixed(6) }} BNB</strong>
          ≈ ${{ gasUsd(trading.gasPriceGwei, 300000).toFixed(2) }} (300k gas)
        </p>

        <div class="config-actions">
          <button class="btn-primary" @click="saveTradingConfig">保存交易参数</button>
        </div>
      </section>
    </div>
  </div>
</template>

<script>
import state, { showToast } from '../../stores/dashboard.js'
import { api } from '../../api/index.js'
import { shortAddress } from '../../composables/useFormat.js'

export default {
  name: 'SniperTab',

  setup() {
    return { state, showToast, shortAddress }
  },

  data() {
    return {
      devWallets: [],
      newWallet: '',
      sniper: {
        gasPriceGwei: '',
        slippagePercent: '30',
        orderAmountBnb: '',
        cooldownSeconds: 600,
      },
      trading: {
        gasPriceGwei: '',
        fourmemeInner: '',
        flapInner: '',
        okxDex: '',
        maxGasCostBnb: '',
        buySlippagePercent: '',
        sellSlippagePercent: '',
        secondBuyCooldownSeconds: 600,
        defaultCooldownSeconds: 600,
        resonanceTriggerThrottleSeconds: 4,
        confidenceCheckSeconds: 10,
      },
    }
  },

  mounted() {
    this.loadDevWallets()
    this.loadTradingConfig()
  },

  methods: {
    // ── Gas hint ──
    gasBnb(gwei, gasUsed) {
      const g = parseFloat(gwei)
      if (isNaN(g)) return 0
      return (g * gasUsed) / 1e9
    },

    gasUsd(gwei, gasUsed) {
      return this.gasBnb(gwei, gasUsed) * 600
    },

    // ── Dev Wallets ──
    async loadDevWallets() {
      try {
        const res = await api.getDevWallets()
        this.devWallets = res.wallets || []
      } catch (e) {
        this.showToast('加载钱包失败: ' + e.message)
      }
    },

    async addWallet() {
      const addr = this.newWallet.trim()
      if (!addr) return
      try {
        await api.addDevWallet(addr)
        this.newWallet = ''
        await this.loadDevWallets()
        this.showToast('钱包已添加')
      } catch (e) {
        this.showToast('添加失败: ' + e.message)
      }
    },

    async removeWallet(wallet) {
      try {
        await api.removeDevWallet(wallet)
        await this.loadDevWallets()
        this.showToast('钱包已移除')
      } catch (e) {
        this.showToast('移除失败: ' + e.message)
      }
    },

    downloadWallets() {
      if (!this.devWallets.length) {
        this.showToast('钱包列表为空')
        return
      }
      const text = this.devWallets.join('\n')
      const blob = new Blob([text], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'dev-wallets.txt'
      a.click()
      URL.revokeObjectURL(url)
      this.showToast('已下载')
    },

    copyAddress(addr) {
      navigator.clipboard.writeText(addr).then(() => {
        this.showToast('已复制: ' + shortAddress(addr))
      }).catch(() => {
        this.showToast('复制失败')
      })
    },

    // ── Trading Config ──
    async loadTradingConfig() {
      try {
        const cfg = await api.getTradingConfig()
        this.sniper.gasPriceGwei = cfg.sniperGasPriceGwei ?? ''
        this.sniper.slippagePercent = cfg.sniperSlippagePercent ?? '30'
        this.sniper.orderAmountBnb = cfg.sniperOrderAmountBnb ?? ''
        this.sniper.cooldownSeconds = cfg.sniperCooldownSeconds ?? 600

        this.trading.gasPriceGwei = cfg.gasPriceGwei ?? ''
        this.trading.fourmemeInner = cfg.gasPriceByRoute?.fourmeme_inner ?? ''
        this.trading.flapInner = cfg.gasPriceByRoute?.flap_inner ?? ''
        this.trading.okxDex = cfg.gasPriceByRoute?.okx_dex ?? ''
        this.trading.maxGasCostBnb = cfg.maxGasCostBnb ?? ''
        this.trading.buySlippagePercent = cfg.buySlippagePercent ?? ''
        this.trading.sellSlippagePercent = cfg.sellSlippagePercent ?? ''
        this.trading.secondBuyCooldownSeconds = cfg.secondBuyCooldownSeconds ?? 600
        this.trading.defaultCooldownSeconds = cfg.defaultCooldownSeconds ?? 600
        this.trading.resonanceTriggerThrottleSeconds = cfg.resonanceTriggerThrottleSeconds ?? 4
        this.trading.confidenceCheckSeconds = cfg.confidenceCheckSeconds ?? 10
      } catch (e) {
        this.showToast('加载配置失败: ' + e.message)
      }
    },

    async saveSniperConfig() {
      try {
        await api.saveTradingConfig({
          sniperGasPriceGwei: this.sniper.gasPriceGwei,
          sniperSlippagePercent: this.sniper.slippagePercent,
          sniperOrderAmountBnb: this.sniper.orderAmountBnb,
          sniperCooldownSeconds: this.sniper.cooldownSeconds,
        })
        this.showToast('狙击参数已保存')
      } catch (e) {
        this.showToast('保存失败: ' + e.message)
      }
    },

    async saveTradingConfig() {
      try {
        await api.saveTradingConfig({
          gasPriceGwei: this.trading.gasPriceGwei,
          gasPriceByRoute: {
            fourmeme_inner: this.trading.fourmemeInner,
            flap_inner: this.trading.flapInner,
            okx_dex: this.trading.okxDex,
          },
          maxGasCostBnb: this.trading.maxGasCostBnb,
          buySlippagePercent: this.trading.buySlippagePercent,
          sellSlippagePercent: this.trading.sellSlippagePercent,
          secondBuyCooldownSeconds: Number(this.trading.secondBuyCooldownSeconds),
          defaultCooldownSeconds: Number(this.trading.defaultCooldownSeconds),
          resonanceTriggerThrottleSeconds: Number(this.trading.resonanceTriggerThrottleSeconds),
          confidenceCheckSeconds: Number(this.trading.confidenceCheckSeconds),
        })
        this.showToast('交易参数已保存')
      } catch (e) {
        this.showToast('保存失败: ' + e.message)
      }
    },
  },
}
</script>
