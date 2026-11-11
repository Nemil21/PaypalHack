import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { loadClientConfig } from './lib/client-config';
import './styles.css';

// Runtime config (AG licence, demo flag) comes from the API before the first render, so AG
// components register their licence before they mount. The landing page (HF-057) uses no config,
// so `/` paints without waiting for the round trip; the request still runs in the background.
const config = loadClientConfig();
if (window.location.pathname !== '/') await config;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
