import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { initDesign } from './lib/design/design.svelte';
import './lib/design/widgets.svelte';
import { isOnboarded } from './lib/onboarding.svelte';
import { navigate } from './lib/router.svelte';

// First run opens the tour before the shell paints, so the dashboard never
// flashes for someone who has not chosen an agent yet. `navigate` also updates
// the reactive route: the router module initializes from the URL during import,
// which happens before this module body runs.
if (!isOnboarded() && window.location.pathname !== '/welcome') {
  navigate('/welcome', { replace: true, keepSearch: false });
}

initDesign();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
