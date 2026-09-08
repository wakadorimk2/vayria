import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import CardsPreviewPage from './cards/CardsPreviewPage';
import './styles.css';
import { runtimeConfig } from './runtimeConfig';
import './public/public.css';
import { initializePublicTheme } from './public/theme';

if (runtimeConfig.mode === 'public') initializePublicTheme();

const RootPage = window.location.pathname === '/cards' ? CardsPreviewPage : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {runtimeConfig.mode === 'public' ? <div className="public-layout"><App /></div> : <RootPage />}
  </StrictMode>,
);
