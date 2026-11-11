<script lang="ts">
  import Icon from './Icon.svelte';
  import { updateApi } from './api/client';
  import { applyUpdateStatus, daemonErrorMessage, daemonState } from './api/daemon.svelte';
  import { copyText } from './clipboard';
  import { formatDate } from './format';
  import { t } from './i18n/i18n.svelte';
  import { toast } from './toast-store.svelte';

  let menuOpen = $state(false);
  let installOpen = $state(false);
  let saving = $state(false);
  let copied = $state(false);
  let menuEl = $state<HTMLDivElement | null>(null);

  const status = $derived(daemonState.update);
  const visible = $derived(
    status?.latestVersion != null &&
      (status.state === 'available' || status.state === 'snoozed'),
  );

  $effect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent): void => {
      if (menuEl && event.target instanceof Node && menuEl.contains(event.target)) return;
      menuOpen = false;
    };
    window.addEventListener('pointerdown', onPointer);
    return () => window.removeEventListener('pointerdown', onPointer);
  });

  async function snooze(choice: 'tomorrow' | 'week' | 'version'): Promise<void> {
    if (!status || saving) return;
    saving = true;
    try {
      applyUpdateStatus(await updateApi.snooze(choice));
      menuOpen = false;
      toast(t('update.snoozeSaved'));
    } catch (error) {
      toast(daemonErrorMessage(error) || t('update.snoozeFailed'));
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
</script>

{#if visible && status}
  <section
    class="update-card card"
    data-glass
    data-glass-layer="card"
    data-glass-depth="2"
    data-update-card
    data-update-state={status.state}
  >
    <span class="update-card__icon"><Icon name="download" size={22} /></span>
    <div class="update-card__body">
      <p class="update-card__eyebrow">
        <span class="status-pill status-pill--accent">{t('update.availableBadge')}</span>
        <span>{t('update.channelLabel', { channel: status.channel })}</span>
        {#if status.publishedAt}
          <span>· {formatDate(status.publishedAt)}</span>
        {/if}
      </p>
      <h2>{t('update.availableTitle', { version: status.latestVersion ?? '' })}</h2>
      {#if status.notesSummary}
        <p class="update-card__notes">{status.notesSummary}</p>
      {/if}
      <p class="update-card__meta">
        {t('update.currentVersion', { version: status.currentVersion })}
      </p>
      {#if status.state === 'snoozed' && status.snoozedUntil}
        <p class="update-card__meta">
          {t('update.snoozedUntil', { time: formatDate(status.snoozedUntil) })}
        </p>
      {/if}
      {#if status.trust !== 'ready' && status.message}
        <p class="update-card__warning">
          <Icon name="alert" size={14} />
          {status.message}
        </p>
      {/if}

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
    </div>

    <div class="update-card__actions">
      <button
        class="btn btn--primary"
        type="button"
        disabled={!status.canInstall}
        title={!status.canInstall ? (status.message ?? t('update.installUnavailable')) : undefined}
        onclick={() => {
          installOpen = !installOpen;
        }}
      >
        <Icon name="download" size={15} />
        {t('update.now')}
      </button>

      <div class="update-menu" bind:this={menuEl}>
        <button
          class="btn btn--ghost"
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={saving}
          onclick={() => {
            menuOpen = !menuOpen;
          }}
        >
          <Icon name="clock" size={15} />
          {t('update.remindLater')}
          <Icon name="arrow-down" size={13} />
        </button>
        {#if menuOpen}
          <div class="update-menu__list" role="menu" data-update-snooze-menu>
            <button type="button" role="menuitem" onclick={() => snooze('tomorrow')}>
              <Icon name="sun" size={14} />
              {t('update.tomorrow')}
            </button>
            <button type="button" role="menuitem" onclick={() => snooze('week')}>
              <Icon name="clock" size={14} />
              {t('update.oneWeek')}
            </button>
            <button type="button" role="menuitem" onclick={() => snooze('version')}>
              <Icon name="eye-off" size={14} />
              {t('update.skipVersion')}
            </button>
          </div>
        {/if}
      </div>

      {#if status.releaseUrl}
        <a
          class="text-link"
          href={status.releaseUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          {t('update.releaseNotes')}
          <Icon name="external" size={13} />
        </a>
      {/if}
    </div>
  </section>
{/if}
