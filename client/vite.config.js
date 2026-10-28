import process from 'node:process'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  if (mode === 'production') {
    const env = loadEnv(mode, process.cwd(), '');
    const apiBaseUrl = process.env.VITE_API_BASE_URL || env.VITE_API_BASE_URL;
    if (!apiBaseUrl?.trim()) {
      throw new Error('VITE_API_BASE_URL must be configured for production builds.');
    }

    let apiOrigin;
    try {
      apiOrigin = new URL(apiBaseUrl.trim());
    } catch {
      throw new Error('VITE_API_BASE_URL must be a valid HTTPS backend origin.');
    }
    if (
      apiOrigin.protocol !== 'https:' ||
      apiOrigin.origin !== apiBaseUrl.trim().replace(/\/+$/, '')
    ) {
      throw new Error('VITE_API_BASE_URL must be a valid HTTPS backend origin without a path.');
    }
  }

  return {
    plugins: [react()],
  };
})
