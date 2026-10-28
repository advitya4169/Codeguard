import IORedis from 'ioredis';

export const redisConnection = new IORedis(
  process.env.REDIS_URL || 'redis://localhost:6379',
  {
    maxRetriesPerRequest: null,
    connectTimeout: 10_000,
  },
);

redisConnection.on('connect', () => {
  console.log('Connected to Redis');
});

redisConnection.on('ready', () => {
  console.log('Redis is ready');
});

redisConnection.on('error', (error) => {
  console.error('Redis connection error:', error.message);
});

export const pingRedis = async (timeoutMs = 5_000) => {
  let timeout;
  try {
    return await Promise.race([
      redisConnection.ping(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Redis readiness check timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
