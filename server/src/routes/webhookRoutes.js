import express from 'express';
import { handleGithubWebhook } from '../controllers/webhookController.js';

export const createWebhookRouter = (handler = handleGithubWebhook) => {
  const router = express.Router();
  router.post('/github', handler);
  return router;
};

const router = createWebhookRouter();

export default router;
