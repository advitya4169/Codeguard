
import { Queue } from "bullmq";
import { redisConnection } from './redis.js';
import { REVIEW_QUEUE_NAME } from './queueNames.js';
import { calculateReviewBackoff } from '../services/groqService.js';

export const reviewQueue = new Queue(REVIEW_QUEUE_NAME, {
  connection: redisConnection,
  settings: {
    backoffStrategy: calculateReviewBackoff,
  },
});
