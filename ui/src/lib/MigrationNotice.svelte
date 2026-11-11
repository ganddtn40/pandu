<script lang="ts">
  import Icon from './Icon.svelte';
  import { daemonState } from './api/daemon.svelte';
  import { storageKey } from './brand';
  import { t } from './i18n/i18n.svelte';
  import { fileName } from './paths';

  const DISMISSED_KEY = storageKey('migration.notice');

  function readDismissed(): string | null {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(DISMISSED_KEY);
    } catch {
      return null;
    }
  }

  let dismissed = $state<string | null>(readDismissed());
  const migration = $derived(daemonState.migration);
  const visible = $derived(
    migration !== null && migration.outcome === 'ok' && dismissed !== migration.at,
  );

  function dismiss(): void {
    if (!migration) return;
    dismissed = migration.at;
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(DISMISSED_KEY, migration.at);
    } catch {
      // A blocked storage area only means the notice returns next time.
    }
  }
</script>

{#if visible && migration}
  <section
    class="migration-notice card"
    data-glass
    data-glass-layer="card"
    data-glass-depth="2"
    data-migration-notice
  >
    <span class="migration-notice__icon"><Icon name="shield" size={20} /></span>
    <div class="migration-notice__body">
      <h2>{t('migration.title', { from: migration.fromVersion, to: migration.toVersion })}</h2>
      <p>
        {#if migration.backupPath}
          {t('migration.backup', { path: fileName(migration.backupPath) })}
        {:else}
          {t('migration.noBackup')}
        {/if}
      </p>
      <p class="migration-notice__note">{t('migration.note')}</p>
    </div>
    <button
      class="icon-button icon-button--small"
      type="button"
      aria-label={t('common.close')}
      onclick={dismiss}
    >
      <Icon name="close" size={15} />
    </button>
  </section>
{/if}
