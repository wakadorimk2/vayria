import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import CardsPreviewPage from './cards/CardsPreviewPage';
import './styles.css';

const RootPage = window.location.pathname === '/cards' ? CardsPreviewPage : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootPage />
  </StrictMode>,
);
