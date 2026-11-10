<script lang="ts">
  import Icon from './Icon.svelte';
  import { addAgentState, closeAddAgent } from './add-agent.svelte';
  import { daemonState } from './api/daemon.svelte';
  import type { AdapterStatus } from './api/types';
  import { CLI_COMMAND } from './brand';
  import { copyText } from './clipboard';
  import { t } from './i18n/i18n.svelte';
  import { toast } from './toast-store.svelte';

  let copiedId = $state<string | null>(null);

  const online = $derived(daemonState.status === 'online');
  const installed = $derived(daemonState.adapters.filter((adapter) => adapter.installed).length);

  function commandFor(adapter: AdapterStatus): string {
    return `${CLI_COMMAND} run -- ${adapter.command}`;
  }

  async function copy(adapter: AdapterStatus): Promise<void> {
    const copied = await copyText(commandFor(adapter));
    copiedId = copied ? adapter.id : null;
    toast(copied ? t('addAgent.copied') : t('common.copyFailed'));
    window.setTimeout(() => {
      if (copiedId === adapter.id) copiedId = null;
    }, 1800);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!addAgentState.open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAddAgent();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if addAgentState.open}
  <div
    class="sheet-scrim"
    role="presentation"
    onclick={closeAddAgent}
  >
    <div
      class="sheet add-agent"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-agent-title"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => event.stopPropagation()}
    >
      <header class="sheet__head">
        <div>
          <p class="kicker">{t('addAgent.kicker')}</p>
          <h2 id="add-agent-title">{t('addAgent.title')}</h2>
          <p class="sheet__lede">{t('addAgent.body')}</p>
        </div>
        <button class="icon-button" type="button" aria-label={t('addAgent.close')} onclick={closeAddAgent}>
          <Icon name="close" size={19} />
        </button>
      </header>

      <div class="sheet__body">
        {#if !online}
          <div class="empty-inline">
            <Icon name="alert" size={18} />
            <p>{t('addAgent.offline')}</p>
          </div>
        {:else if daemonState.adapters.length === 0}
          <div class="empty-inline">
            <Icon name="info" size={18} />
            <p>{t('addAgent.empty')}</p>
          </div>
        {:else}
          <p class="add-agent__count">
            {t('settings.installed', { installed, total: daemonState.adapters.length })}
          </p>
          <div class="adapter-list">
            {#each daemonState.adapters as adapter (adapter.id)}
              <article class="adapter-row">
                <div class="adapter-row__main">
                  <div class="adapter-row__title">
                    <strong>{adapter.name}</strong>
                    <span
                      class="status-pill"
                      class:status-pill--ok={adapter.installed}
                      class:status-pill--warn={!adapter.installed}
                    >
                      <span class="dot" class:dot--ok={adapter.installed}></span>
                      {adapter.installed ? t('addAgent.installed') : t('addAgent.missing')}
                    </span>
                    {#if adapter.verified}
                      <span class="status-pill status-pill--accent">{t('addAgent.verified')}</span>
                    {/if}
                  </div>
                  <code class="adapter-row__command">{commandFor(adapter)}</code>
                </div>
                <button class="btn btn--small btn--ghost" type="button" onclick={() => copy(adapter)}>
                  <Icon name={copiedId === adapter.id ? 'check' : 'copy'} size={14} />
                  {copiedId === adapter.id ? t('addAgent.copied') : t('addAgent.copy')}
                </button>
              </article>
            {/each}
          </div>
          <p class="add-agent__note">
            <Icon name="lock" size={14} />
            {t('addAgent.note')}
          </p>
        {/if}
      </div>
    </div>
  </div>
{/if}
