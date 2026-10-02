/**
 * @file main.tsx
 * @description React application entry point.
 * Phase 5 will complete the App component with the full UI overlay.
 * This file is the mounting point and CSS import chain.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Remove loading screen once React is ready
const loadingScreen = document.getElementById('loading-screen');
if (loadingScreen) {
  loadingScreen.style.transition = 'opacity 0.4s ease';
  loadingScreen.style.opacity    = '0';
  setTimeout(() => loadingScreen.remove(), 400);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
