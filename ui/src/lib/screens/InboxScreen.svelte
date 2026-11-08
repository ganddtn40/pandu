<script lang="ts">
  import Icon from '../Icon.svelte';
  import { toast } from '../toast-store.svelte';
</script>

<div class="screen-head">
  <div>
    <p class="kicker">Inbox</p>
    <h1>Nothing needs you</h1>
    <p class="screen-lede">
      Approvals, questions, auth requests, finished runs, and errors land here.
    </p>
  </div>
  <div class="screen-actions">
    <span class="status-pill"><span class="dot dot--ok"></span> All clear</span>
  </div>
</div>

<section class="empty-state card" data-glass data-glass-layer="card" data-glass-depth="2">
  <span class="empty-state__icon"><Icon name="inbox" size={24} /></span>
  <h2>You are all caught up</h2>
  <p>
    When an agent needs permission or asks a question, it will appear here with one clear
    action. Nothing is waiting right now.
  </p>
  <div class="button-row">
    <button class="btn btn--primary" type="button" onclick={() => toast('Demo approvals arrive in Phase 5.')}>
      Try a demo approval
    </button>
    <button class="btn btn--ghost" type="button" onclick={() => toast('Notification settings arrive in Phase 6.')}>
      Notification settings
    </button>
  </div>
</section>

<div class="info-grid">
  <section class="card info-card">
    <span class="info-card__icon"><Icon name="shield" size={18} /></span>
    <h3>Approvals stay explicit</h3>
    <p>Approve or deny from the phone. Cockpit never guesses on a risky action.</p>
  </section>
  <section class="card info-card">
    <span class="info-card__icon"><Icon name="clock" size={18} /></span>
    <h3>Deep links, not noise</h3>
    <p>Every notification opens the exact flight and step that needs you.</p>
  </section>
</div>
