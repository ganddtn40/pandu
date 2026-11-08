<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { remoteApi } from './api/client';
  import {
    refreshRemoteHost,
    remoteHostErrorMessage,
    remoteHostState,
  } from './api/remote-host.svelte';
  import type {
    RemoteAuditEntry,
    RemoteDevice,
    RemoteMode,
    RemotePairingCode,
    RemotePendingPairing,
    RemotePendingPrompt,
    RemoteScope,
  } from './api/types';
  import { copyText } from './clipboard';
  import { timeAgo } from './format';
  import { t, type MessageKey } from './i18n/i18n.svelte';
  import { remoteAuditKindKey, remoteModeKey, remoteScopeKey } from './remote-format';
  import { toast } from './toast-store.svelte';

  type ModeChoice = Exclude<RemoteMode, 'loopback'>;

  const MODES: Array<{
    id: ModeChoice;
    label: MessageKey;
    note: MessageKey;
    badge?: MessageKey;
    tone?: 'ok' | 'warn';
  }> = [
    {
      id: 'tailscale',
      label: 'remote.modeTailscale',
      note: 'remote.modeTailscaleNote',
      badge: 'remote.recommended',
      tone: 'ok',
    },
    {
      id: 'tunnel',
      label: 'remote.modeTunnel',
      note: 'remote.modeTunnelNote',
      badge: 'remote.publicBadge',
      tone: 'warn',
    },
    {
      id: 'lan',
      label: 'remote.modeLan',
      note: 'remote.modeLanNote',
      badge: 'remote.discouraged',
      tone: 'warn',
    },
  ];

  const SCOPES: RemoteScope[] = ['view', 'respond', 'prompt'];

  let selectedMode = $state<ModeChoice>('tailscale');
  let publicUrl = $state('');
  let busy = $state<string | null>(null);
  let pairing = $state<RemotePairingCode | null>(null);
  let now = $state(Date.now());
  let confirmPrompt = $state<string | null>(null);
  let confirmRevoke = $state<string | null>(null);
  let rotated = $state<{ deviceId: string; token: string } | null>(null);
  let notifyEnabled = $state(false);
  let notifyServer = $state('');
  let notifySaving = $state(false);
  let showAllAudit = $state(false);

  const status = $derived(remoteHostState.status);
  const enabled = $derived(status?.enabled === true);
  const tools = $derived(status?.tools);
  const notifications = $derived(status?.notifications);
  const pairingSeconds = $derived(
    pairing ? Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - now) / 1000)) : 0,
  );
  const canEnable = $derived(
    selectedMode === 'tailscale'
      ? Boolean(tools?.tailscaleIp)
      : selectedMode === 'tunnel'
        ? publicUrl.trim().length > 0
        : Boolean(tools?.lanIp),
  );
  const auditRows = $derived(
    showAllAudit ? remoteHostState.audit.slice(0, 100) : remoteHostState.audit.slice(0, 8),
  );

  onMount(() => {
    void refreshRemoteHost({ audit: true, matrix: true });
    const clock = window.setInterval(() => {
      now = Date.now();
    }, 1_000);
    const claims = window.setInterval(() => {
      if (!pairing) return;
      remoteApi
        .pendingPairings()
        .then((result) => {
          remoteHostState.pairings = result.pairings;
        })
        .catch(() => {
          // The host watcher reports the real error.
        });
    }, 2_000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(claims);
    };
  });

  $effect(() => {
    if (!notifications) return;
    notifyEnabled = notifications.enabled;
    if (!notifyServer) notifyServer = notifications.server;
  });

  async function run(key: string, action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = key;
    try {
      await action();
    } catch (error) {
      toast(remoteHostErrorMessage(error));
    } finally {
      busy = null;
    }
  }

  async function copyValue(value: string, message: MessageKey = 'common.copied'): Promise<void> {
    if (!value) return;
    if (await copyText(value)) toast(t(message));
    else toast(t('remote.copyFailed'));
  }

  async function enableRemote(): Promise<void> {
    await run('enable', async () => {
      remoteHostState.status = await remoteApi.enable(
        selectedMode,
        selectedMode === 'tunnel' ? publicUrl.trim() : undefined,
      );
      await refreshRemoteHost({ audit: true, matrix: true });
      toast(t('remote.enabledToast'));
    });
  }

  async function disableRemote(): Promise<void> {
    await run('disable', async () => {
      remoteHostState.status = await remoteApi.disable();
      pairing = null;
      rotated = null;
      await refreshRemoteHost({ audit: true });
      toast(t('remote.disabledToast'));
    });
  }

  async function panic(): Promise<void> {
    await run('panic', async () => {
      const result = await remoteApi.panic();
      remoteHostState.status = result.status;
      pairing = null;
      rotated = null;
      await refreshRemoteHost({ audit: true });
      toast(t('remote.panicDone', { count: result.revokedDevices }));
    });
  }

  async function startPairing(): Promise<void> {
    await run('pair-code', async () => {
      pairing = await remoteApi.pairCode();
      now = Date.now();
      await refreshRemoteHost({ audit: true });
    });
  }

  async function confirmClaim(claim: RemotePendingPairing): Promise<void> {
    await run(`pair-confirm-${claim.id}`, async () => {
      await remoteApi.confirmPairing(claim.id);
      toast(t('remote.pairConfirmed', { name: claim.deviceName }));
      await refreshRemoteHost({ audit: true });
    });
  }

  async function denyClaim(claim: RemotePendingPairing): Promise<void> {
    await run(`pair-deny-${claim.id}`, async () => {
      await remoteApi.denyPairing(claim.id);
      toast(t('remote.pairDenied'));
      await refreshRemoteHost({ audit: true });
    });
  }

  async function updateScopes(device: RemoteDevice, scopes: RemoteScope[]): Promise<void> {
    await run(`scopes-${device.id}`, async () => {
      const result = await remoteApi.updateDevice(device.id, {
        scopes: scopes.includes('view') ? scopes : ['view', ...scopes],
      });
      const index = remoteHostState.devices.findIndex((item) => item.id === device.id);
      if (index >= 0) remoteHostState.devices[index] = result.device;
      toast(t('remote.scopesSaved', { name: device.name }));
      await refreshRemoteHost({ audit: true });
    });
  }

  function toggleScope(device: RemoteDevice, scope: RemoteScope): void {
    if (scope === 'view' || busy || device.revokedAt) return;
    const active = device.scopes.includes(scope);
    if (scope === 'prompt' && !active) {
      confirmPrompt = device.id;
      return;
    }
    const next = active
      ? device.scopes.filter((item) => item !== scope)
      : [...device.scopes, scope];
    void updateScopes(device, next);
  }

  async function allowPrompt(device: RemoteDevice): Promise<void> {
    confirmPrompt = null;
    await updateScopes(device, [...device.scopes, 'prompt']);
  }

  async function toggleHostConfirmation(device: RemoteDevice): Promise<void> {
    await run(`host-confirm-${device.id}`, async () => {
      const result = await remoteApi.updateDevice(device.id, {
        requireHostConfirmation: !device.requireHostConfirmation,
      });
      const index = remoteHostState.devices.findIndex((item) => item.id === device.id);
      if (index >= 0) remoteHostState.devices[index] = result.device;
      toast(t('remote.hostConfirmSaved'));
      await refreshRemoteHost({ audit: true });
    });
  }

  async function rotate(device: RemoteDevice): Promise<void> {
    await run(`rotate-${device.id}`, async () => {
      const result = await remoteApi.rotateDevice(device.id);
      rotated = { deviceId: device.id, token: result.token };
      await refreshRemoteHost({ audit: true });
      toast(t('remote.rotateDone'));
    });
  }

  async function revoke(device: RemoteDevice): Promise<void> {
    await run(`revoke-${device.id}`, async () => {
      await remoteApi.revokeDevice(device.id);
      confirmRevoke = null;
      rotated = null;
      toast(t('remote.revokedToast', { name: device.name }));
      await refreshRemoteHost({ audit: true });
    });
  }

  async function approvePrompt(prompt: RemotePendingPrompt): Promise<void> {
    await run(`prompt-approve-${prompt.id}`, async () => {
      await remoteApi.approvePrompt(prompt.id);
      toast(t('remote.promptApproved'));
      await refreshRemoteHost({ audit: true });
    });
  }

  async function denyPrompt(prompt: RemotePendingPrompt): Promise<void> {
    await run(`prompt-deny-${prompt.id}`, async () => {
      await remoteApi.denyPrompt(prompt.id);
      toast(t('remote.promptDenied'));
      await refreshRemoteHost({ audit: true });
    });
  }

  async function saveNotifications(): Promise<void> {
    if (notifySaving) return;
    notifySaving = true;
    try {
      const result = await remoteApi.updateNotifications(notifyEnabled, notifyServer.trim());
      if (remoteHostState.status) remoteHostState.status.notifications = result;
      notifyServer = result.server;
      toast(t('remote.notificationsSaved'));
      await refreshRemoteHost({ audit: true });
    } catch (error) {
      toast(remoteHostErrorMessage(error));
    } finally {
      notifySaving = false;
    }
  }

  async function testNotification(): Promise<void> {
    if (notifySaving) return;
    notifySaving = true;
    try {
      await remoteApi.testNotification();
      toast(t('remote.notificationsTestSent'));
    } catch (error) {
      toast(remoteHostErrorMessage(error));
    } finally {
      notifySaving = false;
    }
  }

  function auditDetail(entry: RemoteAuditEntry): string {
    const detail = entry.detail ?? {};
    const parts: string[] = [];
    const push = (label: string, value: unknown): void => {
      if (value === undefined || value === null || value === '') return;
      if (Array.isArray(value)) parts.push(`${label} ${value.join(', ')}`);
      else if (typeof value === 'object') parts.push(`${label} ${JSON.stringify(value)}`);
      else parts.push(`${label} ${String(value)}`);
    };
    push('mode', detail.mode);
    push('url', detail.url);
    push('reason', detail.reason);
    push('eventId', detail.eventId);
    push('promptId', detail.promptId);
    push('claimId', detail.claimId);
    push('scopes', detail.scopes);
    if (entry.sizeBytes !== undefined) parts.push(`${entry.sizeBytes} B`);
    if (entry.contentHash) parts.push(`sha256 ${entry.contentHash.slice(0, 10)}…`);
    return parts.join(' · ');
  }
