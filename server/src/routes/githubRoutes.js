import express from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import { getUserRepositories } from '../controllers/githubController.js';

const router = express.Router();

// The middleware runs first. If it fails, the request stops there.
router.get('/repos', requireAuth, getUserRepositories);

export default router;