import { publicPagePath } from './public/paths';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import CardsPreviewPage from './cards/CardsPreviewPage';
import './styles.css';
import { runtimeConfig } from './runtimeConfig';
import './public/public.css';
import { initializePublicTheme } from './public/theme';
import PublicApp from './public/PublicApp';
import ExhibitionRegistrationPage from './public/ExhibitionRegistrationPage';
import WorldParticipantPage from './sharedWorld/WorldParticipantPage';

if (runtimeConfig.mode === 'public' || runtimeConfig.worldMutationEnabled) initializePublicTheme();

const RootPage = window.location.pathname === '/cards' ? CardsPreviewPage : App;
const PublicPage = import.meta.env.VITE_SHARED_WORLD_ENABLED==='true' && /^\/world\/[\w-]+\/?$/.test(publicPagePath(window.location.pathname)) ? WorldParticipantPage : /^\/exhibition\/?$/.test(publicPagePath(window.location.pathname)) ? ExhibitionRegistrationPage : PublicApp;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {runtimeConfig.mode === 'public' ? <PublicPage /> : runtimeConfig.worldMutationEnabled ? <div className="public-layout"><App /></div> : <RootPage />}
  </StrictMode>,
);
