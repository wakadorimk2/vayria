import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import CardsPreviewPage from './cards/CardsPreviewPage';
import './styles.css';
import { runtimeConfig } from './runtimeConfig';
import PublicControls from './public/PublicControls';
import './public/public.css';

const RootPage = window.location.pathname === '/cards' ? CardsPreviewPage : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {runtimeConfig.mode === 'public' ? <div className="public-layout"><App /><PublicControls /></div> : <RootPage />}
  </StrictMode>,
);
