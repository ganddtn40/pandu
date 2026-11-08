<script lang="ts">
  import { onDestroy } from 'svelte';
  import Icon from './Icon.svelte';
  import { openQuickPrompt } from './quick-prompt.svelte';
  import { toast } from './toast-store.svelte';
  import {
    moveWidgetBy,
    reorderWidgetBefore,
    resetWidgetLayout,
    toggleWidgetHidden,
    widgetState,
  } from './design/widgets.svelte';
  import { visibleWidgets, type WidgetId } from './design/widgets';

  const labels: Record<WidgetId, string> = {
    live: 'Live flight',
    spend: 'Spend today',
    tokens: 'Context',
    guards: 'Guards',
    approvals: 'Approvals',
    activity: 'Spend trend',
    recent: 'Recent flights',
    agents: 'Agents',
  };

  let editing = $state(false);
  let dragId = $state<WidgetId | null>(null);
  let dragPointer = -1;
  let longPressTimer = 0;
  let pressStart = { x: 0, y: 0 };

  const widgets = $derived(visibleWidgets(widgetState));

  function startEditing(): void {
    editing = true;
  }

  function finishEditing(): void {
    editing = false;
    endDrag();
  }

  function onTilePointerDown(event: PointerEvent): void {
    if (editing || event.pointerType !== 'touch') return;
    pressStart = { x: event.clientX, y: event.clientY };
    window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(startEditing, 520);
  }

  function cancelLongPress(): void {
    window.clearTimeout(longPressTimer);
  }

  function onTilePointerMove(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    if (Math.abs(event.clientX - pressStart.x) > 10 || Math.abs(event.clientY - pressStart.y) > 10) {
      cancelLongPress();
    }
  }

  function startDrag(event: PointerEvent, id: WidgetId): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragId = id;
    dragPointer = event.pointerId;
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }

  function onDragMove(event: PointerEvent): void {
    if (!dragId || event.pointerId !== dragPointer) return;
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-widget]');
    const beforeId = target?.dataset.widget as WidgetId | undefined;
    if (beforeId && beforeId !== dragId) {
      reorderWidgetBefore(dragId, beforeId);
    }
  }

  function endDrag(): void {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    dragId = null;
    dragPointer = -1;
  }

  function hide(id: WidgetId): void {
    toggleWidgetHidden(id);
  }

  onDestroy(() => {
    cancelLongPress();
    endDrag();
  });
</script>

<div class="screen-head">
  <div>
    <p class="kicker">Home</p>
    <h1>Overview</h1>
    <p class="screen-lede">
      A calm view of every agent, every flight, and everything that needs you.
    </p>
  </div>
  <div class="screen-actions">
    <span class="status-pill"><span class="dot dot--ok"></span> Preview data</span>
    <button class="btn btn--ghost" type="button" onclick={() => (editing ? finishEditing() : startEditing())}>
      <Icon name={editing ? 'check' : 'grid'} size={16} />
      {editing ? 'Done' : 'Customize'}
    </button>
    <button class="btn btn--primary" type="button" onclick={openQuickPrompt}>
      <Icon name="sparkles" size={16} />
      Quick prompt
    </button>
  </div>
</div>

