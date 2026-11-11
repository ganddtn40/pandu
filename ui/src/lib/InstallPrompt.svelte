<script lang="ts">
  import { onMount } from 'svelte';
  import { storageKey } from './brand';
  import { t } from './i18n/i18n.svelte';
  import Icon from './Icon.svelte';
  import { isStandalone, type InstallPromptEvent } from './pwa';

  const DISMISS_KEY = storageKey('pwa.install.dismissed');

  let deferred = $state<InstallPromptEvent | null>(null);
  let visible = $state(false);

  onMount(() => {
    if (isStandalone()) return;
    try {
      if (window.localStorage.getItem(DISMISS_KEY) === '1') return;
    } catch {
      // Private mode: show nothing rather than a prompt that cannot persist.
      return;
    }
    const onPrompt = (event: Event): void => {
      event.preventDefault();
      deferred = event as InstallPromptEvent;
      visible = true;
    };
    const onInstalled = (): void => {
      visible = false;
      deferred = null;
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  });

  async function install(): Promise<void> {
    const prompt = deferred;
    if (!prompt) return;
    deferred = null;
    visible = false;
    await prompt.prompt();
    await prompt.userChoice.catch(() => undefined);
  }

  function dismiss(): void {
    visible = false;
    deferred = null;
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // The banner simply returns next time.
    }
  }
</script>

{#if visible}
  <aside class="install-prompt card" aria-label={t('pwa.installTitle')}>
    <span class="install-prompt__mark"><Icon name="download" size={18} /></span>
    <div class="install-prompt__copy">
      <strong>{t('pwa.installTitle')}</strong>
      <p>{t('pwa.installBody')}</p>
    </div>
    <div class="install-prompt__actions">
      <button class="btn btn--small btn--primary" type="button" onclick={install}>
        {t('pwa.install')}
      </button>
      <button class="btn btn--small btn--ghost" type="button" onclick={dismiss}>
        {t('pwa.notNow')}
      </button>
    </div>
  </aside>
{/if}
