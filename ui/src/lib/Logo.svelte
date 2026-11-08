<script lang="ts">
  let { size = 36, className = '' }: { size?: number; className?: string } = $props();

  // At 16-24px the detailed gradients and hairline rings turn to mush. The
  // small variant keeps only the silhouette, ring, needle, and accent dot.
  const simplified = $derived(size < 28);
</script>

{#if simplified}
  <svg
    class={className}
    width={size}
    height={size}
    viewBox="0 0 32 32"
    role="img"
    aria-label="Cockpit"
  >
    <rect x="2" y="2" width="28" height="28" rx="9" fill="#171b21" />
    <rect
      x="2.6"
      y="2.6"
      width="26.8"
      height="26.8"
      rx="8.4"
      fill="none"
      stroke="#ffffff"
      stroke-opacity="0.16"
      stroke-width="1.2"
    />
    <circle cx="16" cy="16" r="8.7" fill="none" stroke="#e8edf3" stroke-width="2.4" />
    <path d="M16 16V8.6" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" />
    <path
      d="m16 16 4.2 4.2"
      stroke="#e8edf3"
      stroke-opacity="0.55"
      stroke-width="1.8"
      stroke-linecap="round"
    />
    <circle cx="16" cy="8.6" r="2.7" fill="#ff7a2f" />
    <circle cx="16" cy="8.6" r="1" fill="#fff6ee" />
  </svg>
{:else}
  <svg
    class={className}
    width={size}
    height={size}
    viewBox="0 0 64 64"
    role="img"
    aria-label="Cockpit"
  >
    <defs>
      <linearGradient id="cockpit-mark-shell" x1="10" y1="6" x2="54" y2="60" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#3a424d" />
        <stop offset="0.52" stop-color="#1a1f26" />
        <stop offset="1" stop-color="#0b0e12" />
      </linearGradient>
      <linearGradient id="cockpit-mark-ring" x1="18" y1="16" x2="46" y2="50" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.96" />
        <stop offset="0.55" stop-color="#c9d4df" stop-opacity="0.86" />
        <stop offset="1" stop-color="#7f8d9c" stop-opacity="0.72" />
      </linearGradient>
      <linearGradient id="cockpit-mark-gloss" x1="14" y1="6" x2="46" y2="38" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.28" />
        <stop offset="0.55" stop-color="#ffffff" stop-opacity="0.04" />
        <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
      </linearGradient>
      <radialGradient id="cockpit-mark-glow" cx="0.72" cy="0.18" r="0.8">
        <stop offset="0" stop-color="#ffb27a" stop-opacity="0.28" />
        <stop offset="1" stop-color="#ff7a2f" stop-opacity="0" />
      </radialGradient>
      <linearGradient id="cockpit-mark-accent" x1="38" y1="16" x2="50" y2="28" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#ffb27a" />
        <stop offset="1" stop-color="#ff6a1a" />
      </linearGradient>
    </defs>

    <path
      d="M32 4C49.8 4 60 14.2 60 32S49.8 60 32 60 4 49.8 4 32 14.2 4 32 4Z"
      fill="url(#cockpit-mark-shell)"
    />
    <path
      d="M32 4C49.8 4 60 14.2 60 32S49.8 60 32 60 4 49.8 4 32 14.2 4 32 4Z"
      fill="url(#cockpit-mark-glow)"
    />
    <path
      d="M32 4C49.8 4 60 14.2 60 32S49.8 60 32 60 4 49.8 4 32 14.2 4 32 4Z"
      fill="url(#cockpit-mark-gloss)"
    />

    <circle
      cx="32"
      cy="32"
      r="18.5"
      fill="none"
      stroke="url(#cockpit-mark-ring)"
      stroke-width="2.6"
    />
    <circle cx="32" cy="32" r="12.6" fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="1" />
    <path
      d="M32 32 32 19.8"
      fill="none"
      stroke="#ffffff"
      stroke-opacity="0.7"
      stroke-width="2.1"
      stroke-linecap="round"
    />
    <path
      d="M32 32 39.6 39.6"
      fill="none"
      stroke="#ffffff"
      stroke-opacity="0.28"
      stroke-width="1.6"
      stroke-linecap="round"
    />
    <circle cx="32" cy="19.8" r="3.3" fill="url(#cockpit-mark-accent)" />
    <circle cx="32" cy="19.8" r="1.2" fill="#fff6ee" fill-opacity="0.9" />
    <path
      d="M17.4 17.4C21.2 13.6 26.2 11.4 31.6 11.2"
      fill="none"
      stroke="#ffffff"
      stroke-opacity="0.42"
      stroke-width="1.4"
      stroke-linecap="round"
    />
  </svg>
{/if}
