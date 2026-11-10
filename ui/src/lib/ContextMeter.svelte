<script lang="ts">
  import type { ContextMeter as ContextMeterData } from './api/types';
  import { formatTokens } from './format';
  import { t } from './i18n/i18n.svelte';

  let {
    meter,
    compact = false,
    label,
  }: { meter: ContextMeterData; compact?: boolean; label?: string } = $props();

  const percent = $derived(meter.percent);
  const width = $derived(percent === undefined ? 0 : Math.min(100, Math.max(0, percent)));
  const thresholdLeft = $derived(Math.min(100, Math.max(0, meter.threshold * 100)));
  const percentText = $derived(
    percent === undefined ? t('context.unknown') : `${percent.toFixed(1)}%`,
  );
  const summary = $derived(
    meter.window
      ? t('context.summary', {
          used: formatTokens(meter.tokens),
          window: formatTokens(meter.window),
        })
      : t('context.used', { used: formatTokens(meter.tokens) }),
  );
</script>

<div
  class="context-meter"
  class:context-meter--compact={compact}
  class:is-high={meter.high}
  data-context-meter
  data-context-percent={percent ?? ''}
  data-context-high={meter.high ? 'true' : 'false'}
>
  <div class="context-meter__head">
    <span class="context-meter__label">{label ?? t('context.title')}</span>
    <strong class="context-meter__value">{percentText}</strong>
  </div>
  <div
    class="context-meter__bar"
    role="img"
    aria-label={`${label ?? t('context.title')}: ${percentText} · ${summary}`}
  >
    <span class="context-meter__fill" style={`width: ${width}%`}></span>
    {#if meter.threshold > 0 && meter.threshold < 1}
      <span class="context-meter__threshold" style={`left: ${thresholdLeft}%`}></span>
    {/if}
  </div>
  <div class="context-meter__meta">
    <span>{summary}</span>
    <span>{meter.source === 'provider' ? t('context.provider') : t('context.estimated')}</span>
  </div>
  {#if meter.high || meter.compacted}
    <div class="context-meter__badges">
      {#if meter.high}
        <span class="status-pill status-pill--warn">{t('context.high')}</span>
      {/if}
      {#if meter.compacted}
        <span class="status-pill">{t('context.compacted')}</span>
      {/if}
    </div>
  {/if}
  {#if !compact}
    <dl class="context-meter__breakdown">
      <div><dt>{t('context.system')}</dt><dd>{formatTokens(meter.breakdown.system)}</dd></div>
      <div><dt>{t('context.tools')}</dt><dd>{formatTokens(meter.breakdown.tools)}</dd></div>
      <div><dt>{t('context.history')}</dt><dd>{formatTokens(meter.breakdown.history)}</dd></div>
      <div><dt>{t('context.files')}</dt><dd>{formatTokens(meter.breakdown.files)}</dd></div>
      <div><dt>{t('context.other')}</dt><dd>{formatTokens(meter.breakdown.other)}</dd></div>
    </dl>
  {/if}
</div>
