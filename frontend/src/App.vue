<template>
  <div class="noise" aria-hidden="true"></div>
  <div class="glow glow-a" aria-hidden="true"></div>
  <div class="glow glow-b" aria-hidden="true"></div>

  <TopBar />

  <main>
    <OverviewTab v-if="store.activeTab === 'overview'" />
    <SignalsTab v-else-if="store.activeTab === 'signals'" />
    <PositionsTab v-else-if="store.activeTab === 'positions'" />
    <LogsTab v-else-if="store.activeTab === 'logs'" />
    <SniperTab v-else-if="store.activeTab === 'sniper'" />
    <AnalysisTab v-else-if="store.activeTab === 'analysis'" />
    <SettingsTab v-else-if="store.activeTab === 'settings'" />
  </main>

  <footer>
    <span>RESONANCE RADAR · MULTI-CHAIN · LOCAL CONTROL PLANE</span>
    <span>{{ uptime }}</span>
  </footer>

  <Toast />
</template>

<script>
import { onMounted, onUnmounted, ref } from 'vue'
import state, {
  connectSSE, connectLogSSE, loadState, initAlerts, showToast,
} from './stores/dashboard.js'
import { formatDuration } from './composables/useFormat.js'
import TopBar from './components/TopBar.vue'
import Toast from './components/Toast.vue'
import OverviewTab from './components/tabs/OverviewTab.vue'
import SignalsTab from './components/tabs/SignalsTab.vue'
import PositionsTab from './components/tabs/PositionsTab.vue'
import LogsTab from './components/tabs/LogsTab.vue'
import SniperTab from './components/tabs/SniperTab.vue'
import AnalysisTab from './components/tabs/AnalysisTab.vue'
import SettingsTab from './components/tabs/SettingsTab.vue'

export default {
  components: {
    TopBar, Toast,
    OverviewTab, SignalsTab, PositionsTab, LogsTab,
    SniperTab, AnalysisTab, SettingsTab,
  },
  setup() {
    let uptimeInterval = null
    const nowMs = ref(Date.now())

    // Tick every second so computed 'uptime' re-evaluates
    onMounted(async () => {
      initAlerts()
      try {
        await loadState()
        connectSSE()
        connectLogSSE()
      } catch {
        showToast('无法连接后端')
      }
      uptimeInterval = setInterval(() => { nowMs.value = Date.now() }, 1000)
    })

    onUnmounted(() => { clearInterval(uptimeInterval) })

    return { store: state, nowMs }
  },
  computed: {
    uptime() {
      if (!this.store.data) return 'UPTIME 00:00:00'
      return `UPTIME ${formatDuration(this.nowMs - this.store.data.startedAtMs)}`
    },
  },
}
</script>
