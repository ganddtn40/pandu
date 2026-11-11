<script lang="ts">
  import { t } from './i18n/i18n.svelte';
  import { parseMarkdown, type MarkdownInline } from './markdown';

  let { source }: { source: string } = $props();

  const blocks = $derived(parseMarkdown(source));

  let pending = $state<{ href: string; label: string } | null>(null);

  function askToOpen(node: Extract<MarkdownInline, { type: 'link' }>): void {
    if (!node.href) return;
    pending = { href: node.href, label: node.label };
  }

  function openPending(): void {
    if (!pending) return;
    window.open(pending.href, '_blank', 'noopener,noreferrer');
    pending = null;
  }
</script>

{#snippet inline(nodes: MarkdownInline[])}
  {#each nodes as node, index (index)}
    {#if node.type === 'code'}
      <code>{node.value}</code>
    {:else if node.type === 'strong'}
      <strong>{node.value}</strong>
    {:else if node.type === 'link'}
      {#if node.href}
        <button
          class="md-link"
          type="button"
          data-md-link={node.href}
          title={node.href}
          onclick={() => askToOpen(node)}
        >
          {node.label}
        </button>
      {:else}
        <span class="md-link md-link--plain" data-md-link-unsafe>{node.label}</span>
      {/if}
    {:else}
      {node.value}
    {/if}
  {/each}
{/snippet}

<div class="safe-markdown" data-safe-markdown>
  {#each blocks as block, index (index)}
    {#if block.type === 'heading'}
      {#if block.level === 1}
        <h3>{@render inline(block.content)}</h3>
      {:else if block.level === 2}
        <h4>{@render inline(block.content)}</h4>
      {:else}
        <h5>{@render inline(block.content)}</h5>
      {/if}
    {:else if block.type === 'list'}
      {#if block.ordered}
        <ol>
          {#each block.items as item, itemIndex (itemIndex)}
            <li>{@render inline(item)}</li>
          {/each}
        </ol>
      {:else}
        <ul>
          {#each block.items as item, itemIndex (itemIndex)}
            <li>{@render inline(item)}</li>
          {/each}
        </ul>
      {/if}
    {:else}
      <p>{@render inline(block.content)}</p>
    {/if}
  {/each}

  {#if pending}
    <div
      class="safe-markdown__confirm"
      role="group"
      aria-label={t('update.openLinkTitle')}
      data-md-link-confirm
    >
      <strong>{t('update.openLinkTitle')}</strong>
      <p>{t('update.openLinkBody')}</p>
      <code class="safe-markdown__url">{pending.href}</code>
      <div class="button-row button-row--tight">
        <button
          class="btn btn--small btn--primary"
          type="button"
          data-md-link-open
          onclick={openPending}
        >
          {t('update.openLinkOpen')}
        </button>
        <button
          class="btn btn--small btn--ghost"
          type="button"
          data-md-link-cancel
          onclick={() => {
            pending = null;
          }}
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  {/if}
</div>
