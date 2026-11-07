<script lang="ts">
  import Icon from './Icon.svelte';
  import { toast } from './toast-store.svelte';

  function demo(): void {
    toast('Demo flights arrive with the Home screen in Phase 5.');
  }

  async function copyCommand(): Promise<void> {
    const command = 'cockpit run -- opencode';
    try {
      await navigator.clipboard?.writeText(command);
      toast('Setup command copied.');
    } catch {
      toast(`Copy failed. Run: ${command}`);
    }
  }
</script>

<div class="panel-head">
  <div>
    <p class="kicker">Home</p>
    <h1>Live flight</h1>
  </div>
  <span class="status-pill"><span class="dot"></span> Shell preview</span>
</div>

<section class="live-card glass" data-glass data-glass-depth="2">
  <div class="live-copy">
    <span class="eyebrow"><span class="dot dot--live"></span> Live flight preview</span>
    <h2>Waiting for your first flight</h2>
    <p>
      Start an agent and Cockpit will show every request, tool call, and file change here.
      Nothing leaves this machine.
    </p>
    <div class="button-row">
      <button class="btn btn--primary" type="button" onclick={demo}>Try demo</button>
      <button class="btn btn--ghost" type="button" onclick={copyCommand}>
        <Icon name="copy" size={16} />
        Copy setup command
      </button>
    </div>
  </div>

  <div class="mode-list" aria-label="Capture modes">
    <div class="mode-row is-ready">
      <span class="mode-row__icon"><Icon name="proxy" size={17} /></span>
      <span class="mode-row__text">
        <strong>Proxy capture</strong>
        <small>Recorded via proxy</small>
      </span>
      <span class="mode-row__status">Ready</span>
    </div>
    <div class="mode-row">
      <span class="mode-row__icon"><Icon name="logs" size={17} /></span>
      <span class="mode-row__text">
        <strong>Log watch</strong>
        <small>Observed from logs</small>
      </span>
      <span class="mode-row__status">Read-only</span>
    </div>
    <div class="mode-row">
      <span class="mode-row__icon"><Icon name="hook" size={17} /></span>
      <span class="mode-row__text">
        <strong>Hook &amp; OTel</strong>
        <small>Observed via hook</small>
      </span>
      <span class="mode-row__status">Soon</span>
    </div>
  </div>
</section>

<div class="stat-grid">
  <section class="stat glass" data-glass data-glass-depth="2">
    <span class="stat__label">Today</span>
    <span class="stat__value num">$0.00</span>
    <span class="stat__sub">No spend yet</span>
  </section>
  <section class="stat glass" data-glass data-glass-depth="2">
    <span class="stat__label">Guards</span>
    <span class="stat__value">On <span class="dot dot--ok"></span></span>
    <span class="stat__sub">7 rules active</span>
  </section>
  <section class="stat glass" data-glass data-glass-depth="2">
    <span class="stat__label">Approvals</span>
    <span class="stat__value num">0</span>
    <span class="stat__sub">Nothing waiting</span>
  </section>
</div>

<section class="recent glass" data-glass data-glass-depth="2">
  <div class="recent__head">
    <h3>Recent flights</h3>
    <button
      class="text-link"
      type="button"
      onclick={() => toast('The full flight list arrives in Phase 5.')}
    >
      View all
      <Icon name="arrow-right" size={14} />
    </button>
  </div>
  <div class="empty-row">
    <span class="empty-row__icon"><Icon name="plane" size={20} /></span>
    <span class="empty-row__text">
      <strong>No flights yet</strong>
      <small>Start an agent, or try a demo flight.</small>
    </span>
    <button class="btn btn--small btn--ghost" type="button" onclick={demo}>Try demo</button>
  </div>
</section>

<p class="preview-note">Shell preview · the four screens arrive in Phase 5</p>
