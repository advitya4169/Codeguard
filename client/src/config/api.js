const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();

if (import.meta.env.PROD && !configuredApiBaseUrl) {
  throw new Error('VITE_API_BASE_URL must be configured for production builds.');
}

// Local development must never inherit a production API URL from the shell.
const apiBaseUrl = import.meta.env.DEV
  ? 'http://localhost:5000'
  : configuredApiBaseUrl;

export const API_BASE_URL = apiBaseUrl.replace(/\/+$/, '');

export const apiUrl = (path) => `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
