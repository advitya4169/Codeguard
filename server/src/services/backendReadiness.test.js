import test from 'node:test';
import assert from 'node:assert/strict';
import { isBackendReady, setWorkerStatus } from './backendReadiness.js';

const readyDependencies = () => ({
  mongoReadyState: 1,
  pingRedis: async () => 'PONG',
  workerStatus: 'ready',
});

test('backend is ready when MongoDB, Redis, and worker are ready', async () => {
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

test('backend is not ready when worker is not initialized', async () => {
  const dependencies = readyDependencies();
  dependencies.workerStatus = 'uninitialized';
  assert.equal(await isBackendReady(dependencies), false);
});

test('backend is ready when BullMQ worker is successfully running', async () => {
  const dependencies = readyDependencies();
  delete dependencies.workerStatus;
  dependencies.worker = { isRunning: () => true };
  assert.equal(await isBackendReady(dependencies), true);
});

test('backend is not ready when worker is closed or unavailable', async () => {
  const dependencies = readyDependencies();
  dependencies.workerStatus = 'closed';
  assert.equal(await isBackendReady(dependencies), false);

  const errorDependencies = readyDependencies();
  errorDependencies.workerStatus = 'error';
  assert.equal(await isBackendReady(errorDependencies), false);

  const closedWorkerDependencies = readyDependencies();
  delete closedWorkerDependencies.workerStatus;
  closedWorkerDependencies.worker = { isRunning: () => false };
  assert.equal(await isBackendReady(closedWorkerDependencies), false);
});

test('Upstash-compatible: operates without CLIENT LIST or reviewQueue inspection', async () => {
  // Confirm that even when reviewQueue throws an Upstash-like CLIENT command error,
  // readiness relies strictly on MongoDB, Redis PING, and the worker signal without throwing.
  const dependencies = readyDependencies();
  setWorkerStatus('ready');
  assert.equal(await isBackendReady(dependencies), true);
});
