import crypto from 'crypto';

export const handleGithubWebhook = (req, res) => {
  // 1. GitHub sends the event type in this header (e.g., "pull_request")
  const event = req.headers['x-github-event'];
  
  // 2. Security Check: (We will implement full signature verification later)
  // For now, just ensure the request has a body
  if (!req.body) {
    return res.status(400).send('No payload found');
  }

  // 3. Acknowledge receipt immediately so GitHub doesn't timeout
  res.status(200).send('Webhook received');

  // 4. Process the event asynchronously
  if (event === 'pull_request') {
    const { action, pull_request, repository } = req.body;

    // We only care when a PR is opened or new code is pushed (synchronize)
    if (action === 'opened' || action === 'synchronize') {
      console.log('----------------------------------------');
      console.log(` WEBHOOK RECEIVED: PR ${action.toUpperCase()}`);
      console.log(`Repository: ${repository.full_name}`);
      console.log(`PR Number: #${pull_request.number}`);
      console.log(`Title: ${pull_request.title}`);
      console.log('----------------------------------------');
      
      // In Stage 5, this is exactly where we will do:
      // await queue.add('review-job', { prNumber, repoName, ... })
    } else {
      console.log(`Ignored PR action: ${action}`);
    }
  } else if (event === 'ping') {
    // GitHub sends a 'ping' event when you first set up the webhook
    console.log('GitHub Webhook Ping received! Connection successful.');
  }
};