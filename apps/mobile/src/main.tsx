import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Cockpit mobile could not find the root element.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
