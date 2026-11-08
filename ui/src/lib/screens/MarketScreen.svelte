<script lang="ts">
  import Icon from '../Icon.svelte';
  import { toast } from '../toast-store.svelte';
</script>

<div class="screen-head">
  <div>
    <p class="kicker">Market</p>
    <h1>Skills and MCP servers</h1>
    <p class="screen-lede">
      A reviewed catalogue with pinned commits, permissions, and a diff before anything is written.
    </p>
  </div>
  <div class="screen-actions">
    <span class="status-pill"><span class="dot dot--ok"></span> Opens in Phase 8</span>
  </div>
</div>

<section class="empty-state card" data-glass data-glass-layer="card" data-glass-depth="2">
  <span class="empty-state__icon"><Icon name="market" size={24} /></span>
  <h2>The market is not open yet</h2>
  <p>
    The registry ships with the app in Phase 8. Every card will show a trust tier and the
    exact files an install will write. Nothing installs without your confirmation.
  </p>
  <div class="trust-row" aria-label="Trust tiers">
    <span class="status-pill status-pill--ok"><Icon name="check" size={13} /> Official</span>
    <span class="status-pill"><Icon name="shield" size={13} /> Community-reviewed</span>
    <span class="status-pill status-pill--warn"><Icon name="alert" size={13} /> Unreviewed</span>
  </div>
  <button class="btn btn--ghost" type="button" onclick={() => toast('The registry arrives in Phase 8.')}>
    Read the trust policy
  </button>
</section>
