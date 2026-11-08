import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The backend has no CORS middleware and authenticates with an httpOnly cookie
// (SameSite=lax), so every request must be same-origin. The dev proxy makes that
// true in development; in production the same rules apply behind one origin.
export default defineConfig({
  plugins: [react()],
  // Served by Express at /app, so assets must resolve under the same prefix.
  base: '/app/',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.SAAS_SHIELD_API || 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
});
