import express from 'express';
import { analyzeCode } from '../controllers/reviewController.js';
import { demoRateLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// demoRateLimiter runs first: 10 requests per IP per minute.
// This protects unauthenticated access to the Groq API from automated abuse.
router.post('/', demoRateLimiter, analyzeCode);

export default router;
