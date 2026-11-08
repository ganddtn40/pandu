import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { initDesign } from './lib/design/design.svelte';
import './lib/design/widgets.svelte';

initDesign();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
