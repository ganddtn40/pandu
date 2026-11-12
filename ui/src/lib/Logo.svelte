<script lang="ts">
  import { LOGO_ARIA_LABEL } from './brand';

  let { size = 36, className = '' }: { size?: number; className?: string } = $props();

  // At 16-24px the glossy raster icon loses its detail. The small variant is
  // a flat, gradient-free mark that stays legible in a tab or a tiny slot.
  const simplified = $derived(size < 28);
  const src = $derived(simplified ? '/logo-small.svg' : '/icons/icon-192.png');
</script>

<img
  class={className}
  {src}
  width={size}
  height={size}
  alt={LOGO_ARIA_LABEL}
  decoding="async"
  draggable="false"
/>
