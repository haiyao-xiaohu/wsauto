<template>
  <div class="toast" :class="{ show: store.toastVisible }" role="status" aria-live="polite">
    {{ store.toast }}
  </div>
</template>

<script>
import state from '../stores/dashboard.js'
export default { setup() { return { store: state } } }
</script>
