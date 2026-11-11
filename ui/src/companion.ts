import { mount } from 'svelte';
import './app.css';
import CompanionApp from './lib/companion/CompanionApp.svelte';
import { bootCompanion } from './lib/companion/native';
import { initDesign } from './lib/design/design.svelte';
import './lib/design/widgets.svelte';

/**
 * The Android companion entry point. It shares the bundle with the host UI but
 * mounts only the remote dashboard. The host origin and device token are
 * restored from native storage before `RemoteApp` initializes.
 */
async function boot(): Promise<void> {
  initDesign();
  await bootCompanion();
  const target = document.getElementById('app');
  if (target) mount(CompanionApp, { target });
}

void boot();
