export const hasActiveReviews = (reviews) => reviews.some((review) => (
  review.status === 'queued' || review.status === 'processing'
));
