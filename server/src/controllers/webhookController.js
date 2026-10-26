import crypto from 'node:crypto';
import User from '../models/User.js';
import Installation from '../models/Installation.js';
import Repository from '../models/Repository.js';
import ReviewJob from '../models/ReviewJob.js';
import { reviewQueue } from '../config/queue.js';

const PR_ACTIONS = new Set(['opened', 'synchronize']);
const INSTALLATION_ACTIONS = new Set(['created', 'suspend', 'unsuspend', 'deleted']);
const INSTALLATION_REPOSITORY_ACTIONS = new Set(['added', 'removed']);

const normalizeInstallationId = (value) => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) return value;
  return null;
};

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const verifySignature = (req) => {
  const signature = req.headers['x-hub-signature-256'];
  const secret = process.env.WEBHOOK_SECRET;
  const signatureMatch = typeof signature === 'string'
    ? /^sha256=([a-f0-9]{64})$/i.exec(signature)
    : null;

  if (!secret || !signatureMatch || !Buffer.isBuffer(req.rawBody)) return false;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest();
  const receivedSignature = Buffer.from(signatureMatch[1], 'hex');

  return crypto.timingSafeEqual(expectedSignature, receivedSignature);
};

const respondReceived = (res, logger = console) => {
  const startedAt = Date.now();
  logger.log('[webhook] response started');
  try {
    return res.status(200).send('Webhook received');
  } finally {
    logger.log('[webhook] response completed', { elapsedMs: Date.now() - startedAt });
  }
};

