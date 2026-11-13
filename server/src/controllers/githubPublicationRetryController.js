import Repository from '../models/Repository.js';
import ReviewJob from '../models/ReviewJob.js';
import Finding from '../models/Finding.js';
import User from '../models/User.js';
import Installation from '../models/Installation.js';
import { getInstallationAccessToken } from '../services/githubAppService.js';
import { createGitHubReviewPublisher } from '../services/githubReviewPublisher.js';

const isValidObjectId = (value) => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const successfulStatuses = new Set(['published', 'duplicate']);

export const createGitHubPublicationRetryHandler = ({
  RepositoryModel = Repository,
  ReviewJobModel = ReviewJob,
  FindingModel = Finding,
  UserModel = User,
  InstallationModel = Installation,
  getInstallationAccessTokenFn = getInstallationAccessToken,
  publishReviewFn = createGitHubReviewPublisher(),
  logger = console,
} = {}) => async (req, res) => {
  const userId = req.user?.userId;
  const githubRepoId = Number(req.params.githubRepoId);
  const { reviewId } = req.params;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!isValidObjectId(userId) || !Number.isSafeInteger(githubRepoId) || githubRepoId <= 0 || !isValidObjectId(reviewId)) {
    return res.status(400).json({ error: 'Invalid publication retry request' });
  }

  try {
    const repository = await RepositoryModel.findOne({
      githubRepoId,
      userId,
      isConnected: true,
    });
    if (!repository) return res.status(404).json({ error: 'Repository not found' });

    const review = await ReviewJobModel.findOne({
      _id: reviewId,
      repositoryId: repository._id,
    });
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.status !== 'completed') {
      return res.status(409).json({ error: 'Only a completed review can retry GitHub publication' });
    }
    if (review.githubPublicationStatus !== 'failed') {
      return res.status(409).json({ error: 'Only a failed GitHub publication can be retried' });
    }

    const findings = await FindingModel.find({ reviewJobId: review._id }).lean();
    if (findings.length === 0) {
      return res.status(409).json({ error: 'This review has no saved findings to publish' });
    }

    let accessToken;
    if (repository.installationId) {
      if (!repository.isHookActive) {
        return res.status(409).json({ error: 'The repository is not currently enabled for GitHub App reviews' });
      }

      const installation = await InstallationModel.findOne({
        installationId: repository.installationId,
        userId,
        status: 'active',
      });
      if (!installation) {
        return res.status(409).json({ error: 'The GitHub App installation is unavailable or inactive' });
      }

      try {
        const tokenResult = await getInstallationAccessTokenFn(repository.installationId);
        accessToken = tokenResult?.token;
      } catch {
        return res.status(503).json({ error: 'GitHub App access is unavailable. Restore installation access and try again.' });
      }
      if (typeof accessToken !== 'string' || !accessToken) {
        return res.status(503).json({ error: 'GitHub App access is unavailable. Restore installation access and try again.' });
      }
    } else {
      const user = await UserModel.findById(userId);
      if (typeof user?.accessToken !== 'string' || !user.accessToken) {
        return res.status(409).json({ error: 'Reconnect GitHub authentication before retrying publication' });
      }
      accessToken = user.accessToken;
    }

    // Claim only a definitively failed publication; analysis remains completed.
    const claimedReview = await ReviewJobModel.findOneAndUpdate(
      {
        _id: review._id,
        repositoryId: repository._id,
        status: 'completed',
        githubPublicationStatus: 'failed',
      },
      { $set: { githubPublicationStatus: 'pending' } },
      { new: true, runValidators: true },
    );
    if (!claimedReview) {
      return res.status(409).json({ error: 'GitHub publication is already being retried' });
    }

    const commentableFindings = findings.filter((finding) => Number.isInteger(finding.lineNumber) && finding.lineNumber > 0);
    const unanchoredFindings = findings.filter((finding) => !Number.isInteger(finding.lineNumber) || finding.lineNumber <= 0);
    let publication;
    try {
      publication = await publishReviewFn({
        repositoryId: String(repository._id),
        repoFullName: repository.fullName,
        prNumber: review.prNumber,
        commitSha: review.commitSha,
        accessToken,
        commentableFindings,
        unanchoredFindings,
      });
    } catch (error) {
      publication = { status: error?.ambiguous ? 'uncertain' : 'failed', error };
    }

    const publicationStatus = publication?.status &&
      ['published', 'duplicate', 'stale', 'failed', 'uncertain'].includes(publication.status)
      ? publication.status
      : 'failed';
    const update = {
      $set: { githubPublicationStatus: publicationStatus },
      $unset: {
        githubPublicationId: 1,
        githubPublicationUrl: 1,
        githubPublishedAt: 1,
      },
    };

    if (successfulStatuses.has(publicationStatus)) {
      if (Number.isSafeInteger(publication.id)) {
        update.$set.githubPublicationId = publication.id;
        delete update.$unset.githubPublicationId;
      }
      if (typeof publication.url === 'string') {
        update.$set.githubPublicationUrl = publication.url;
        delete update.$unset.githubPublicationUrl;
      }
      update.$set.githubPublishedAt = new Date();
      delete update.$unset.githubPublishedAt;
    }
    if (Object.keys(update.$unset).length === 0) delete update.$unset;

    await ReviewJobModel.findOneAndUpdate(
      {
        _id: review._id,
        repositoryId: repository._id,
        status: 'completed',
        githubPublicationStatus: 'pending',
      },
      update,
      { new: true, runValidators: true },
    );

    logger.log('[github-review] publication retry outcome', {
      repositoryId: String(repository._id),
      prNumber: review.prNumber,
      commitSha: review.commitSha,
      findingsConsidered: findings.length,
      inlineComments: publication?.inlineCount ?? 0,
      status: publicationStatus,
      responseStatus: publication?.responseStatus ?? publication?.error?.status,
      endpoint: publication?.error?.endpoint,
    });

    return res.status(200).json({
      reviewId: String(review._id),
      githubPublicationStatus: publicationStatus,
      githubPublicationUrl: update.$set.githubPublicationUrl,
      message: publicationStatus === 'failed'
        ? 'GitHub publication failed. The completed analysis and findings remain saved.'
        : publicationStatus === 'uncertain'
          ? 'GitHub may have accepted the publication. Verify the pull request before taking further action.'
          : undefined,
    });
  } catch (error) {
    logger.error('[github-review] publication retry failed', {
      errorType: error?.name || 'Error',
    });
    return res.status(500).json({ error: 'Could not retry GitHub publication.' });
  }
};

export const retryGitHubPublication = createGitHubPublicationRetryHandler();
