import express from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import { connectRepository, getUserRepositories } from '../controllers/githubController.js';
import {
  githubAppAuthorizationCallback,
  githubAppInstallationSetupReturn,
  startGitHubAppInstallation,
} from '../controllers/githubAppController.js';
import {
  listGitHubAppInstallations,
  connectGitHubAppInstallationRepository,
  listGitHubAppInstallationRepositories,
} from '../controllers/githubAppRepositoryController.js';

const router = express.Router();

// The middleware runs first. If it fails, the request stops there.
router.get('/repos', requireAuth, getUserRepositories);
router.post('/repos/connect', requireAuth, connectRepository);
router.post('/app/installations/start', requireAuth, startGitHubAppInstallation);
router.get('/app/installations/setup', githubAppInstallationSetupReturn);
router.get('/app/callback', githubAppAuthorizationCallback);
router.get('/app/installations', requireAuth, listGitHubAppInstallations);
router.get('/app/installations/:installationId/repos', requireAuth, listGitHubAppInstallationRepositories);
router.post('/app/installations/:installationId/repos/connect', requireAuth, connectGitHubAppInstallationRepository);

export default router;
