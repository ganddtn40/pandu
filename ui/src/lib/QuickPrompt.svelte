<script lang="ts">
  import { tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { daemonState } from './api/daemon.svelte';
  import { CLI_COMMAND } from './brand';
  import { copyText } from './clipboard';
  import { t } from './i18n/i18n.svelte';
  import { closeQuickPrompt, quickPromptState } from './quick-prompt.svelte';
  import { toast } from './toast-store.svelte';

  let text = $state('');
  let agentId = $state('');
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let copied = $state<'command' | 'prompt' | null>(null);

  const agents = $derived(daemonState.adapters);
  const selected = $derived(agents.find((adapter) => adapter.id === agentId) ?? agents[0]);
  const command = $derived(selected ? `${CLI_COMMAND} run -- ${selected.command}` : '');

  $effect(() => {
    if (!quickPromptState.open) return;
    // Reset only when the sheet opens. Reading `agents` here would make a
    // daemon refresh clear whatever the user has typed.
    untrack(() => {
      text = '';
      copied = null;
      agentId = agents.find((adapter) => adapter.installed)?.id ?? agents[0]?.id ?? '';
      void tick().then(() => textarea?.focus());
    });
  });

  async function copyCommand(): Promise<void> {
    if (!command) return;
    const ok = await copyText(command);
    if (!ok) {
      toast(t('common.copyFailed'));
      return;
    }
    copied = 'command';
    toast(t('quick.copiedCommand'));
    window.setTimeout(() => {
      if (copied === 'command') copied = null;
    }, 1800);
  }

  async function copyPrompt(): Promise<void> {
    const value = text.trim();
    if (!value) {
      textarea?.focus();
      return;
    }
    const ok = await copyText(value);
    if (!ok) {
      toast(t('common.copyFailed'));
      return;
    }
    copied = 'prompt';
    toast(t('quick.copiedPrompt'));
    window.setTimeout(() => {
      if (copied === 'prompt') copied = null;
    }, 1800);
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
      void copyCommand();
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
          <p class="kicker">{t('quick.kicker')}</p>
          <h2 id="quick-prompt-title">{t('quick.title')}</h2>
        </div>
        <button class="icon-button" type="button" aria-label={t('common.close')} onclick={closeQuickPrompt}>
          <Icon name="close" size={19} />
        </button>
      </header>

      <label class="quick-prompt__field">
        <span class="sr-only">{t('quick.placeholder')}</span>
        <textarea
          bind:this={textarea}
          bind:value={text}
          rows="4"
          placeholder={t('quick.placeholder')}
          spellcheck="false"
        ></textarea>
      </label>

      <div class="quick-prompt__meta">
        {#if agents.length > 0}
          <div class="agent-chips" role="group" aria-label={t('quick.agent')}>
            {#each agents as option (option.id)}
              <button
                class="chip"
                class:is-active={selected?.id === option.id}
                type="button"
                aria-pressed={selected?.id === option.id}
                onclick={() => (agentId = option.id)}
              >
                <span class="dot" class:dot--live={option.installed}></span>
                {option.name}
              </button>
            {/each}
          </div>
        {:else}
          <p class="quick-prompt__hint">{t('quick.noAgents')}</p>
        {/if}
        <span class="quick-prompt__hint">{t('quick.hint')}</span>
      </div>

      {#if command}
        <div class="quick-prompt__command">
          <span>{t('quick.commandPreview')}</span>
          <code>{command}</code>
        </div>
      {/if}

      <footer class="quick-prompt__foot">
        <span class="quick-prompt__note">
          <Icon name="lock" size={14} />
          {t('quick.copyCommandNote')}
        </span>
        <div class="quick-prompt__actions">
          <button
            class="btn btn--ghost"
            type="button"
            onclick={copyPrompt}
            disabled={!text.trim()}
          >
            <Icon name={copied === 'prompt' ? 'check' : 'copy'} size={16} />
            {t('quick.copyPrompt')}
          </button>
          <button class="btn btn--primary" type="button" onclick={copyCommand} disabled={!command}>
            <Icon name={copied === 'command' ? 'check' : 'terminal'} size={16} />
            {t('quick.copyCommand')}
          </button>
        </div>
      </footer>
    </div>
  </div>
{/if}
