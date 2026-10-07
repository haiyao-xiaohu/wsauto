<template>
  <div>
    <!-- ═══════════════ Hero ═══════════════ -->
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">
          <span class="eyebrow-dot"></span>
          QUICKNODE WEBHOOK · SMART MONEY RESONANCE
        </div>
        <h1>
          捕捉聪明钱的
          <span>同步动作</span>
        </h1>
        <p>
          只接收钱包买入事件。当多个聪明钱钱包在时间窗口内买入同一代币，
          系统自动检测平台路由并执行交易。支持 Four.meme、Flap.sh 内盘和 OKX DEX。
        </p>
        <div class="hero-meta">
          <div>
            <span>运行模式</span>
            <strong>{{ modeLabel }}</strong>
          </div>
          <div>
            <span>共振阈值</span>
            <strong>{{ cfg.threshold }} WALLETS</strong>
          </div>
          <div>
            <span>观察窗口</span>
            <strong>{{ cfg.windowSeconds }} SEC</strong>
          </div>
        </div>
      </div>

      <aside class="radar-card">
        <div class="radar-head">
          <span>LIVE SIGNAL RADAR</span>
          <span class="live-label"><i></i> LIVE</span>
        </div>
        <div class="radar-visual" aria-hidden="true">
          <div class="radar-ring ring-one"></div>
          <div class="radar-ring ring-two"></div>
          <div class="radar-ring ring-three"></div>
          <div class="radar-cross cross-x"></div>
          <div class="radar-cross cross-y"></div>
          <div class="radar-sweep"></div>
          <div class="radar-core"></div>
          <div class="radar-blip blip-one"></div>
          <div class="radar-blip blip-two"></div>
        </div>
        <div class="radar-footer">
          <div>
            <span>活跃观察</span>
            <strong>{{ activeWindows.length }}</strong>
          </div>
          <div>
            <span>最近回调</span>
            <strong>{{ timeAgo(metrics.lastWebhookAtMs) }}</strong>
          </div>
        </div>
      </aside>
    </section>

    <!-- ═══════════════ Pipeline ═══════════════ -->
    <section class="pipeline" aria-label="信号处理链路">
      <article class="pipeline-step is-active">
        <span class="step-number">01</span>
        <div>
          <strong>Webhook 接收</strong>
          <small>QuickNode matchingReceipts</small>
        </div>
      </article>
      <span class="pipeline-arrow">→</span>
      <article class="pipeline-step">
        <span class="step-number">02</span>
        <div>
          <strong>买入识别</strong>
          <small>成功交易 · 代币净流入</small>
        </div>
      </article>
      <span class="pipeline-arrow">→</span>
      <article class="pipeline-step">
        <span class="step-number">03</span>
        <div>
          <strong>共振检测</strong>
          <small>同币 · 异钱包 · 时间窗口</small>
        </div>
      </article>
      <span class="pipeline-arrow">→</span>
      <article class="pipeline-step">
        <span class="step-number">04</span>
        <div>
          <strong>平台路由</strong>
          <small>Four.meme · Flap.sh · OKX</small>
        </div>
      </article>
      <span class="pipeline-arrow">→</span>
      <article class="pipeline-step">
        <span class="step-number">05</span>
        <div>
          <strong>交易执行</strong>
          <small>签名广播 · 自动卖出</small>
        </div>
      </article>
    </section>

    <!-- ═══════════════ Metrics Grid ═══════════════ -->
    <section class="metrics-grid" aria-label="核心指标">
      <article class="metric-card">
        <div class="metric-label"><span class="mini-icon">W</span>WEBHOOK</div>
        <strong>{{ formatNumber(metrics.webhookDeliveries) }}</strong>
        <small>累计有效回调</small>
        <div class="metric-line"></div>
      </article>
      <article class="metric-card">
        <div class="metric-label"><span class="mini-icon">B</span>BUY SIGNALS</div>
        <strong>{{ formatNumber(metrics.extractedSignals) }}</strong>
        <small>识别出的买入操作</small>
        <div class="metric-line"></div>
      </article>
      <article class="metric-card highlight">
        <div class="metric-label"><span class="mini-icon">R</span>RESONANCE</div>
        <strong>{{ formatNumber(metrics.triggerCount) }}</strong>
        <small>共振触发次数</small>
        <div class="metric-line"></div>
      </article>
      <article class="metric-card">
        <div class="metric-label"><span class="mini-icon">T</span>TARGETS</div>
        <strong>{{ formatNumber(metrics.okxBuiltCount) }}</strong>
        <small>路由构建成功</small>
        <div class="metric-line"></div>
      </article>
    </section>

    <!-- ═══════════════ Bottom: System Status + Active Windows ═══════════════ -->
    <section class="overview-bottom">
      <!-- System Status -->
      <aside class="panel system-panel">
        <div class="panel-head">
          <div>
            <span class="section-kicker">SYSTEM STATUS</span>
            <h2>链路状态</h2>
          </div>
        </div>
        <div class="status-stack">
          <!-- QuickNode Webhook -->
          <div class="status-row">
            <span class="status-symbol ready">Q</span>
            <div>
              <strong>QuickNode Webhook</strong>
              <small>{{ metrics.lastWebhookAtMs ? timeAgo(metrics.lastWebhookAtMs) : '等待数据' }}</small>
            </div>
            <span class="status-value">READY</span>
          </div>

          <!-- Wallet Filter -->
          <div class="status-row">
            <span class="status-symbol ready">F</span>
            <div>
              <strong>钱包过滤</strong>
              <small>{{ walletFilterLabel }}</small>
            </div>
            <span class="status-value">ACTIVE</span>
          </div>

          <!-- Resonance Engine -->
          <div class="status-row">
            <span class="status-symbol ready">R</span>
            <div>
              <strong>共振引擎</strong>
              <small>{{ cfg.threshold }} 钱包 / {{ cfg.windowSeconds }} 秒</small>
            </div>
            <span class="status-value">ARMED</span>
          </div>

          <!-- Platform Route -->
          <div class="status-row">
            <span class="status-symbol ready">P</span>
            <div>
              <strong>平台路由</strong>
              <small>Four.meme · Flap.sh · OKX DEX</small>
            </div>
            <span class="status-value">READY</span>
          </div>

          <!-- Transaction Execution -->
          <div class="status-row">
            <span class="status-symbol" :class="execSymbolClass">{{ execSymbolLetter }}</span>
            <div>
              <strong>交易执行</strong>
              <small>{{ execDesc }}</small>
            </div>
            <span class="status-value">{{ execValue }}</span>
          </div>

          <!-- Auto Sell -->
          <div class="status-row">
            <span class="status-symbol" :class="autoSellSymbolClass">S</span>
            <div>
              <strong>自动卖出</strong>
              <small>{{ autoSellDesc }}</small>
            </div>
            <span class="status-value">{{ autoSellValue }}</span>
          </div>
        </div>

        <!-- Safety note (dry run) -->
        <div v-if="!cfg.isLive" class="safety-note">
          <span>!</span>
          <p>
            当前为安全干跑模式。系统不会签名或广播任何交易。
            开启真实交易需设置 LIVE_TRADING + WEBHOOK_LIVE_TRADING。
          </p>
        </div>
      </aside>

      <!-- Active Windows -->
      <article class="panel observation-panel">
        <div class="panel-head">
          <div>
            <span class="section-kicker">ACTIVE WINDOWS</span>
            <h2>实时共振观察</h2>
          </div>
          <span class="panel-count">{{ activeWindows.length }} ACTIVE</span>
        </div>
        <div class="window-list">
          <template v-if="activeWindows.length">
            <article
              v-for="w in activeWindows"
              :key="w.tokenAddress"
              class="window-card"
            >
              <!-- 进度条：walletCount / threshold -->
              <div
                class="window-progress"
                :style="{ '--progress': windowProgress(w) + '%' }"
              >
                {{ w.walletCount }}/{{ cfg.threshold }}
              </div>

              <!-- 代币 + 钱包chips + 时间 -->
              <div>
                <div class="token-line">
                  <strong>{{ shortAddr(w.tokenAddress, 9, 6) }}</strong>
                  <a
                    :href="`${chainExplorerBase(state.activeChain, 'token')}/${w.tokenAddress}`"
                    target="_blank" rel="noopener" class="token-link"
                  >{{ shortAddr(w.tokenAddress, 9, 6) }}</a>
                </div>
                <div class="wallet-line">
                  <a
                    v-for="sig in (w.signals || [])"
                    :key="sig.walletAddress"
                    class="wallet-chip"
                    :href="walletUrl(sig.walletAddress)"
                    target="_blank" rel="noopener"
                  >{{ windowWalletLabel(sig.walletAddress) }}</a>
                </div>
                <div class="window-meta">
                  FIRST {{ localTime(w.firstSeenAtMs) }}
                  <span v-if="w.lastSeenAtMs"> · LAST {{ localTime(w.lastSeenAtMs) }}</span>
                </div>
              </div>

              <!-- 倒计时 -->
              <div class="window-timer">
                {{ windowRemaining(w) }}s
                <small>WINDOW LEFT</small>
              </div>
            </article>
          </template>
          <div v-else class="empty-state">
            <span class="empty-orbit"></span>
            <strong>等待第一个买入信号</strong>
            <p>检测到聪明钱钱包买入后，共振窗口会出现在这里。</p>
          </div>
        </div>
      </article>
    </section>

    <!-- ═══════════════ System Support ═══════════════ -->
    <section class="system-support" aria-label="系统支持">
      <div class="panel support-panel">
        <div class="panel-head">
          <div>
            <span class="section-kicker">SUPPORTED INFRASTRUCTURE</span>
            <h2>链 · 平台 · 协议</h2>
          </div>
        </div>
        <div class="support-grid">
          <!-- 链 -->
          <div class="support-section">
            <h3>链 (Chains)</h3>
            <div class="support-tags">
              <span
                v-for="c in chains"
                :key="c.name"
                class="tag"
                :class="c.active ? 'tag-active' : 'tag-inactive'"
              >
                {{ c.name }}
                <span v-if="c.badge" class="tag-badge">{{ c.badge }}</span>
              </span>
            </div>
          </div>

          <!-- 平台 -->
          <div class="support-section">
            <h3>交易平台 (Platforms)</h3>
            <div class="support-tags">
              <span class="tag tag-active">Four.meme<span class="tag-badge">内盘</span></span>
              <span class="tag tag-active">Flap.sh<span class="tag-badge">内盘</span></span>
              <span class="tag tag-active">OKX DEX<span class="tag-badge">外盘</span></span>
            </div>
          </div>

          <!-- 协议 -->
          <div class="support-section">
            <h3>协议 / 功能</h3>
            <div class="support-tags">
              <span class="tag tag-feature">QuickNode Webhook</span>
              <span class="tag tag-feature">Bonding Curve</span>
              <span class="tag tag-feature">PancakeSwap</span>
              <span class="tag tag-feature">自动卖出</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script>
