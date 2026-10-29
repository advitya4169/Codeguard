import Repository from '../models/Repository.js';
import ReviewJob from '../models/ReviewJob.js';

const isValidObjectId = (value) => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

/** Dependency injection keeps retry behavior testable without Redis or MongoDB. */
export const createRetryReviewHandler = ({
  RepositoryModel = Repository,
  ReviewJobModel = ReviewJob,
  queue,
  logger = console,
} = {}) => async (req, res) => {
  const userId = req.user?.userId;
  const githubRepoId = Number(req.params.githubRepoId);
  const { reviewId } = req.params;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!Number.isSafeInteger(githubRepoId) || githubRepoId <= 0 || !isValidObjectId(reviewId)) {
    return res.status(400).json({ error: 'Invalid review retry request' });
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
    if (review.status !== 'failed') {
      return res.status(409).json({ error: 'Only a failed review can be retried' });
    }

    const jobId = `pr-${repository.githubRepoId}-${review.prNumber}-${review.commitSha}`;
    const activeQueue = queue || (await import('../config/queue.js')).reviewQueue;
    const job = await activeQueue.getJob(jobId);
    if (!job) {
      return res.status(409).json({
        error: 'The failed queue job is no longer available. Push a new commit to start a review.',
      });
    }

    const state = await job.getState();
    if (state !== 'failed') {
      return res.status(409).json({
        error: state === 'completed'
          ? 'This review has already completed.'
          : 'This review is already queued or running.',
      });
    }

    const data = job.data;
    const isAppRepository = Boolean(repository.installationId);
    const payloadMatchesReview = data &&
      data.githubRepoId === repository.githubRepoId &&
      data.prNumber === review.prNumber &&
      data.commitSha === review.commitSha &&
      String(data.userId) === String(repository.userId) &&
      (isAppRepository
        ? data.installationId === repository.installationId && !Object.hasOwn(data, 'accessToken')
        : !Object.hasOwn(data, 'installationId') && typeof data.accessToken === 'string' && data.accessToken.length > 0);

    if (!payloadMatchesReview || job.name !== 'process-pr-review' || job.id !== jobId) {
      logger.error('Failed review retry rejected because queued job metadata did not match its review identity.');
      return res.status(409).json({ error: 'The failed queue job does not match this review.' });
    }

    // Atomically reserve this failed review. Competing retry requests will see
    // queued status and cannot start a second analysis.
    const claimedReview = await ReviewJobModel.findOneAndUpdate(
      { _id: review._id, repositoryId: repository._id, status: 'failed' },
      { $set: { status: 'queued', summary: 'Review retry queued.' } },
      { new: true, runValidators: true },
    );
    if (!claimedReview) {
      return res.status(409).json({ error: 'This review is already queued or running.' });
    }

    try {
      // Reuse BullMQ's existing failed job and identity; reset attempt counters
      // so this explicit retry receives the configured attempts/backoff anew.
      await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
    } catch (error) {
      await ReviewJobModel.findOneAndUpdate(
        { _id: review._id, repositoryId: repository._id, status: 'queued', summary: 'Review retry queued.' },
        { $set: { status: 'failed', summary: review.summary } },
        { runValidators: true },
      );
      logger.error('Could not requeue a failed review.', { errorType: error?.name || 'Error' });
      return res.status(503).json({ error: 'The review could not be queued. Please try again.' });
    }

    return res.status(202).json({
      message: 'Review retry queued.',
      reviewId: String(review._id),
    });
  } catch (error) {
    logger.error('Failed to retry review.', { errorType: error?.name || 'Error' });
    return res.status(500).json({ error: 'Could not retry this review.' });
  }
};

export const retryReview = createRetryReviewHandler();
