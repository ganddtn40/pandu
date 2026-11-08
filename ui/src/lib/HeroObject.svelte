<script lang="ts">
  let { size = 320 }: { size?: number } = $props();
</script>

<svg
  class="hero-object"
  width={size}
  height={size}
  viewBox="0 0 320 320"
  role="img"
  aria-label="A graphite sphere held inside a silver ring"
>
  <defs>
    <radialGradient id="hero-bg" cx="0.34" cy="0.24" r="0.9">
      <stop offset="0" stop-color="#3a424d" />
      <stop offset="0.55" stop-color="#1a1f26" />
      <stop offset="1" stop-color="#0b0e12" />
    </radialGradient>
    <linearGradient id="hero-ring" x1="58" y1="48" x2="262" y2="278" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.98" />
      <stop offset="0.42" stop-color="#cfd8e2" stop-opacity="0.9" />
      <stop offset="0.72" stop-color="#8b98a7" stop-opacity="0.72" />
      <stop offset="1" stop-color="#4c5663" stop-opacity="0.5" />
    </linearGradient>
    <linearGradient id="hero-ring-shadow" x1="70" y1="260" x2="250" y2="70" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#000000" stop-opacity="0.6" />
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.16" />
    </linearGradient>
    <linearGradient id="hero-accent" x1="196" y1="62" x2="236" y2="104" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffc59b" />
      <stop offset="0.5" stop-color="#ff8a45" />
      <stop offset="1" stop-color="#e85f0c" />
    </linearGradient>
    <radialGradient id="hero-gloss" cx="0.34" cy="0.24" r="0.6">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.4" />
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0.06" />
      <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
    </radialGradient>
    <filter id="hero-blur" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="18" />
    </filter>
    <filter id="hero-shadow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#000000" flood-opacity="0.45" />
    </filter>
  </defs>

  <ellipse cx="160" cy="286" rx="92" ry="16" fill="#000000" opacity="0.28" filter="url(#hero-blur)" />

  <g filter="url(#hero-shadow)">
    <circle cx="160" cy="158" r="92" fill="url(#hero-bg)" />
    <circle cx="160" cy="158" r="92" fill="url(#hero-gloss)" />
    <ellipse cx="130" cy="118" rx="46" ry="30" fill="#ffffff" opacity="0.08" transform="rotate(-28 130 118)" />
  </g>

  <ellipse
    cx="160"
    cy="158"
    rx="128"
    ry="58"
    fill="none"
    stroke="url(#hero-ring)"
    stroke-width="10"
    transform="rotate(-24 160 158)"
  />
  <ellipse
    cx="160"
    cy="158"
    rx="128"
    ry="58"
    fill="none"
    stroke="url(#hero-ring-shadow)"
    stroke-width="2.5"
    transform="rotate(-24 160 158)"
    opacity="0.8"
  />
  <path
    d="M64 124c22-34 58-54 96-56"
    fill="none"
    stroke="#ffffff"
    stroke-opacity="0.5"
    stroke-width="3"
    stroke-linecap="round"
    transform="rotate(-24 160 158)"
  />

  <circle cx="216" cy="82" r="15" fill="url(#hero-accent)" />
  <circle cx="216" cy="82" r="5.4" fill="#fff5ec" opacity="0.92" />
  <circle cx="216" cy="82" r="24" fill="#ff7a2f" opacity="0.16" filter="url(#hero-blur)" />
</svg>
