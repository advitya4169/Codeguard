import dotenv from 'dotenv';
import { assertRequiredEnv, assertAnyRequiredEnv } from './config/env.js';

dotenv.config({ quiet: true });

assertRequiredEnv(
  ['MONGODB_URI', 'REDIS_URL', 'GROQ_API_KEY', 'GITHUB_APP_ID'],
  'Background worker',
);
assertAnyRequiredEnv(['GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_PRIVATE_KEY'], 'Background worker');
const { generateGitHubAppJWT } = await import('./services/githubAppService.js');
generateGitHubAppJWT();

const [
  { default: connectDB },
  { default: mongoose },
  { redisConnection, pingRedis },
] = await Promise.all([
  import('./config/db.js'),
  import('mongoose'),
  import('./config/redis.js'),
]);

let reviewWorker;

const start = async () => {
  await connectDB();
  await pingRedis();

  const { startReviewWorker } = await import('./workers/reviewWorker.js');
  reviewWorker = startReviewWorker();
  await reviewWorker.waitUntilReady();
  console.log('Review worker is ready.');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; closing review worker.`);
    try {
      await reviewWorker.close();
      if (redisConnection.status !== 'end') await redisConnection.quit();
      await mongoose.disconnect();
      process.exitCode = 0;
    } catch (error) {
      console.error(`Worker shutdown failed: ${error.message}`);
      process.exitCode = 1;
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
};

start().catch(async (error) => {
  console.error(`Worker startup failed: ${error.message}`);
  try {
    await reviewWorker?.close(true);
    if (redisConnection.status !== 'end') redisConnection.disconnect();
    await mongoose.disconnect();
  } catch {
    // Preserve the original startup error.
  }
  process.exitCode = 1;
});
