import Installation from '../models/Installation.js';
import Repository from '../models/Repository.js';
import ReviewJob from '../models/ReviewJob.js';
import User from '../models/User.js';
import { getInstallationAccessToken } from '../services/githubAppService.js';
import { getPullRequestMetadata as getPullRequestMetadataFromGitHub } from '../services/githubService.js';

const MAX_PULL_REQUESTS_PER_REQUEST = 25;
const METADATA_FETCH_CONCURRENCY = 5;

export const createPullRequestMetadataHandler = ({
  RepositoryModel = Repository,
  ReviewJobModel = ReviewJob,
  InstallationModel = Installation,
  UserModel = User,
  getInstallationAccessTokenFn = getInstallationAccessToken,
  getPullRequestMetadataFn = getPullRequestMetadataFromGitHub,
  logger = console,
} = {}) => async (req, res) => {
  const userId = req.user?.userId;
  const githubRepoId = Number(req.params.githubRepoId);
  const requestedNumbers = req.body?.pullRequestNumbers;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!Number.isSafeInteger(githubRepoId) || githubRepoId < 1) {
    return res.status(400).json({ error: 'A valid repository ID is required.' });
  }
  if (
    !Array.isArray(requestedNumbers) ||
    requestedNumbers.length < 1 ||
    requestedNumbers.length > MAX_PULL_REQUESTS_PER_REQUEST ||
    requestedNumbers.some((number) => !Number.isSafeInteger(number) || number < 1) ||
    new Set(requestedNumbers).size !== requestedNumbers.length
  ) {
    return res.status(400).json({ error: 'Provide up to 25 unique pull request numbers.' });
  }

  try {
    const repository = await RepositoryModel.findOne({
      githubRepoId,
      userId,
      isConnected: true,
    });
    if (!repository) return res.status(404).json({ error: 'Repository not found.' });

    const savedReviews = await ReviewJobModel.find({
      repositoryId: repository._id,
      prNumber: { $in: requestedNumbers },
    }).select('prNumber').lean();
    const savedNumbers = new Set(savedReviews.map((review) => review.prNumber));
    if (requestedNumbers.some((number) => !savedNumbers.has(number))) {
      return res.status(404).json({ error: 'Pull request not found in this repository review history.' });
    }

    let accessToken;
    if (repository.installationId) {
      const installation = await InstallationModel.findOne({
        installationId: repository.installationId,
        userId,
        status: 'active',
      });
      if (!installation || !repository.isHookActive) {
        return res.status(503).json({ error: 'GitHub App access is unavailable for this repository.' });
      }

      const tokenResult = await getInstallationAccessTokenFn(repository.installationId);
      accessToken = tokenResult?.token;
    } else {
      const user = await UserModel.findById(userId);
      accessToken = user?.accessToken;
    }

    if (typeof accessToken !== 'string' || !accessToken) {
      return res.status(503).json({ error: 'GitHub access is unavailable for this repository.' });
    }

    const pullRequests = [];
    const unavailable = [];
    for (let index = 0; index < requestedNumbers.length; index += METADATA_FETCH_CONCURRENCY) {
      const batch = requestedNumbers.slice(index, index + METADATA_FETCH_CONCURRENCY);
      await Promise.all(batch.map(async (number) => {
        try {
          const metadata = await getPullRequestMetadataFn(repository.fullName, number, accessToken);
          if (metadata.number !== number || metadata.baseRepositoryId !== repository.githubRepoId) {
            unavailable.push(number);
            return;
          }
          pullRequests.push({
            number: metadata.number,
            title: metadata.title ?? null,
            author: metadata.author ?? null,
            sourceBranch: metadata.sourceBranch ?? null,
            targetBranch: metadata.targetBranch ?? null,
            updatedAt: metadata.updatedAt ?? null,
          });
        } catch (error) {
          unavailable.push(number);
          logger.warn('GitHub pull request metadata unavailable', {
            repositoryId: githubRepoId,
            prNumber: number,
            status: Number.isInteger(error?.status) ? error.status : 'unknown',
          });
        }
      }));
    }

    return res.status(200).json({
      pullRequests: pullRequests.sort((left, right) => left.number - right.number),
      unavailable: unavailable.sort((left, right) => left - right),
    });
  } catch (error) {
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) {
      return res.status(503).json({ error: 'GitHub pull request metadata is temporarily unavailable.' });
    }
    logger.error('Could not load GitHub pull request metadata', {
      repositoryId: githubRepoId,
      errorType: error?.name || 'Error',
    });
    return res.status(500).json({ error: 'Could not load pull request metadata.' });
  }
};

export const getPullRequestMetadata = createPullRequestMetadataHandler();
