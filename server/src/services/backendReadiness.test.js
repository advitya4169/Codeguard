import test from 'node:test';
import assert from 'node:assert/strict';
import { isBackendReady } from './backendReadiness.js';

const readyDependencies = () => ({
  mongoReadyState: 1,
  pingRedis: async () => 'PONG',
  reviewQueue: { getWorkers: async () => [{ db: '0' }] },
});

test('backend is ready when MongoDB, Redis, and a review worker are ready', async () => {
  assert.equal(await isBackendReady(readyDependencies()), true);
});

test('backend is not ready when MongoDB is disconnected', async () => {
  const dependencies = readyDependencies();
  dependencies.mongoReadyState = 0;
  assert.equal(await isBackendReady(dependencies), false);
});

test('backend is not ready when Redis is unavailable', async () => {
  const dependencies = readyDependencies();
  dependencies.pingRedis = async () => { throw new Error('Redis unavailable'); };
  assert.equal(await isBackendReady(dependencies), false);
});

test('backend is not ready when no review worker is registered', async () => {
  const dependencies = readyDependencies();
  dependencies.reviewQueue.getWorkers = async () => [];
  assert.equal(await isBackendReady(dependencies), false);
});

test('backend is not ready when worker discovery fails', async () => {
  const dependencies = readyDependencies();
  dependencies.reviewQueue.getWorkers = async () => { throw new Error('Redis command failed'); };
  assert.equal(await isBackendReady(dependencies), false);
});

test('backend is not ready when a worker is connected to a different Redis database', async () => {
  const dependencies = readyDependencies();
  dependencies.redisDb = 14;
  assert.equal(await isBackendReady(dependencies), false);
});