{#if editing}
  <div class="edit-note card">
    <span class="edit-note__icon"><Icon name="grip" size={16} /></span>
    <p>Drag a tile by its handle, or use the arrows. Changes save on this device.</p>
    <button class="text-link" type="button" onclick={resetWidgetLayout}>
      <Icon name="rotate" size={14} />
      Reset layout
    </button>
  </div>
{/if}

<div class="bento" class:is-editing={editing} role="region" aria-label="Home widgets">
  {#each widgets as id (id)}
    <section
      class="tile tile--{id} card"
      class:is-editing={editing}
      class:is-dragging={dragId === id}
      role="group"
      aria-label={labels[id]}
      data-widget={id}
      data-glass
      data-glass-layer="card"
      data-glass-depth="2"
      onpointerdown={onTilePointerDown}
      onpointermove={onTilePointerMove}
      onpointerup={cancelLongPress}
      onpointercancel={cancelLongPress}
      oncontextmenu={(event) => {
        if (editing) event.preventDefault();
      }}
    >
      <div class="tile__head">
        <span class="tile__label">{labels[id]}</span>
        <div class="tile__actions">
          {#if editing}
            <button
              class="tile__action"
              type="button"
              aria-label={`Move ${labels[id]} up`}
              onclick={() => moveWidgetBy(id, -1)}
            >
              <Icon name="arrow-up" size={15} />
            </button>
            <button
              class="tile__action"
              type="button"
              aria-label={`Move ${labels[id]} down`}
              onclick={() => moveWidgetBy(id, 1)}
            >
              <Icon name="arrow-down" size={15} />
            </button>
            <button
              class="tile__action"
              type="button"
              aria-label={`Hide ${labels[id]}`}
              onclick={() => hide(id)}
            >
              <Icon name="eye-off" size={15} />
            </button>
          {/if}
          <button
            class="tile__drag"
            type="button"
            aria-label={`Drag ${labels[id]}`}
            onpointerdown={(event) => startDrag(event, id)}
          >
            <Icon name="grip" size={16} />
          </button>
        </div>
      </div>

      {#if id === 'live'}
        <div class="live-grid">
          <div class="live-main">
            <span class="eyebrow"><span class="dot dot--live"></span> Live · opencode</span>
            <h2>Refactoring the auth flow</h2>
            <p class="tile__body">
              Editing <code>src/auth/session.ts</code> · step 24 of 38
            </p>
            <div class="live-steps">
              <div class="live-step">
                <span class="live-step__dot is-done"></span>
                <span>Read session store</span>
                <small>done</small>
              </div>
              <div class="live-step">
                <span class="live-step__dot is-done"></span>
                <span>Update token refresh</span>
                <small>done</small>
              </div>
              <div class="live-step is-active">
                <span class="live-step__dot"></span>
                <span>Run auth tests</span>
                <small>running</small>
              </div>
            </div>
            <div class="button-row">
              <button
                class="btn btn--primary"
                type="button"
                onclick={() => toast('The flight detail screen arrives in Phase 5.')}
              >
                Open flight
              </button>
              <button class="btn btn--ghost" type="button" onclick={openQuickPrompt}>
                Reply
              </button>
            </div>
          </div>
          <div class="live-side">
            <div class="mini-stat"><span>Elapsed</span><strong>04:12</strong></div>
            <div class="mini-stat"><span>Cost</span><strong>$0.42</strong></div>
            <div class="mini-stat"><span>Tokens</span><strong>18.4k</strong></div>
            <div class="mini-stat"><span>Guard</span><strong class="ok">Armed</strong></div>
          </div>
        </div>
      {:else if id === 'spend'}
        <span class="tile__value">$0.42</span>
        <span class="tile__sub">Today · 3 flights</span>
        <svg class="spark" viewBox="0 0 120 34" aria-hidden="true">
          <path
            d="M2 26 18 24 34 27 50 18 66 20 82 12 98 15 118 7"
            fill="none"
            stroke="var(--accent)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      {:else if id === 'tokens'}
        <span class="tile__value">18.4k</span>
        <span class="tile__sub">64% of a 32k context</span>
        <div class="meter" aria-hidden="true"><span style="width: 64%"></span></div>
      {:else if id === 'guards'}
        <span class="tile__value tile__value--status"><span class="dot dot--ok"></span> Armed</span>
        <span class="tile__sub">7 rules · 0 blocks today</span>
      {:else if id === 'approvals'}
        <span class="tile__value">1</span>
        <span class="tile__sub"><span class="dot dot--warn"></span> Waiting for your answer</span>
      {:else if id === 'activity'}
        <div class="activity-head">
          <div>
            <span class="tile__value tile__value--md">$2.18</span>
            <span class="tile__sub">Spend over the last 7 days</span>
          </div>
          <span class="status-pill status-pill--ok"><span class="dot dot--ok"></span> On budget</span>
        </div>
        <svg class="chart" viewBox="0 0 360 110" role="img" aria-label="Spend over the last seven days">
          <defs>
            <linearGradient id="cockpit-chart-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="var(--accent)" stop-opacity="0.26" />
              <stop offset="1" stop-color="var(--accent)" stop-opacity="0" />
            </linearGradient>
          </defs>
          <path
            d="M0 92 60 84 120 88 180 58 240 66 300 34 360 42 360 110 0 110Z"
            fill="url(#cockpit-chart-fill)"
          />
          <path
            d="M0 92 60 84 120 88 180 58 240 66 300 34 360 42"
            fill="none"
            stroke="var(--accent)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <div class="chart-axis" aria-hidden="true">
          <span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span>
        </div>
      {:else if id === 'recent'}
        <div class="list">
          <button class="list-row" type="button" onclick={() => toast('Flight detail arrives in Phase 5.')}>
            <span class="list-row__icon"><Icon name="plane" size={16} /></span>
            <span class="list-row__text"><strong>Auth refactor</strong><small>opencode · 2 min ago</small></span>
            <span class="list-row__meta"><span class="status-pill status-pill--ok">Done</span><span class="list-row__cost">$0.42</span></span>
          </button>
          <button class="list-row" type="button" onclick={() => toast('Inbox arrives in Phase 5.')}>
            <span class="list-row__icon"><Icon name="inbox" size={16} /></span>
            <span class="list-row__text"><strong>Fix flaky test</strong><small>claude-code · 1 hour ago</small></span>
            <span class="list-row__meta"><span class="status-pill status-pill--warn">Needs you</span><span class="list-row__cost">$0.18</span></span>
          </button>
          <button class="list-row" type="button" onclick={() => toast('Flight detail arrives in Phase 5.')}>
            <span class="list-row__icon"><Icon name="logs" size={16} /></span>
            <span class="list-row__text"><strong>Update docs</strong><small>opencode · 3 hours ago</small></span>
            <span class="list-row__meta"><span class="status-pill">View only</span><span class="list-row__cost">$0.07</span></span>
          </button>
        </div>
      {:else if id === 'agents'}
        <div class="agent-list">
          <div class="agent-row">
            <span class="agent-row__avatar">O</span>
            <span class="agent-row__text"><strong>opencode</strong><small>2 sessions · full control</small></span>
            <span class="dot dot--live"></span>
          </div>
          <div class="agent-row">
            <span class="agent-row__avatar agent-row__avatar--quiet">C</span>
            <span class="agent-row__text"><strong>claude-code</strong><small>1 session · view only</small></span>
            <span class="dot"></span>
          </div>
        </div>
        <button class="text-link" type="button" onclick={() => toast('Agent setup arrives in Phase 5.')}>
          Manage agents
          <Icon name="arrow-right" size={14} />
        </button>
      {/if}
    </section>
  {/each}
</div>

{#if widgets.length === 0}
  <div class="empty-state card">
    <span class="empty-state__icon"><Icon name="grid" size={22} /></span>
    <h2>Your board is empty</h2>
    <p>Show a widget again to bring the overview back.</p>
    <button class="btn btn--primary" type="button" onclick={resetWidgetLayout}>Reset layout</button>
  </div>
{/if}

{#if editing && widgetState.hidden.length > 0}
  <section class="hidden-tray card" aria-label="Hidden widgets">
    <span class="tile__label">Hidden widgets</span>
    <div class="hidden-tray__list">
      {#each widgetState.hidden as id (id)}
        <button class="btn btn--small btn--ghost" type="button" onclick={() => toggleWidgetHidden(id)}>
          <Icon name="eye" size={15} />
          Show {labels[id]}
        </button>
      {/each}
    </div>
  </section>
{/if}

<p class="preview-note">
  Preview data only · the daemon connection and real flights arrive in Phase 5
</p>
