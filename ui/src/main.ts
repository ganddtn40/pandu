import { mount } from 'svelte';
import App from './App.svelte';
import RemoteApp from './lib/RemoteApp.svelte';
import './app.css';
import { detectRemoteListener } from './lib/api/client';
import { initDesign } from './lib/design/design.svelte';
import './lib/design/widgets.svelte';
import { isOnboarded } from './lib/onboarding.svelte';
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
    mount(RemoteApp, { target });
    return;
  }

  // First run opens the tour before the shell paints, so the dashboard never
  // flashes for someone who has not chosen an agent yet. `navigate` also updates
  // the reactive route: the router module initializes from the URL during import,
  // which happens before this module body runs.
  if (!isOnboarded() && window.location.pathname !== '/welcome') {
    navigate('/welcome', { replace: true, keepSearch: false });
  }

  mount(App, { target });
}

void boot();
