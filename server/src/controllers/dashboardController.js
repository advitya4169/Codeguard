import Repository from '../models/Repository.js';
import ReviewJob from '../models/ReviewJob.js';
import Finding from '../models/Finding.js';

export const getRepositoryReviews = async (req, res) => {
  try {
    const { githubRepoId } = req.params;

    // 1. Find the repository in our DB
    const repository = await Repository.findOne({ githubRepoId });
    
    // If the repo isn't in our DB yet, it just means no webhooks have fired for it.
    if (!repository) {
      return res.status(200).json({ reviews: [] });
    }

    // 2. Fetch all review jobs for this repository (newest first)
    const reviews = await ReviewJob.find({ repositoryId: repository._id })
      .sort({ createdAt: -1 })
      .lean();

    // 3. Attach the specific findings to each review job
    const reviewsWithFindings = await Promise.all(
      reviews.map(async (review) => {
        const findings = await Finding.find({ reviewJobId: review._id }).lean();
        return { ...review, findings };
      })
    );

    res.status(200).json({ reviews: reviewsWithFindings });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({ error: 'Failed to fetch review history' });
  }
};