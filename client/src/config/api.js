const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();

if (import.meta.env.PROD && !configuredApiBaseUrl) {
  throw new Error('VITE_API_BASE_URL must be configured for production builds.');
}

const apiBaseUrl = configuredApiBaseUrl || 'http://localhost:5000';

export const API_BASE_URL = apiBaseUrl.replace(/\/+$/, '');

export const apiUrl = (path) => `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
