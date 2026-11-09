<script lang="ts">
  import { dismissToast, toastState } from './toast-store.svelte';

  function runAction(): void {
    const action = toastState.action;
    dismissToast();
    action?.run();
  }
</script>

{#if toastState.message}
  {#key toastState.id}
    <div class="toast" role="status" data-testid="toast">
      <span>{toastState.message}</span>
      {#if toastState.action}
        <button
          class="toast__action"
          type="button"
          data-testid="toast-action"
          onclick={runAction}
        >
          {toastState.action.label}
        </button>
      {/if}
    </div>
  {/key}
{/if}