/** Dependency injection allows webhook cases to be exercised without Redis or MongoDB. */
export const createGithubWebhookHandler = ({
  UserModel = User,
  InstallationModel = Installation,
  RepositoryModel = Repository,
  ReviewJobModel = ReviewJob,
  queue = reviewQueue,
  logger = console,
} = {}) => {
  const timedStage = async (stage, operation) => {
    const startedAt = Date.now();
    let outcome = 'success';
    logger.log(`[webhook] ${stage} started`);
    try {
      return await operation();
    } catch (error) {
      outcome = 'failed';
      throw error;
    } finally {
      logger.log(`[webhook] ${stage} completed`, {
        elapsedMs: Date.now() - startedAt,
        outcome,
      });
    }
  };

  const handleInstallationEvent = async (action, body, res) => {
    if (!INSTALLATION_ACTIONS.has(action)) return respondReceived(res, logger);
    const installationId = normalizeInstallationId(body.installation?.id);
    if (!installationId) return res.status(400).send('Invalid installation payload');

    const associatedInstallation = await timedStage('installation lookup', () =>
      InstallationModel.findOne({ installationId }));
    if (
      !associatedInstallation ||
      (body.installation?.account?.id !== undefined &&
        String(body.installation.account.id) !== String(associatedInstallation.accountId))
    ) {
      return respondReceived(res, logger);
    }

    if (action === 'created' && associatedInstallation.status === 'deleted') {
      return respondReceived(res, logger);
    }
    if (action === 'unsuspend' && associatedInstallation.status === 'deleted') {
      return respondReceived(res, logger);
    }

    const status = {
      created: 'active',
      suspend: 'suspended',
      unsuspend: 'active',
      deleted: 'deleted',
    }[action];
    const updateFilter = { installationId, userId: associatedInstallation.userId };
    if (action === 'created') updateFilter.status = { $ne: 'deleted' };
    await InstallationModel.updateOne(updateFilter, { $set: { status } });

    if (action === 'deleted') {
      // Disable future delivery without hiding the repository's saved history.
      await RepositoryModel.updateMany(
        { installationId, userId: associatedInstallation.userId },
        { $set: { isHookActive: false } },
      );
    }

    return respondReceived(res, logger);
  };

  const handleInstallationRepositoriesEvent = async (action, body, res) => {
    if (!INSTALLATION_REPOSITORY_ACTIONS.has(action)) return respondReceived(res, logger);
    const installationId = normalizeInstallationId(body.installation?.id);
    if (!installationId) return res.status(400).send('Invalid installation payload');

    const repositoryChanges = action === 'added'
      ? body.repositories_added
      : body.repositories_removed;
    if (!Array.isArray(repositoryChanges)) {
      return res.status(400).send('Invalid installation repository payload');
    }

    const repositoryIds = repositoryChanges.map((repository) => repository?.id);
    if (repositoryIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      return res.status(400).send('Invalid installation repository payload');
    }

    const associatedInstallation = await timedStage('installation lookup', () =>
      InstallationModel.findOne({ installationId }));
    if (
      !associatedInstallation ||
      (body.installation?.account?.id !== undefined &&
        String(body.installation.account.id) !== String(associatedInstallation.accountId))
    ) {
      return respondReceived(res, logger);
    }

    // Repository additions restore only prior CodeGuard connections; they do not
    // implicitly connect newly accessible repositories.
    if (action === 'added' && associatedInstallation.status !== 'active') {
      return respondReceived(res, logger);
    }

    if (repositoryIds.length > 0) {
      await RepositoryModel.updateMany(
        {
          installationId,
          userId: associatedInstallation.userId,
          githubRepoId: { $in: repositoryIds },
          isConnected: true,
        },
        { $set: { isHookActive: action === 'added' } },
      );
    }

    return respondReceived(res, logger);
  };

  const handlePullRequestEvent = async (action, body, res) => {
    if (!PR_ACTIONS.has(action)) return respondReceived(res, logger);

    const repositoryId = body.repository?.id;
    const prNumber = body.pull_request?.number;
    const commitSha = body.pull_request?.head?.sha;
    if (
      !Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      !Number.isSafeInteger(prNumber) || prNumber <= 0 ||
      typeof commitSha !== 'string' || !commitSha.trim()
    ) {
      return res.status(400).send('Invalid pull request payload');
    }

    const payloadInstallationId = body.installation === undefined
      ? null
      : normalizeInstallationId(body.installation?.id);
    if (body.installation !== undefined && !payloadInstallationId) {
      return res.status(400).send('Invalid pull request installation payload');
    }

    let connectedRepository;
    let user;
    let installationId;

    if (payloadInstallationId) {
      installationId = payloadInstallationId;
      const installation = await timedStage('installation lookup', () => InstallationModel.findOne({
        installationId,
        status: 'active',
      }));
      if (
        !installation ||
        (body.installation?.account?.id !== undefined &&
          String(body.installation.account.id) !== String(installation.accountId))
      ) {
        return respondReceived(res, logger);
      }

      connectedRepository = await timedStage('repository lookup', () => RepositoryModel.findOne({
        githubRepoId: repositoryId,
        installationId,
        userId: installation.userId,
        isConnected: true,
        isHookActive: true,
      }));
      if (!connectedRepository) return respondReceived(res, logger);
    } else {
      // OAuth deliveries lack an installation object. App repositories cannot
      // fall back to OAuth credentials if the installation field is missing.
      connectedRepository = await timedStage('repository lookup', () => RepositoryModel.findOne({
        githubRepoId: repositoryId,
        isConnected: true,
        installationId: { $in: [null, ''] },
      }));
      if (!connectedRepository) return respondReceived(res, logger);

      user = await timedStage('user lookup', () =>
        UserModel.findById(connectedRepository.userId));
      if (!user || !user.accessToken) {
        logger.error(`Connected user or GitHub token unavailable for repository ${repositoryId}.`);
        return res.status(503).send('Webhook processing temporarily unavailable');
      }
    }

    const repoFullName = connectedRepository.fullName;
    const uniqueJobId = `pr-${repositoryId}-${prNumber}-${commitSha}`;
    const jobData = {
      prNumber,
      repoFullName,
      commitSha,
      action,
      userId: connectedRepository.userId,
      githubRepoId: repositoryId,
    };

    if (installationId) {
      jobData.installationId = installationId;
    } else {
      // Retain the legacy OAuth payload unchanged during the worker migration.
      jobData.accessToken = user.accessToken;
    }

    await timedStage('queue add', () => queue.add(
      'process-pr-review',
      jobData,
      {
        jobId: uniqueJobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    ));

    const reviewIdentity = {
      repositoryId: connectedRepository._id,
      prNumber,
      commitSha,
    };
    try {
      await timedStage('review-job upsert', () => ReviewJobModel.updateOne(
        reviewIdentity,
        {
          $setOnInsert: {
            status: 'queued',
            summary: 'Review is queued.',
          },
        },
        { upsert: true },
      ));
    } catch (error) {
      // Concurrent deliveries can race on the existing unique review index.
      if (error?.code !== 11000 || !(await timedStage('review-job duplicate check', () =>
        ReviewJobModel.exists(reviewIdentity)))) {
        throw error;
      }
    }

    logger.log(`📥 Added Job to Queue: PR #${prNumber} for ${repoFullName}`);
    return respondReceived(res, logger);
  };

  return async (req, res) => {
    if (!req.body) return res.status(400).send('No payload found');
    if (!verifySignature(req)) {
      logger.error('Webhook signature verification failed.');
      return res.status(401).send('Unauthorized');
    }

    if (!isPlainObject(req.body)) return res.status(400).send('Invalid webhook payload');
    const event = req.headers['x-github-event'];
    const action = req.body.action;

    try {
      if (event === 'installation') {
        if (typeof action !== 'string' || !action.trim()) {
          return res.status(400).send('Invalid installation payload');
        }
        return await handleInstallationEvent(action, req.body, res);
      }

      if (event === 'installation_repositories') {
        if (typeof action !== 'string' || !action.trim()) {
          return res.status(400).send('Invalid installation repository payload');
        }
        return await handleInstallationRepositoriesEvent(action, req.body, res);
      }

      if (event !== 'pull_request') return respondReceived(res, logger);
      if (typeof action !== 'string' || !action.trim()) {
        return res.status(400).send('Invalid pull request payload');
      }
      return await handlePullRequestEvent(action, req.body, res);
    } catch (error) {
      logger.error('Failed to process GitHub webhook.', {
        errorType: error?.name || 'Error',
        errorCode: error?.code,
      });
      return res.status(503).send('Webhook processing temporarily unavailable');
    }
  };
};

export const handleGithubWebhook = createGithubWebhookHandler();
