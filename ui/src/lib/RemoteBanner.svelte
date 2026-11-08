<script lang="ts">
  import Icon from './Icon.svelte';
  import { remoteApi } from './api/client';
  import {
    refreshRemoteHost,
    remoteHostErrorMessage,
    remoteHostState,
  } from './api/remote-host.svelte';
  import { t } from './i18n/i18n.svelte';
  import { remoteModeKey } from './remote-format';
  import { navigate } from './router.svelte';
  import { toast } from './toast-store.svelte';

  let busy = $state(false);

  const status = $derived(remoteHostState.status);
  const enabled = $derived(status?.enabled === true);

  async function panic(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const result = await remoteApi.panic();
      remoteHostState.status = result.status;
      await refreshRemoteHost({ audit: true });
      toast(t('remote.panicDone', { count: result.revokedDevices }));
    } catch (error) {
      toast(remoteHostErrorMessage(error));
    } finally {
      busy = false;
    }
  }
</script>

{#if enabled && status}
  <div class="remote-banner" role="status">
    <span class="remote-banner__pulse" aria-hidden="true"></span>
    <div class="remote-banner__text">
      <strong>{t('remote.bannerOn', { mode: t(remoteModeKey(status.mode)) })}</strong>
      <span>
        {status.url ?? t('common.unknown')} · {t('remote.bannerDevices', { count: status.devices })}
      </span>
    </div>
    <div class="remote-banner__pending">
      {#if status.pendingPairings > 0}
        <a class="remote-banner__link" href="/settings" data-route>
          <Icon name="user" size={14} />
          {t('remote.bannerPairings', { count: status.pendingPairings })}
        </a>
      {/if}

      {#if status.pendingPrompts > 0}
        <a class="remote-banner__link" href="/settings" data-route>
          <Icon name="terminal" size={14} />
          {t('remote.bannerPrompts', { count: status.pendingPrompts })}
        </a>
      {/if}
    </div>
    <div class="remote-banner__actions">
      <button class="text-link" type="button" onclick={() => navigate('/settings')}>
        {t('remote.bannerManage')}
        <Icon name="arrow-right" size={14} />
      </button>
      <button class="btn btn--small btn--danger" type="button" onclick={panic} disabled={busy}>
        <Icon name="shield" size={14} />
        {t('remote.panicShort')}
      </button>
    </div>
  </div>
{/if}
