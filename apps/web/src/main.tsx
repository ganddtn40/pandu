import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import { ApiProvider } from './lib/api-context';
import { LiveFeedProvider } from './lib/live';
import './styles/global.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Cockpit dashboard root element is missing.');
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <ApiProvider>
        <LiveFeedProvider>
          <App />
        </LiveFeedProvider>
      </ApiProvider>
    </BrowserRouter>
  </StrictMode>,
);
