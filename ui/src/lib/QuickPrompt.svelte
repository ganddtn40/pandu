<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { closeQuickPrompt, quickPromptState } from './quick-prompt.svelte';
  import { toast } from './toast-store.svelte';

  const agents = [
    { id: 'opencode', label: 'opencode' },
    { id: 'claude-code', label: 'claude-code' },
    { id: 'codex', label: 'codex' },
  ];

  let text = $state('');
  let agent = $state('opencode');
  let textarea = $state<HTMLTextAreaElement | null>(null);

  $effect(() => {
    if (!quickPromptState.open) return;
    text = '';
    void tick().then(() => textarea?.focus());
  });

  function send(): void {
    const value = text.trim();
    if (!value) {
      textarea?.focus();
      return;
    }
    const preview = value.length > 56 ? `${value.slice(0, 56)}…` : value;
    toast(`Queued for ${agent}: “${preview}” · live sending arrives in Phase 5.`);
    closeQuickPrompt();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!quickPromptState.open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeQuickPrompt();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      send();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if quickPromptState.open}
  <div
    class="sheet-scrim sheet-scrim--quick"
    role="presentation"
    onclick={closeQuickPrompt}
    onkeydown={(event) => {
      if (event.key === 'Escape') closeQuickPrompt();
    }}
  >
    <div
      class="quick-prompt float"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-prompt-title"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeQuickPrompt();
        }
        event.stopPropagation();
      }}
    >
      <header class="quick-prompt__head">
        <div>
          <p class="kicker">Quick prompt</p>
          <h2 id="quick-prompt-title">Ask your agent anything</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close quick prompt" onclick={closeQuickPrompt}>
          <Icon name="close" size={19} />
        </button>
      </header>

      <label class="quick-prompt__field">
        <span class="sr-only">Prompt</span>
        <textarea
          bind:this={textarea}
          bind:value={text}
          rows="4"
          placeholder="Explain this stack trace, fix the failing test, summarize this folder…"
          spellcheck="false"
        ></textarea>
      </label>

      <div class="quick-prompt__meta">
        <div class="agent-chips" role="group" aria-label="Agent">
          {#each agents as option}
            <button
              class="chip"
              class:is-active={agent === option.id}
              type="button"
              aria-pressed={agent === option.id}
              onclick={() => (agent = option.id)}
            >
              <span class="dot dot--live"></span>
              {option.label}
            </button>
          {/each}
        </div>
        <span class="quick-prompt__hint">Ctrl Enter to send</span>
      </div>

      <footer class="quick-prompt__foot">
        <span class="quick-prompt__note">
          <Icon name="lock" size={14} />
          Stays on this machine
        </span>
        <button class="btn btn--primary" type="button" onclick={send} disabled={!text.trim()}>
          <Icon name="send" size={16} />
          Send
        </button>
      </footer>
    </div>
  </div>
{/if}
