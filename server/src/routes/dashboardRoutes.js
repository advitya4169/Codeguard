import express from 'express';
import { getRepositoryReviews } from '../controllers/dashboardController.js';

const router = express.Router();

// Route: GET /api/dashboard/repos/:githubRepoId/reviews
router.get('/repos/:githubRepoId/reviews', getRepositoryReviews);

export default router;