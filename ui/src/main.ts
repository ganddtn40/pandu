import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { detectRemoteListener } from './lib/api/client';
import { initDesktop } from './lib/desktop';
import { initDesign } from './lib/design/design.svelte';
import './lib/design/widgets.svelte';
import { isOnboarded } from './lib/onboarding.svelte';
import { registerServiceWorker } from './lib/pwa';
import { navigate } from './lib/router.svelte';

/**
 * The remote listener serves this same bundle. Probe before the host
 * onboarding redirect so a phone never lands in the first-run tour, and never
 * mount the host shell on a remote origin.
 */
async function boot(): Promise<void> {
  initDesign();
  const target = document.getElementById('app')!;

  if (await detectRemoteListener()) {
    // The remote listener is a different app: load its shell only when this
    // origin actually is one, so the host never parses or preloads it.
    const { default: RemoteApp } = await import('./lib/RemoteApp.svelte');
    mount(RemoteApp, { target });
    return;
  }

  // The desktop shell delivers `pandu://` links before the shell paints. A link
  // the user explicitly opened wins over the first-run redirect.
  const deepLink = await initDesktop();

  // First run opens the tour before the shell paints, so the dashboard never
  // flashes for someone who has not chosen an agent yet. `navigate` also updates
  // the reactive route: the router module initializes from the URL during import,
  // which happens before this module body runs.
  if (!isOnboarded() && !deepLink && window.location.pathname !== '/welcome') {
    navigate('/welcome', { replace: true, keepSearch: false });
  }

  registerServiceWorker();
  mount(App, { target });
}

void boot();
