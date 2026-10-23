import crypto from 'crypto';
import User from '../models/User.js';
import { reviewQueue } from '../config/queue.js';

export const handleGithubWebhook = async (req, res) => {
  const event = req.headers['x-github-event'];
  const signature = req.headers['x-hub-signature-256'];
  if (!req.body) {
    return res.status(400).send('No payload found');
  }
  // --- NEW: CRYPTOGRAPHIC SIGNATURE VERIFICATION ---
  // We recreate the hash using our secret and the request body, 
  // then compare it to the hash GitHub sent.
  const hmac = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET);
  // Express parses req.body into an object, we must stringify it back to raw JSON
  const digest = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');
  
  if (signature !== digest) {
    console.error('🚨 Webhook signature mismatch! Unauthorized request blocked.');
    return res.status(401).send('Unauthorized');
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
            userId: user._id, // <-- So we can save to DB later
            githubRepoId: repository.id
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