import state, { chainConfig } from '../../stores/dashboard.js'
import { formatNumber, timeAgo, localTime } from '../../composables/useFormat.js'
import { inferChain, chainCurrency, chainExplorerBase } from '../../composables/useChain.js'

function shortAddr(addr, left = 6, right = 4) {
  if (!addr || addr.length <= left + right) return addr || '—'
  return `${addr.slice(0, left)}…${addr.slice(-right)}`
}

export default {
  name: 'OverviewTab',

  setup() {
    return { state, chainConfig, formatNumber, timeAgo, localTime, inferChain, chainCurrency, shortAddr, chainExplorerBase }
  },

  computed: {
    d() {
      return this.state.data
    },

    cfg() {
      return this.chainConfig
    },

    metrics() {
      const m = this.d?.metrics
      return {
        webhookDeliveries: m?.webhookDeliveries ?? 0,
        extractedSignals: m?.extractedSignals ?? 0,
        triggerCount: m?.triggerCount ?? 0,
        okxBuiltCount: m?.okxBuiltCount ?? 0,
        lastWebhookAtMs: m?.lastWebhookAtMs ?? 0,
        activeWindows: m?.activeWindows ?? [],
        cooldownTokens: m?.cooldownTokens ?? [],
      }
    },

    activeWindows() {
      return this.metrics.activeWindows
    },

    modeLabel() {
      return this.cfg.isLive ? 'LIVE' : 'DRY RUN'
    },

    walletFilterLabel() {
      const wf = this.d?.config?.walletFilter
      if (wf) return wf
      return '上游过滤'
    },

    // ── Execution status ──

    execSymbolClass() {
      return this.cfg.isLive ? 'ready' : 'guarded'
    },

    execSymbolLetter() {
      return 'E'
    },

    execDesc() {
      if (this.cfg.isLive) {
        return `${this.chainCurrency(this.state.activeChain)} 签名广播模式`
      }
      return '安全干跑模式'
    },

    execValue() {
      return this.cfg.isLive ? 'LIVE' : 'SAFE'
    },

    // ── Auto sell ──

    autoSell() {
      return this.d?.autoSell || {}
    },

    autoSellSymbolClass() {
      if (this.state.activeChain === 'rob') return 'guarded'
      return this.autoSell.enabled ? 'ready' : 'guarded'
    },

    autoSellDesc() {
      if (this.state.activeChain === 'rob') return 'ROB 链暂不支持自动卖出'
      const tp = this.autoSell.takeProfitPercent ?? 100
      const sl = this.autoSell.stopLossPercent ?? 50
      return `涨${tp}%出本 · 跌${sl}%止损`
    },

    autoSellValue() {
      if (this.state.activeChain === 'rob') return 'OFF'
      return this.autoSell.enabled ? 'ARMED' : 'STANDBY'
    },

    // ── Chains list ──

    chains() {
      const active = this.state.activeChain
      return [
        { name: 'BSC', active: active === 'bsc', badge: active === 'bsc' ? '主运行' : '' },
        { name: 'ROB', active: active === 'rob', badge: active === 'rob' ? '主运行' : '' },
        { name: 'Ethereum', active: false, badge: '' },
        { name: 'Base', active: false, badge: '' },
        { name: 'Solana', active: false, badge: '' },
      ]
    },
  },

  methods: {
    /** Window progress % = walletCount / threshold * 100 */
    windowProgress(w) {
      const threshold = Math.max(1, this.cfg.threshold)
      return Math.min(100, (w.walletCount / threshold) * 100)
    },

    /** Remaining seconds until window expires */
    windowRemaining(w) {
      if (!w.expiresAtMs) return 0
      return Math.max(0, Math.floor((w.expiresAtMs - Date.now()) / 1000))
    },

    /** Explorer URL for wallet address (chain-aware) */
    walletUrl(address) {
      if (!address) return '#'
      if (this.state.activeChain === 'rob') {
        return `https://robinhoodchain.blockscout.com/address/${address}`
      }
      return `https://bscscan.com/address/${address}`
    },

    /** Wallet label from walletBook or short address */
    windowWalletLabel(address) {
      if (!address) return '—'
      const book = this.state.data?.walletBook || {}
      const entry = book[address.toLowerCase()]
      if (entry) {
        const name = (entry.name || entry.emoji || '').trim()
        if (name) return name
      }
      return shortAddr(address)
    },
  },
}
</script>
