export const isBackendReady = async ({ mongoReadyState, pingRedis, reviewQueue, redisDb = 0 }) => {
  if (mongoReadyState !== 1) return false;

  try {
    await pingRedis(2_000);
    const workers = await reviewQueue.getWorkers();
    return workers.some((worker) => Number(worker.db) === Number(redisDb));
  } catch {
    return false;
  }
};
