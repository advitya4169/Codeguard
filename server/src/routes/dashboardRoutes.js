import express from 'express';
import { getRepositoryReviews } from '../controllers/dashboardController.js';
import { retryReview } from '../controllers/reviewRetryController.js';

const router = express.Router();

// Route: GET /api/dashboard/repos/:githubRepoId/reviews
router.get('/repos/:githubRepoId/reviews', getRepositoryReviews);
router.post('/repos/:githubRepoId/reviews/:reviewId/retry', retryReview);

export default router;
