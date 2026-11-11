<script lang="ts">
  import Icon from './Icon.svelte';
  import { daemonState } from './api/daemon.svelte';
  import { CLI_COMMAND, REPOSITORY } from './brand';
  import { copyText } from './clipboard';
  import { t } from './i18n/i18n.svelte';
  import { toast } from './toast-store.svelte';

  let copied = $state<string | null>(null);

  const database = $derived(daemonState.health?.databasePath ?? '—');
  const backupCommand = `${CLI_COMMAND} backup`;
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

  <dl class="summary-list">
    <div>
      <dt>{t('settings.backupData')}</dt>
      <dd><code>{database}</code></dd>
    </div>
    <div>
      <dt>{t('settings.backupInclude')}</dt>
      <dd>{t('settings.backupIncluded')}</dd>
    </div>
  </dl>

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
