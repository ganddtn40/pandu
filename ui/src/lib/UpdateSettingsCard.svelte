<script lang="ts">
  import Icon from './Icon.svelte';
  import { updateApi } from './api/client';
  import { applyUpdateStatus, daemonErrorMessage, daemonState } from './api/daemon.svelte';
  import type { UpdateState } from './api/types';
  import { UPDATE_INTERVAL_HOURS } from './brand';
  import { copyText } from './clipboard';
  import { formatDate } from './format';
  import { t, type MessageKey } from './i18n/i18n.svelte';
  import { toast } from './toast-store.svelte';

  const STATE_KEYS: Record<UpdateState, MessageKey> = {
    idle: 'update.stateIdle',
    'up-to-date': 'update.stateUpToDate',
    available: 'update.stateAvailable',
    snoozed: 'update.stateSnoozed',
    skipped: 'update.stateSkipped',
    offline: 'update.stateOffline',
    'rate-limited': 'update.stateRateLimited',
    unavailable: 'update.stateUnavailable',
    error: 'update.stateError',
  };

  let busy = $state(false);
  let saving = $state(false);
  let installOpen = $state(false);
  let copied = $state(false);

  const status = $derived(daemonState.update);

  function stateKey(state: UpdateState): MessageKey {
    return STATE_KEYS[state] ?? 'update.stateError';
  }

  function stateClass(state: UpdateState): string {
    if (state === 'available') return 'status-pill--accent';
    if (state === 'up-to-date') return 'status-pill--ok';
    if (state === 'snoozed' || state === 'skipped' || state === 'idle') {
      return 'status-pill--warn';
    }
    if (state === 'offline' || state === 'rate-limited') return 'status-pill--warn';
    return 'status-pill--danger';
  }

  async function checkNow(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const next = await updateApi.check();
      applyUpdateStatus(next);
      if (next.state === 'available') {
        toast(t('update.checkAvailable'));
      } else if (next.state === 'up-to-date') {
        toast(t('update.checkUpToDate'));
      } else {
        toast(next.message || t('update.checkDone'));
      }
    } catch (error) {
      toast(daemonErrorMessage(error) || t('update.checkFailed'));
    } finally {
      busy = false;
    }
  }

  async function toggleAutomatic(): Promise<void> {
    if (!status || saving) return;
    saving = true;
    try {
      applyUpdateStatus(await updateApi.setEnabled(!status.enabled));
      toast(t('update.settingsSaved'));
    } catch (error) {
      toast(daemonErrorMessage(error) || t('update.settingsFailed'));
    } finally {
      saving = false;
    }
  }

  async function copyCommand(): Promise<void> {
    if (!status) return;
    const ok = await copyText(status.installCommand);
    if (!ok) {
      toast(t('common.copyFailed'));
      return;
    }
    copied = true;
    toast(t('update.commandCopied'));
    window.setTimeout(() => {
      copied = false;
    }, 1800);
  }

  const trustKey = $derived(
    status?.trust === 'ready'
      ? 'update.trustReady'
      : status?.trust === 'refused'
        ? 'update.trustRefused'
        : 'update.trustPreparing',
  );
</script>

<section
  class="settings-card card"
  data-glass
  data-glass-layer="card"
  data-glass-depth="2"
  data-update-settings
>
  <div class="settings-card__head">
    <span class="settings-card__icon"><Icon name="download" size={19} /></span>
    <div>
      <h2>{t('settings.updates')}</h2>
      <p>{t('settings.updatesNote')}</p>
    </div>
    {#if status}
      <span class="status-pill {stateClass(status.state)}" data-update-status={status.state}>
        <span class="dot" class:dot--ok={status.state === 'up-to-date'}></span>
        {t(stateKey(status.state))}
      </span>
    {/if}
  </div>

  {#if !status}
    <p class="settings-card__note">{t('update.unavailableStatus')}</p>
  {:else}
    <dl class="summary-list">
      <div><dt>{t('update.current')}</dt><dd>{status.currentVersion}</dd></div>
      <div>
        <dt>{t('update.latest')}</dt>
        <dd>{status.latestVersion ?? '—'}</dd>
      </div>
      <div><dt>{t('update.channel')}</dt><dd>{status.channel}</dd></div>
      <div><dt>{t('update.trust')}</dt><dd>{t(trustKey)}</dd></div>
      <div>
        <dt>{t('update.lastCheck')}</dt>
        <dd>{status.lastCheckedAt ? formatDate(status.lastCheckedAt) : t('update.never')}</dd>
      </div>
      <div>
        <dt>{t('update.nextCheck')}</dt>
        <dd>
          {#if !status.enabled}
            {t('update.manualOnly')}
          {:else if status.nextCheckAt}
            {formatDate(status.nextCheckAt)}
          {:else}
            {t('update.never')}
          {/if}
        </dd>
      </div>
    </dl>

    {#if status.message}
      <p class="update-message" data-update-message>
        <Icon name="info" size={14} />
        {status.message}
      </p>
    {/if}

    {#if status.notes}
      <details class="update-notes" data-update-notes>
        <summary>{t('update.notesTitle')}</summary>
        <p>{status.notes}</p>
      </details>
    {:else if status.latestVersion}
      <p class="settings-card__note">{t('update.noNotes')}</p>
    {/if}

    <div class="notify-list">
      <div class="notify-row">
        <div class="notify-row__text">
          <strong>{t('update.automatic')}</strong>
          <span>{t('update.automaticNote', { hours: UPDATE_INTERVAL_HOURS })}</span>
        </div>
        <button
          class="toggle"
          type="button"
          aria-pressed={status.enabled}
          disabled={saving}
          onclick={toggleAutomatic}
        >
          <span class="toggle__track" aria-hidden="true"></span>
          {status.enabled ? t('common.on') : t('common.off')}
        </button>
      </div>
    </div>

    {#if installOpen}
      <div class="update-install" data-update-install>
        <strong>{t('update.installTitle')}</strong>
        <p>{t('update.installBody')}</p>
        <div class="update-install__command">
          <code>{status.installCommand}</code>
          <button
            class="icon-button icon-button--small"
            type="button"
            aria-label={t('update.copyCommand')}
            onclick={copyCommand}
          >
            <Icon name={copied ? 'check' : 'copy'} size={14} />
          </button>
        </div>
      </div>
    {/if}
  {/if}

  <div class="settings-card__foot">
    <div class="button-row button-row--tight">
      <button
        class="btn btn--small btn--ghost"
        type="button"
        disabled={busy || !status}
        onclick={checkNow}
        data-update-check
      >
        <Icon name="refresh" size={15} />
        {busy ? t('update.checking') : t('update.checkNow')}
      </button>
      <button
        class="btn btn--small btn--ghost"
        type="button"
        disabled={!status?.canInstall}
        onclick={() => {
          installOpen = !installOpen;
        }}
      >
        <Icon name="download" size={15} />
        {t('update.now')}
      </button>
      {#if status?.releaseUrl}
        <a
          class="btn btn--small btn--ghost"
          href={status.releaseUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          <Icon name="external" size={15} />
          {t('update.releaseNotes')}
        </a>
      {/if}
    </div>
  </div>
</section>
