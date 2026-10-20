import User from '../models/User.js';
import { reviewQueue } from '../config/queue.js';

export const handleGithubWebhook = async (req, res) => {
  const event = req.headers['x-github-event'];
  
  if (!req.body) {
    return res.status(400).send('No payload found');
  }

  res.status(200).send('Webhook received');

  if (event === 'pull_request') {
    const { action, pull_request, repository, sender } = req.body;

    if (action === 'opened' || action === 'synchronize') {
      const prNumber = pull_request.number;
      const repoFullName = repository.full_name;
      const commitSha = pull_request.head.sha;
      const githubId = sender.id.toString();

      try {
        // 1. Look up the user in our database to get their token
        const user = await User.findOne({ githubId });
        
        if (!user || !user.accessToken) {
          console.error(`No user or access token found for GitHub ID: ${githubId}. Cannot review PR.`);
          return;
        }

        const uniqueJobId = `pr-${repository.id}-${prNumber}-${commitSha}`;

        // 2. Pass the token securely into the job data
        await reviewQueue.add(
          'process-pr-review',
          {
            prNumber,
            repoFullName,
            commitSha,
            action,
            accessToken: user.accessToken, // <-- Passed to worker
            userId: user._id // <-- So we can save to DB later
          },
          {
            jobId: uniqueJobId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
          }
        );
        console.log(`📥 Added Job to Queue: PR #${prNumber} for ${repoFullName}`);
      } catch (error) {
        console.error('Failed to add job to queue:', error);
      }
    }
  }
};