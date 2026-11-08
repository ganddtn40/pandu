<script lang="ts">
  import HeroObject from './HeroObject.svelte';
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';
  import { openAddAgent } from './add-agent.svelte';
  import { daemonState, seedDemoData } from './api/daemon.svelte';
  import { t, type MessageKey } from './i18n/i18n.svelte';
  import { completeOnboarding } from './onboarding.svelte';
  import { navigate } from './router.svelte';
  import { toast } from './toast-store.svelte';

  interface Step {
    title: MessageKey;
    body: MessageKey;
    points: MessageKey[];
  }

  const steps: Step[] = [
    {
      title: 'onboarding.welcomeTitle',
      body: 'onboarding.welcomeBody',
      points: ['onboarding.welcomePoint1', 'onboarding.welcomePoint2', 'onboarding.welcomePoint3'],
    },
    {
      title: 'onboarding.recordTitle',
      body: 'onboarding.recordBody',
      points: ['onboarding.recordPoint1', 'onboarding.recordPoint2', 'onboarding.recordPoint3'],
    },
    {
      title: 'onboarding.controlTitle',
      body: 'onboarding.controlBody',
      points: ['onboarding.controlPoint1', 'onboarding.controlPoint2', 'onboarding.controlPoint3'],
    },
  ];

  let index = $state(0);
  let loadingDemo = $state(false);

  const step = $derived(steps[index]!);
  const last = $derived(index === steps.length - 1);
  const online = $derived(daemonState.status === 'online');
  const demo = $derived(daemonState.health?.demoMode === true);
  const installedCount = $derived(
    daemonState.adapters.filter((adapter) => adapter.installed).length,
  );

  function finish(): void {
    completeOnboarding();
    navigate('/');
  }

  function next(): void {
    if (last) {
      finish();
      return;
    }
    index += 1;
  }

  function back(): void {
    if (index > 0) index -= 1;
  }

  async function loadDemo(): Promise<void> {
    loadingDemo = true;
    try {
      const count = await seedDemoData();
      toast(count > 0 ? t('onboarding.demoLoaded') : t('flights.loadedDemo'));
    } catch {
      toast(t('common.offline'));
    } finally {
      loadingDemo = false;
    }
  }
</script>

<div class="onboarding">
  <header class="onboarding__top">
    <a class="brand" href="/" data-route aria-label="Cockpit home">
      <Logo size={32} />
      <span class="brand__name">Cockpit</span>
    </a>
    <button class="btn btn--small btn--ghost" type="button" onclick={finish}>
      {t('onboarding.skip')}
    </button>
  </header>

  <section
    class="onboarding__card card"
    aria-labelledby="onboarding-title"
    data-glass
    data-glass-layer="card"
    data-glass-depth="2"
  >
    <div class="onboarding__visual">
      <HeroObject size={360} />
      <span class="onboarding__badge"><span class="dot dot--live"></span> {t('onboarding.local')}</span>
    </div>

    <div class="onboarding__copy">
      <p class="kicker">{t('onboarding.step', { current: index + 1, total: steps.length })}</p>
      <h1 id="onboarding-title">{t(step.title)}</h1>
      <p class="onboarding__body">{t(step.body)}</p>

      <ul class="onboarding__points">
        {#each step.points as point}
          <li><Icon name="check" size={16} /> {t(point)}</li>
        {/each}
      </ul>

      <div class="onboarding__status">
        <span class="status-pill" class:status-pill--ok={online} class:status-pill--warn={!online}>
          <span class="dot" class:dot--ok={online}></span>
          {#if online}
            {t('onboarding.daemonOnline', { version: daemonState.health?.version ?? '0.2.0' })}
          {:else if daemonState.status === 'connecting'}
            {t('common.connecting')}
          {:else}
            {t('onboarding.daemonOffline')}
          {/if}
        </span>
        {#if online}
          <span class="status-pill">
            {installedCount > 0
              ? t('onboarding.adaptersFound', { count: installedCount })
              : t('onboarding.noAdapters')}
          </span>
        {/if}
      </div>

      <div class="onboarding__dots" aria-label={t('onboarding.step', { current: index + 1, total: steps.length })}>
        {#each steps as _, dotIndex}
          <span class:is-active={dotIndex === index}></span>
        {/each}
      </div>

      <div class="onboarding__actions">
        {#if index > 0}
          <button class="btn btn--ghost" type="button" onclick={back}>
            <Icon name="arrow-left" size={16} />
            {t('onboarding.back')}
          </button>
        {/if}
        <button class="btn btn--primary" type="button" onclick={next}>
          {last ? t('onboarding.open') : t('onboarding.continue')}
          <Icon name={last ? 'check' : 'arrow-right'} size={16} />
        </button>
        <button class="btn btn--ghost" type="button" onclick={openAddAgent}>
          <Icon name="plus" size={16} />
          {t('onboarding.openAddAgent')}
        </button>
      </div>
    </div>
  </section>

  <section class="onboarding__demo card" data-glass data-glass-layer="card" data-glass-depth="2">
    <div>
      <strong>{demo ? t('onboarding.demo') : t('onboarding.startTitle')}</strong>
      <p>{demo ? t('onboarding.demoBody') : t('onboarding.startBody')}</p>
    </div>
    {#if demo}
      <button class="btn btn--small btn--ghost" type="button" onclick={loadDemo} disabled={loadingDemo}>
        <Icon name="play" size={14} />
        {t('onboarding.loadDemo')}
      </button>
    {:else}
      <button class="btn btn--small btn--ghost" type="button" onclick={openAddAgent}>
        <Icon name="plus" size={14} />
        {t('onboarding.openAddAgent')}
      </button>
    {/if}
  </section>
</div>
