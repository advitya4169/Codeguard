import { apiUrl } from '../config/api.js';

export const requestReviewHistory = async (repositoryId, token, signal, fetchImpl = fetch) => {
  const response = await fetchImpl(apiUrl(`/api/dashboard/repos/${repositoryId}/reviews`), {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    // Report the HTTP status below if the response body is not JSON.
  }

  if (!response.ok) {
    const error = new Error(data.error || `Failed to load review history (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  if (!Array.isArray(data.reviews)) {
    throw new Error('The server returned an unexpected review history response.');
  }

  return data.reviews;
};

export const requestReviewRetry = async (repositoryId, reviewId, token, fetchImpl = fetch) => {
  const response = await fetchImpl(
    apiUrl(`/api/dashboard/repos/${repositoryId}/reviews/${reviewId}/retry`),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    },
  );

  let data = {};
  try {
    data = await response.json();
  } catch {
    // Surface a safe status-based message below if the response is not JSON.
  }

  if (!response.ok) {
    const error = new Error(data.error || `Could not retry review (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  if (typeof data.reviewId !== 'string') {
    throw new Error('The server returned an unexpected review retry response.');
  }
  return data;
};
