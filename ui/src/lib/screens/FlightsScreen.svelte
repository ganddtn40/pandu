<script lang="ts">
  import Icon from '../Icon.svelte';
  import { toast } from '../toast-store.svelte';
</script>

<div class="screen-head">
  <div>
    <p class="kicker">Flights</p>
    <h1>Every run, recorded</h1>
    <p class="screen-lede">
      Open a flight to see live output, replay the timeline, inspect diffs, and fork from a step.
    </p>
  </div>
  <div class="screen-actions">
    <button class="btn btn--primary" type="button" onclick={() => toast('Start an agent to create a flight.')}>
      <Icon name="plus" size={16} />
      New flight
    </button>
  </div>
</div>

<section class="empty-state card" data-glass data-glass-layer="card" data-glass-depth="2">
  <span class="empty-state__icon"><Icon name="plane" size={24} /></span>
  <h2>No flights yet</h2>
  <p>
    Start an agent and Cockpit records the request, every tool call, the files it touched, and
    the final result. Nothing leaves this machine.
  </p>
  <div class="button-row">
    <button class="btn btn--primary" type="button" onclick={() => toast('Demo flights arrive in Phase 5.')}>
      Try a demo flight
    </button>
    <button class="btn btn--ghost" type="button" onclick={() => toast('Setup guide arrives in Phase 12.')}>
      How to start an agent
    </button>
  </div>
</section>

<div class="info-grid">
  <section class="card info-card">
    <span class="info-card__icon"><Icon name="terminal" size={18} /></span>
    <h3>Live output</h3>
    <p>Watch the terminal or structured steps as they happen, virtualized for long runs.</p>
  </section>
  <section class="card info-card">
    <span class="info-card__icon"><Icon name="fork" size={18} /></span>
    <h3>Fork from any step</h3>
    <p>Branch a new run from a recorded step without losing the original flight.</p>
  </section>
</div>
