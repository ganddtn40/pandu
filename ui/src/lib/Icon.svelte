<script lang="ts">
const paths: Record<string, string[]> = {
  home: ['M4 10.5 12 4l8 6.5', 'M6.5 9.5V20h11V9.5', 'M10 20v-5h4v5'],
  plane: ['M21 3 10.5 13.5', 'M21 3 14 21l-3.5-7.5L3 10 21 3Z'],
  approvals: [
    'M12 3 5 6v5.2c0 4.4 2.9 7.7 7 9.8 4.1-2.1 7-5.4 7-9.8V6l-7-3Z',
    'm9 11.8 2.1 2.1 4-4.1',
  ],
  settings: [
    'M4 7h8',
    'M16 7h4',
    'M4 17h4',
    'M12 17h8',
    'M14 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
    'M10 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  ],
  bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9', 'M10 21h4'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.3-4.3'],
  sun: [
    'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z',
    'M12 2v2',
    'M12 20v2',
    'M4.9 4.9l1.4 1.4',
    'M17.7 17.7l1.4 1.4',
    'M2 12h2',
    'M20 12h2',
    'M4.9 19.1l1.4-1.4',
    'M17.7 6.3l1.4-1.4',
  ],
  moon: ['M20.5 14.2A8.6 8.6 0 0 1 9.8 3.5 8.7 8.7 0 1 0 20.5 14.2Z'],
  plus: ['M12 5v14', 'M5 12h14'],
  'arrow-right': ['M5 12h14', 'm13 6 6 6-6 6'],
  copy: ['M8 8h11v11H8z', 'M5 15H4V4h11v1'],
  check: ['m5 12 4 4L19 6'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
  proxy: ['M7 7h10v10H7z', 'M3 12h4', 'M17 12h4', 'm5 10-2 2 2 2', 'm19 10 2 2-2 2'],
  logs: ['M7 3h7l4 4v14H7z', 'M14 3v4h4', 'M10 12h6', 'M10 16h6'],
  hook: [
    'M10 13a5 5 0 0 0 7.1 0l1.4-1.4a5 5 0 0 0-7.1-7.1L10 5.9',
    'M14 11a5 5 0 0 0-7.1 0L5.5 12.4a5 5 0 0 0 7.1 7.1L14 18.1',
  ],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
  shield: ['M12 3 5 6v5.2c0 4.4 2.9 7.7 7 9.8 4.1-2.1 7-5.4 7-9.8V6l-7-3Z'],
  wallet: ['M4 7h16v12H4z', 'M4 7V5h13v2', 'M16 13h4'],
  coins: [
    'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3Z',
    'M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5',
    'M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  ],
  'chevron-right': ['m9 5 7 7-7 7'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
  external: ['M14 4h6v6', 'M20 4 11 13', 'M19 14v5H5V5h5'],
  play: ['m8 5 11 7-11 7V5Z'],
  pause: ['M9 5v14', 'M15 5v14'],
};

interface Props {
  name: string;
  size?: number;
  stroke?: number;
  className?: string;
}

let { name, size = 20, stroke = 1.7, className = '' }: Props = $props();

const shapes = $derived(paths[name] ?? []);
</script>

<svg
  class={className}
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each shapes as d}
    <path {d} />
  {/each}
</svg>
