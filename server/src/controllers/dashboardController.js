import Repository from '../models/Repository.js';
import ReviewJob from '../models/ReviewJob.js';
import Finding from '../models/Finding.js';

export const createGetRepositoryReviewsHandler = ({
  RepositoryModel = Repository,
  ReviewJobModel = ReviewJob,
  FindingModel = Finding,
} = {}) => async (req, res) => {
  try {
    const { githubRepoId } = req.params;

    // Scope the lookup to the authenticated user's repository records.
    const repository = await RepositoryModel.findOne({
      githubRepoId,
      userId: req.user.userId,
      isConnected: true,
    });
    
    // The same response covers missing and non-owned repositories.
    if (!repository) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    // 2. Fetch all review jobs for this repository (newest first)
    const reviews = await ReviewJobModel.find({ repositoryId: repository._id })
      .sort({ createdAt: -1 })
      .lean();

    // 3. Attach the specific findings to each review job
    const reviewsWithFindings = await Promise.all(
      reviews.map(async (review) => {
        const findings = await FindingModel.find({ reviewJobId: review._id }).lean();
        return { ...review, findings };
      })
    );

    res.status(200).json({ reviews: reviewsWithFindings });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({ error: 'Failed to fetch review history' });
  }
};

export const getRepositoryReviews = createGetRepositoryReviewsHandler();
