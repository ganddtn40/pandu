<script lang="ts">
  import { toastState } from './toast-store.svelte';
</script>

{#if toastState.message}
  {#key toastState.id}
    <div
      class="toast"
      role="status"
    >
      {toastState.message}
    </div>
  {/key}
{/if}