</script>

<section class="settings-card settings-card--wide card remote-card" data-glass data-glass-layer="card" data-glass-depth="2">
  <div class="settings-card__head">
    <span class="settings-card__icon"><Icon name="globe" size={19} /></span>
    <div>
      <h2>{t('remote.title')}</h2>
      <p>{t('remote.lede')}</p>
    </div>
    <div class="remote-card__head-actions">
      <span
        class="status-pill"
        class:status-pill--ok={enabled}
        class:status-pill--warn={!enabled}
      >
        <span class="dot" class:dot--ok={enabled}></span>
        {enabled ? t('remote.on') : t('remote.off')}
      </span>
      <button
        class="btn btn--small btn--ghost"
        type="button"
        onclick={() => refreshRemoteHost({ audit: true, matrix: true })}
        disabled={remoteHostState.loading}
      >
        <Icon name="refresh" size={14} />
        {t('remote.refresh')}
      </button>
    </div>
  </div>

  {#if remoteHostState.error}
    <p class="remote-error" role="alert">
      <Icon name="alert" size={15} />
      {remoteHostState.error}
    </p>
  {/if}

  {#if !status}
    <p class="settings-card__note">{t('remote.loading')}</p>
  {:else if !enabled}
    <div class="remote-off">
      <div class="remote-off__intro">
        <strong>{t('remote.offTitle')}</strong>
        <p>{t('remote.offBody')}</p>
      </div>

      <div class="remote-mode-grid" role="radiogroup" aria-label={t('remote.mode')}>
        {#each MODES as item (item.id)}
          <button
            class="remote-mode"
            class:is-active={selectedMode === item.id}
            type="button"
            role="radio"
            aria-checked={selectedMode === item.id}
            onclick={() => (selectedMode = item.id)}
          >
            <span class="remote-mode__head">
              <strong>{t(item.label)}</strong>
              {#if item.badge}
                <span
                  class="status-pill"
                  class:status-pill--ok={item.tone === 'ok'}
                  class:status-pill--warn={item.tone === 'warn'}
                >
                  {t(item.badge)}
                </span>
              {/if}
            </span>
            <span class="remote-mode__note">{t(item.note)}</span>
          </button>
        {/each}
      </div>

      {#if selectedMode === 'tailscale'}
        <div class="remote-setup">
          <div class="remote-setup__row">
            <span
              class="status-pill"
              class:status-pill--ok={tools?.tailscale.installed}
              class:status-pill--warn={!tools?.tailscale.installed}
            >
              <span class="dot" class:dot--ok={tools?.tailscale.installed}></span>
              {tools?.tailscale.installed ? t('remote.detected') : t('remote.notDetected')}
            </span>
            {#if tools?.tailscaleIp}
              <code class="remote-ip">{tools.tailscaleIp}</code>
            {/if}
          </div>
          <p class="remote-setup__text">
            {tools?.tailscale.installed ? t('remote.tailscaleServe') : t('remote.tailscaleMissing')}
          </p>
          <div class="remote-command-row">
            <code class="remote-command">{tools?.tailscale.command ?? 'tailscale up'}</code>
            <button
              class="btn btn--small btn--ghost"
              type="button"
              onclick={() => copyValue(tools?.tailscale.command ?? 'tailscale up', 'remote.commandCopied')}
            >
              <Icon name="copy" size={14} />
              {t('remote.copyCommand')}
            </button>
          </div>
          {#if tools?.tailscale.installed && !tools?.tailscaleIp}
            <p class="remote-warning">
              <Icon name="alert" size={14} />
              {t('remote.tailscaleNotConnected')}
            </p>
          {/if}
          <p class="settings-card__note">
            {tools?.tailscaleIp ? t('remote.tailscaleHttps') : t('remote.tailscaleHttpsPending')}
          </p>
        </div>
      {:else if selectedMode === 'tunnel'}
        <div class="remote-setup">
          <div class="remote-setup__row">
            <span
              class="status-pill"
              class:status-pill--ok={tools?.cloudflared.installed}
              class:status-pill--warn={!tools?.cloudflared.installed}
            >
              <span class="dot" class:dot--ok={tools?.cloudflared.installed}></span>
              {tools?.cloudflared.installed ? t('remote.detected') : t('remote.notDetected')}
            </span>
          </div>
          <p class="remote-setup__text">
            {tools?.cloudflared.installed ? t('remote.tunnelSetup') : t('remote.tunnelMissing')}
          </p>
          <div class="remote-command-row">
            <code class="remote-command">{tools?.cloudflared.command ?? 'cloudflared tunnel --url http://127.0.0.1:4320'}</code>
            <button
              class="btn btn--small btn--ghost"
              type="button"
              onclick={() =>
                copyValue(
                  tools?.cloudflared.command ?? 'cloudflared tunnel --url http://127.0.0.1:4320',
                  'remote.commandCopied',
                )}
            >
              <Icon name="copy" size={14} />
              {t('remote.copyCommand')}
            </button>
          </div>
          <label class="remote-field">
            <span>{t('remote.tunnelUrl')}</span>
            <input
              type="url"
              bind:value={publicUrl}
              placeholder={t('remote.tunnelUrlPlaceholder')}
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <p class="remote-warning">
            <Icon name="alert" size={14} />
            {t('remote.tunnelWarning')}
          </p>
        </div>
      {:else}
        <div class="remote-setup">
          {#if tools?.lanIp}
            <p class="remote-setup__text">{t('remote.lanIp', { ip: tools.lanIp })}</p>
          {:else}
            <p class="remote-warning">
              <Icon name="alert" size={14} />
              {t('remote.lanMissing')}
            </p>
          {/if}
          <p class="remote-warning">
            <Icon name="alert" size={14} />
            {t('remote.lanWarning')}
          </p>
        </div>
      {/if}

      <div class="remote-off__actions">
        <button
          class="btn btn--primary"
          type="button"
          onclick={enableRemote}
          disabled={!canEnable || busy !== null}
        >
          <Icon name="globe" size={16} />
          {busy === 'enable' ? t('remote.enabling') : t('remote.enable')}
        </button>
        {#if !canEnable}
          <span class="settings-card__note">
            {selectedMode === 'tailscale'
              ? t('remote.needTailscale')
              : selectedMode === 'tunnel'
                ? t('remote.needTunnelUrl')
                : t('remote.needLan')}
          </span>
        {/if}
      </div>
      <p class="settings-card__note">{t('remote.offHint')}</p>
    </div>
  {:else}
    <div class="remote-on">
      <dl class="summary-list summary-list--tight remote-summary">
        <div>
          <dt>{t('remote.status')}</dt>
          <dd>
            {status.awaitingTunnel ? t('remote.statusWaitingTunnel') : t('remote.statusOn')}
          </dd>
        </div>
        <div>
          <dt>{t('remote.mode')}</dt>
          <dd>{t(remoteModeKey(status.mode))}</dd>
        </div>
        <div>
          <dt>{t('remote.url')}</dt>
          <dd class="remote-summary__copy">
            <code>{status.url ?? t('common.unknown')}</code>
            {#if status.url}
              <button
                class="text-link"
                type="button"
                onclick={() => copyValue(status.url ?? '')}
              >
                {t('common.copy')}
              </button>
            {/if}
          </dd>
        </div>
        {#if status.fingerprint}
          <div>
            <dt>{t('remote.fingerprint')}</dt>
            <dd class="remote-summary__copy">
              <code>{status.fingerprint}</code>
              <button
                class="text-link"
                type="button"
                onclick={() => copyValue(status.fingerprint ?? '')}
              >
                {t('common.copy')}
              </button>
            </dd>
          </div>
        {/if}
        <div><dt>{t('remote.devices')}</dt><dd>{t('remote.deviceCount', { count: status.devices })}</dd></div>
        {#if status.startedAt}
          <div><dt>{t('remote.started')}</dt><dd>{timeAgo(status.startedAt, t)}</dd></div>
        {/if}
      </dl>

      {#if status.lastError}
        <p class="remote-error" role="alert">
          <Icon name="alert" size={15} />
          {status.lastError}
        </p>
      {/if}

      <section class="remote-section">
        <div class="remote-section__head">
          <div>
            <h3>{t('remote.pairingTitle')}</h3>
            <p>{t('remote.pairingBody', { url: status.url ?? t('common.unknown') })}</p>
          </div>
          <button
            class="btn btn--small btn--primary"
            type="button"
            onclick={startPairing}
            disabled={busy !== null}
          >
            <Icon name="plus" size={15} />
            {t('remote.pairDevice')}
          </button>
        </div>

        {#if pairing}
          <div class="remote-pairing">
            <div class="remote-qr" aria-hidden="true">
              {@html pairing.qrSvg}
            </div>
            <div class="remote-pairing__body">
              <span class="kicker">{t('remote.pairingCode')}</span>
              <div class="remote-code-row">
                <code class="remote-code">{pairing.code}</code>
                <button
                  class="btn btn--small btn--ghost"
                  type="button"
                  onclick={() => copyValue(pairing?.code ?? '', 'remote.codeCopied')}
                >
                  <Icon name="copy" size={14} />
                  {t('remote.copyCode')}
                </button>
              </div>
              <p class="settings-card__note">
                {pairingSeconds > 0
                  ? t('remote.pairingExpires', { seconds: pairingSeconds })
                  : t('remote.pairingExpired')}
              </p>
              <p class="settings-card__note">{t('remote.trustWarning')}</p>
            </div>
          </div>
        {/if}

        {#if remoteHostState.pairings.length > 0}
          <div class="remote-claims">
            {#each remoteHostState.pairings as claim (claim.id)}
              <article class="remote-claim">
                <div class="remote-claim__body">
                  <strong>{t('remote.pairRequest', { name: claim.deviceName })}</strong>
                  <span>{t('remote.pairMeta', { ip: claim.ip ?? t('common.unknown') })}</span>
                  <span>{claim.hasPin ? t('remote.pairHasPin') : t('remote.pairNoPin')}</span>
                </div>
                <div class="button-row button-row--tight">
                  <button
                    class="btn btn--small btn--primary"
                    type="button"
                    onclick={() => confirmClaim(claim)}
                    disabled={busy !== null}
                  >
                    <Icon name="check" size={14} />
                    {t('remote.confirmPair')}
                  </button>
                  <button
                    class="btn btn--small btn--ghost"
                    type="button"
                    onclick={() => denyClaim(claim)}
                    disabled={busy !== null}
                  >
                    {t('remote.denyPair')}
                  </button>
                </div>
              </article>
            {/each}
          </div>
        {:else}
          <p class="settings-card__note">{t('remote.pairingWaiting')}</p>
        {/if}
      </section>

      <section class="remote-section">
        <div class="remote-section__head">
          <div>
            <h3>{t('remote.devices')}</h3>
            <p>{t('remote.devicesNote')}</p>
          </div>
        </div>

        {#if remoteHostState.devices.length === 0}
          <p class="settings-card__note">{t('remote.noDevices')}</p>
        {:else}
          <div class="remote-devices">
            {#each remoteHostState.devices as device (device.id)}
              <article class="remote-device" class:is-revoked={Boolean(device.revokedAt)}>
                <div class="remote-device__head">
                  <div class="remote-device__name">
                    <Icon name="phone" size={16} />
                    <strong>{device.name}</strong>
                    {#if device.revokedAt}
                      <span class="status-pill status-pill--danger">{t('remote.revoked')}</span>
                    {/if}
                  </div>
                  <span class="remote-device__seen">
                    {device.lastSeenAt
                      ? t('remote.lastSeen', { time: timeAgo(device.lastSeenAt, t) })
                      : t('remote.neverSeen')}
                  </span>
                </div>

                <div class="remote-scopes">
                  {#each SCOPES as scope (scope)}
                    <button
                      class="chip"
                      class:is-active={device.scopes.includes(scope)}
                      type="button"
                      aria-pressed={device.scopes.includes(scope)}
                      disabled={scope === 'view' || Boolean(device.revokedAt) || busy !== null}
                      title={t(remoteScopeKey(scope))}
                      onclick={() => toggleScope(device, scope)}
                    >
                      <Icon
                        name={scope === 'view' ? 'eye' : scope === 'respond' ? 'approvals' : 'terminal'}
                        size={13}
                      />
                      {t(remoteScopeKey(scope))}
                    </button>
                  {/each}
                </div>
                <p class="settings-card__note">{t('remote.scopesNote')}</p>

                {#if device.scopes.includes('prompt')}
                  <p class="remote-warning">
                    <Icon name="alert" size={14} />
                    {t('remote.promptScopeWarning')}
                  </p>
                {/if}

                {#if confirmPrompt === device.id}
                  <div class="remote-inline-confirm">
                    <p>{t('remote.promptScopeConfirm', { name: device.name })}</p>
                    <div class="button-row button-row--tight">
                      <button
                        class="btn btn--small btn--primary"
                        type="button"
                        onclick={() => allowPrompt(device)}
                        disabled={busy !== null}
                      >
                        {t('remote.allowPrompt')}
                      </button>
                      <button
                        class="btn btn--small btn--ghost"
                        type="button"
                        onclick={() => (confirmPrompt = null)}
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                {/if}

                {#if !device.revokedAt}
                  <div class="remote-device__row">
                    <button
                      class="toggle"
                      type="button"
                      aria-pressed={device.requireHostConfirmation}
                      onclick={() => toggleHostConfirmation(device)}
                      disabled={busy !== null}
                    >
                      <span class="toggle__track" aria-hidden="true"></span>
                      {t('remote.hostConfirmToggle')}
                    </button>
                  </div>
                  <p class="settings-card__note">{t('remote.hostConfirmNote')}</p>

                  <div class="button-row button-row--tight remote-device__actions">
                    <button
                      class="btn btn--small btn--ghost"
                      type="button"
                      onclick={() => rotate(device)}
                      disabled={busy !== null}
                    >
                      <Icon name="rotate" size={14} />
                      {t('remote.rotate')}
                    </button>
                    <button
                      class="btn btn--small btn--danger"
                      type="button"
                      onclick={() => (confirmRevoke = device.id)}
                      disabled={busy !== null}
                    >
                      <Icon name="trash" size={14} />
                      {t('remote.revoke')}
                    </button>
                  </div>
                {/if}

                {#if rotated && rotated.deviceId === device.id}
                  <div class="remote-token">
                    <p>{t('remote.rotateOnce')}</p>
                    <code>{rotated.token}</code>
                    <button
                      class="btn btn--small btn--ghost"
                      type="button"
                      onclick={() => copyValue(rotated?.token ?? '', 'remote.tokenCopied')}
                    >
                      <Icon name="copy" size={14} />
                      {t('common.copy')}
                    </button>
                  </div>
                {/if}

                {#if confirmRevoke === device.id}
                  <div class="remote-inline-confirm remote-inline-confirm--danger">
                    <p>{t('remote.revokeConfirm', { name: device.name })}</p>
                    <div class="button-row button-row--tight">
                      <button
                        class="btn btn--small btn--danger"
                        type="button"
                        onclick={() => revoke(device)}
                        disabled={busy !== null}
                      >
                        {t('remote.revokeNow')}
                      </button>
                      <button
                        class="btn btn--small btn--ghost"
                        type="button"
                        onclick={() => (confirmRevoke = null)}
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                {/if}
              </article>
            {/each}
          </div>
        {/if}
      </section>

      {#if remoteHostState.prompts.length > 0}
        <section class="remote-section remote-section--attention">
          <div class="remote-section__head">
            <div>
              <h3>{t('remote.pendingPrompts')}</h3>
              <p>{t('remote.pendingPromptsNote')}</p>
            </div>
            <span class="status-pill status-pill--warn">
              <span class="dot dot--warn"></span>
              {remoteHostState.prompts.length}
            </span>
          </div>
          <div class="remote-prompts">
            {#each remoteHostState.prompts as prompt (prompt.id)}
              <article class="remote-prompt">
                <div class="remote-prompt__body">
                  <strong>{t('remote.promptFrom', { name: prompt.deviceName })}</strong>
                  <span>
                    {t('remote.promptMeta', {
                      size: prompt.sizeBytes,
                      hash: prompt.contentHash.slice(0, 12),
                    })}
                  </span>
                  <p>{t('remote.promptHidden')}</p>
                </div>
                <div class="button-row button-row--tight">
                  <button
                    class="btn btn--small btn--primary"
                    type="button"
                    onclick={() => approvePrompt(prompt)}
                    disabled={busy !== null}
                  >
                    <Icon name="send" size={14} />
                    {t('remote.approvePrompt')}
                  </button>
                  <button
                    class="btn btn--small btn--ghost"
                    type="button"
                    onclick={() => denyPrompt(prompt)}
                    disabled={busy !== null}
                  >
                    {t('remote.denyPrompt')}
                  </button>
                </div>
              </article>
            {/each}
          </div>
        </section>
      {/if}

      <section class="remote-section">
        <div class="remote-section__head">
          <div>
            <h3>{t('remote.notifications')}</h3>
            <p>{t('remote.notificationsNote')}</p>
          </div>
        </div>
        <div class="remote-notify">
          <div class="notify-row">
            <div class="notify-row__text">
              <strong>{t('remote.notificationsEnable')}</strong>
              <span>{t('remote.notificationsThirdParty')}</span>
            </div>
            <button
              class="toggle"
              type="button"
              aria-pressed={notifyEnabled}
              onclick={() => (notifyEnabled = !notifyEnabled)}
              disabled={notifySaving}
            >
              <span class="toggle__track" aria-hidden="true"></span>
              {notifyEnabled ? t('common.on') : t('common.off')}
            </button>
          </div>
          <label class="remote-field">
            <span>{t('remote.notificationsServer')}</span>
            <input
              type="url"
              bind:value={notifyServer}
              placeholder="https://ntfy.sh"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          {#if notifications?.topic}
            <p class="settings-card__note">
              {t('remote.notificationsTopic')}: <code>{notifications.topic}</code>
            </p>
          {/if}
          <div class="button-row button-row--tight">
            <button
              class="btn btn--small btn--ghost"
              type="button"
              onclick={saveNotifications}
              disabled={notifySaving}
            >
              <Icon name="check" size={14} />
              {t('remote.notificationsSave')}
            </button>
            <button
              class="btn btn--small btn--ghost"
              type="button"
              onclick={testNotification}
              disabled={notifySaving || !notifyEnabled}
            >
              <Icon name="bell" size={14} />
              {t('remote.notificationsTest')}
            </button>
          </div>
          <p class="settings-card__note">{t('remote.notificationsSelfHost')}</p>
        </div>
      </section>

      <section class="remote-section">
        <div class="remote-section__head">
          <div>
            <h3>{t('remote.audit')}</h3>
            <p>{t('remote.auditNote')}</p>
          </div>
          <a class="btn btn--small btn--ghost" href={remoteApi.auditExportUrl()} download>
            <Icon name="download" size={14} />
            {t('remote.auditExport')}
          </a>
        </div>

        {#if remoteHostState.audit.length === 0}
          <p class="settings-card__note">{t('remote.auditEmpty')}</p>
        {:else}
          <div class="remote-audit">
            {#each auditRows as entry (entry.id)}
              <article class="remote-audit__row">
                <div class="remote-audit__main">
                  <span class="status-pill">{t(remoteAuditKindKey(entry.event))}</span>
                  <code>{entry.event}</code>
                  {#if entry.deviceName}
                    <span class="remote-audit__device">{entry.deviceName}</span>
                  {/if}
                  <span class="remote-audit__time">{timeAgo(entry.at, t)}</span>
                </div>
                {#if auditDetail(entry)}
                  <span class="remote-audit__detail">{auditDetail(entry)}</span>
                {/if}
              </article>
            {/each}
          </div>
          {#if remoteHostState.auditTotal > 8}
            <button
              class="text-link"
              type="button"
              onclick={() => (showAllAudit = !showAllAudit)}
            >
              {showAllAudit
                ? t('remote.auditShowLess')
                : t('remote.auditShowAll', { count: remoteHostState.auditTotal })}
            </button>
          {/if}
        {/if}
      </section>

      <section class="remote-section">
        <div class="remote-section__head">
          <div>
            <h3>{t('remote.matrix')}</h3>
            <p>{t('remote.matrixNote')}</p>
          </div>
        </div>
        <div class="remote-matrix-wrap">
          <table class="remote-matrix">
            <thead>
              <tr>
                <th scope="col">{t('remote.method')}</th>
                <th scope="col">{t('remote.endpoint')}</th>
                <th scope="col">{t('remote.scope')}</th>
                <th scope="col">{t('remote.note')}</th>
              </tr>
            </thead>
            <tbody>
              {#each remoteHostState.matrix as row (row.method + row.path)}
                <tr>
                  <td><code>{row.method}</code></td>
                  <td><code>{row.path}</code></td>
                  <td>
                    <span
                      class="status-pill"
                      class:status-pill--ok={row.scope === 'none'}
                      class:status-pill--warn={row.scope !== 'none'}
                    >
                      {row.scope}
                    </span>
                  </td>
                  <td>{row.note}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>

      <section class="remote-section remote-section--danger">
        <div class="remote-section__head">
          <div>
            <h3>{t('remote.dangerTitle')}</h3>
            <p>{t('remote.dangerNote')}</p>
          </div>
        </div>
        <div class="button-row">
          <button class="btn btn--small btn--ghost" type="button" onclick={disableRemote} disabled={busy !== null}>
            <Icon name="eye-off" size={14} />
            {t('remote.disable')}
          </button>
          <button class="btn btn--small btn--danger" type="button" onclick={panic} disabled={busy !== null}>
            <Icon name="shield" size={14} />
            {t('remote.panic')}
          </button>
        </div>
        <p class="settings-card__note">{t('remote.panicNote')}</p>
      </section>
    </div>
  {/if}
</section>
