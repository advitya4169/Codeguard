
import { Queue } from "bullmq";
import { redisConnection } from './redis.js';
import { REVIEW_QUEUE_NAME } from './queueNames.js';
import { calculateReviewBackoff } from '../services/groqService.js';

export const COMPLETED_JOB_RETENTION_COUNT = 100;
export const FAILED_JOB_RETENTION_AGE_SECONDS = 7 * 24 * 3600; // 7 days (604,800 seconds)
export const FAILED_JOB_RETENTION_COUNT = 500;

export const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: {
    count: COMPLETED_JOB_RETENTION_COUNT,
  },
  removeOnFail: {
    age: FAILED_JOB_RETENTION_AGE_SECONDS,
    count: FAILED_JOB_RETENTION_COUNT,
  },
};

export const reviewQueue = new Queue(REVIEW_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
  settings: {
    backoffStrategy: calculateReviewBackoff,
  },
});
