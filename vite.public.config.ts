import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  base: mode === 'staging' ? '/staging/' : '/',
  plugins: [react()],
  // Public bundles never load local environment files or Vite API middleware.
  envDir: 'deploy/public-env',
  publicDir: '.public-assets',
  define: { 'import.meta.env.VITE_MANIFESTATION_ENABLED': JSON.stringify(mode === 'staging' ? 'true' : 'false'), 'import.meta.env.VITE_APP_MODE': JSON.stringify('public'), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(mode === 'staging' ? '/staging' : '') },
  build: { outDir: 'dist-public', sourcemap: false, assetsInlineLimit: 0 },
}));
