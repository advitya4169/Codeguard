import express from 'express';
import { getRepositoryReviews } from '../controllers/dashboardController.js';
import { retryReview } from '../controllers/reviewRetryController.js';
import { retryGitHubPublication } from '../controllers/githubPublicationRetryController.js';
import { getPullRequestMetadata } from '../controllers/pullRequestMetadataController.js';

const router = express.Router();

// Route: GET /api/dashboard/repos/:githubRepoId/reviews
router.get('/repos/:githubRepoId/reviews', getRepositoryReviews);
router.post('/repos/:githubRepoId/pull-request-metadata', getPullRequestMetadata);
router.post('/repos/:githubRepoId/reviews/:reviewId/retry', retryReview);
router.post('/repos/:githubRepoId/reviews/:reviewId/retry-publication', retryGitHubPublication);

export default router;
