<script lang="ts">
  import Icon from './Icon.svelte';
  import { daemonApi } from './api/client';
  import { daemonErrorMessage, daemonState } from './api/daemon.svelte';
  import { CLI_COMMAND, REPOSITORY } from './brand';
  import { copyText } from './clipboard';
  import { t } from './i18n/i18n.svelte';
  import { displayFolderPath, parentFolderPath } from './paths';
  import { toast } from './toast-store.svelte';

  let copied = $state<string | null>(null);
  let creating = $state(false);
  let opening = $state<string | null>(null);
  let lastBackup = $state<string | null>(null);
  let lastBytes = $state(0);

  const dataDir = $derived.by(() => {
    const health = daemonState.health;
    if (health?.dataDir) return displayFolderPath(health.dataDir);
    if (health?.databasePath) return parentFolderPath(health.databasePath);
    return '—';
  });
  const backupsDir = $derived(displayFolderPath(daemonState.health?.backupsDir));
  const backupCommand = `${CLI_COMMAND} backup`;
  const encryptedBackupCommand = `${CLI_COMMAND} backup --encrypt`;
  const restoreCommand = `${CLI_COMMAND} restore <archive>`;
  const docsUrl = `${REPOSITORY}/blob/main/docs/data-safety.md`;

  async function copy(id: string, value: string): Promise<void> {
    const ok = await copyText(value);
    if (!ok) {
      toast(t('common.copyFailed'));
      return;
    }
    copied = id;
    toast(t('common.copied'));
    window.setTimeout(() => {
      if (copied === id) copied = null;
    }, 1800);
  }

  async function createBackup(): Promise<void> {
    if (creating) return;
    creating = true;
    try {
      const result = await daemonApi.createBackup();
      lastBackup = result.path;
      lastBytes = result.bytes;
      toast(t('settings.backupCreated', { path: result.path }));
    } catch (error) {
      toast(daemonErrorMessage(error) || t('settings.backupCreateFailed'));
    } finally {
      creating = false;
    }
  }

  async function openFolder(target: 'data' | 'backups'): Promise<void> {
    if (opening) return;
    opening = target;
    try {
      await daemonApi.reveal(target);
    } catch (error) {
      toast(daemonErrorMessage(error) || t('settings.backupOpenFailed'));
    } finally {
      opening = null;
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${bytes} B`;
  }
</script>

<section
  class="settings-card settings-card--wide card"
  data-glass
  data-glass-layer="card"
  data-glass-depth="2"
  data-backup-card
>
  <div class="settings-card__head">
    <span class="settings-card__icon"><Icon name="shield" size={19} /></span>
    <div>
      <h2>{t('settings.backupTitle')}</h2>
      <p>{t('settings.backupNote')}</p>
    </div>
  </div>

  <div class="backup-warning" role="note">
    <Icon name="alert" size={16} />
    <div>
      <strong>{t('settings.backupWarning')}</strong>
      <span>{t('settings.backupEncryptHint')}</span>
    </div>
  </div>

  <dl class="summary-list">
    <div>
      <dt>{t('settings.backupDataFolder')}</dt>
      <dd class="backup-path">
        <code data-backup-data-path>{dataDir}</code>
        <button
          class="btn btn--small btn--ghost"
          type="button"
          onclick={() => openFolder('data')}
          disabled={opening !== null}
        >
          <Icon name="folder" size={14} />
          {t('settings.backupOpenFolder')}
        </button>
      </dd>
    </div>
    <div>
      <dt>{t('settings.backupBackupFolder')}</dt>
      <dd class="backup-path">
        <code data-backup-backups-path>{backupsDir}</code>
        <button
          class="btn btn--small btn--ghost"
          type="button"
          onclick={() => openFolder('backups')}
          disabled={opening !== null}
        >
          <Icon name="folder" size={14} />
          {t('settings.backupOpenFolder')}
        </button>
      </dd>
    </div>
    <div>
      <dt>{t('settings.backupInclude')}</dt>
      <dd>{t('settings.backupIncluded')}</dd>
    </div>
  </dl>

  <div class="backup-actions">
    <button
      class="btn btn--small btn--primary"
      type="button"
      onclick={createBackup}
      disabled={creating}
      data-backup-create
    >
      <Icon name={creating ? 'clock' : 'download'} size={14} />
      {creating ? t('settings.backupCreating') : t('settings.backupCreate')}
    </button>
    {#if lastBackup}
      <div class="backup-result" data-backup-result>
        <code>{lastBackup}</code>
        <span>{formatBytes(lastBytes)}</span>
        <button
          class="btn btn--small btn--ghost"
          type="button"
          onclick={() => openFolder('backups')}
          disabled={opening !== null}
        >
          <Icon name="folder" size={14} />
          {t('settings.backupOpenFolder')}
        </button>
      </div>
    {/if}
  </div>

  <div class="backup-commands">
    <div class="backup-command">
      <span>{t('settings.backupCommand')}</span>
      <code>{backupCommand}</code>
      <button
        class="icon-button icon-button--small"
        type="button"
        aria-label={t('common.copy')}
        onclick={() => copy('backup', backupCommand)}
      >
        <Icon name={copied === 'backup' ? 'check' : 'copy'} size={14} />
      </button>
    </div>
    <div class="backup-command">
      <span>{t('settings.backupCommand')}</span>
      <code>{encryptedBackupCommand}</code>
      <button
        class="icon-button icon-button--small"
        type="button"
        aria-label={t('common.copy')}
        onclick={() => copy('encrypted', encryptedBackupCommand)}
      >
        <Icon name={copied === 'encrypted' ? 'check' : 'copy'} size={14} />
      </button>
    </div>
    <div class="backup-command">
      <span>{t('settings.backupRestoreCommand')}</span>
      <code>{restoreCommand}</code>
      <button
        class="icon-button icon-button--small"
        type="button"
        aria-label={t('common.copy')}
        onclick={() => copy('restore', restoreCommand)}
      >
        <Icon name={copied === 'restore' ? 'check' : 'copy'} size={14} />
      </button>
    </div>
  </div>

  <ul class="check-list">
    <li><Icon name="check" size={15} /> {t('settings.backupExcluded')}</li>
    <li><Icon name="check" size={15} /> {t('settings.backupPermissions')}</li>
    <li><Icon name="check" size={15} /> {t('settings.backupRemote')}</li>
    <li><Icon name="check" size={15} /> {t('settings.backupRestoreNote')}</li>
    <li><Icon name="check" size={15} /> {t('settings.backupUninstall')}</li>
  </ul>

  <div class="settings-card__foot">
    <a class="text-link" href={docsUrl} target="_blank" rel="noreferrer noopener">
      {t('settings.backupDocs')}
      <Icon name="external" size={14} />
    </a>
  </div>
</section>
