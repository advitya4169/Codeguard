import { Worker } from 'bullmq';
import { redisConnection } from '../config/queue.js';
import { getPRDiff } from '../services/githubService.js';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const worker = new Worker(
  'code-review-queue',
  async (job) => {
    // 1. Extract the data, including the new accessToken
    const { prNumber, repoFullName, commitSha, accessToken } = job.data;

    console.log(`\n  WORKER PICKED UP JOB: ${job.id}`);
    console.log(`Processing PR #${prNumber} for ${repoFullName}...`);

    await job.updateProgress(10);
    
    // 2. Fetch the actual code changes
    console.log(`- Fetching Git Diff from GitHub API...`);
    const diff = await getPRDiff(repoFullName, prNumber, accessToken);
    
    await job.updateProgress(50);
    console.log(`- Fetched Diff! It is ${diff.length} characters long.`);
    
    // 3. (Temporary) Log a snippet of the diff so we can see what it looks like
    console.log('--- DIFF PREVIEW ---');
    console.log(diff.substring(0, 300) + '...\n--------------------');

    return {
      status: 'success',
      message: `Fetched diff for commit ${commitSha}`,
    };
  },
  { 
    connection: redisConnection,
    concurrency: 5 
  }
);

worker.on('failed', (job, err) => {
  console.error(`❌ JOB FAILED: ${job.id}`);
  console.error(`Reason: ${err.message}`);
});

export default worker;