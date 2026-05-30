import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import App from './App';

const rootEl = document.getElementById('root');
if (!rootEl) {
  // The root element is supplied by `index.html`; missing it means the
  // bundle is loaded into a foreign host page. Fail loudly so the issue
  // surfaces in DevTools instead of rendering into the void.
  throw new Error('Root element #root not found in document');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
