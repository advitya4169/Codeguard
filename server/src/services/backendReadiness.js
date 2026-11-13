let localWorkerStatus = 'uninitialized';

export const setWorkerStatus = (status) => {
  localWorkerStatus = status;
};

export const getWorkerStatus = () => localWorkerStatus;

export const createWorkerReadinessTracker = (worker) => {
  if (!worker || typeof worker.on !== 'function') return;

  if (typeof worker.isRunning === 'function' && worker.isRunning()) {
    localWorkerStatus = 'ready';
  }

  worker.on('ready', () => {
    localWorkerStatus = 'ready';
  });

  worker.on('closing', () => {
    localWorkerStatus = 'closing';
  });

  worker.on('closed', () => {
    localWorkerStatus = 'closed';
  });

  worker.on('error', () => {
    localWorkerStatus = 'error';
  });
};

export const isBackendReady = async ({
  mongoReadyState,
  pingRedis,
  workerStatus,
  worker,
  isWorkerReady,
  getWorkerStatus: customGetWorkerStatus,
} = {}) => {
  // 1. Verify MongoDB connection
  if (mongoReadyState !== 1) return false;

  // 2. Verify Redis responsiveness with bounded timeout
  try {
    if (typeof pingRedis === 'function') {
      await pingRedis(2_000);
    }
  } catch {
    return false;
  }

  // 3. Verify worker readiness signal
  if (typeof isWorkerReady === 'function') {
    return Boolean(isWorkerReady());
  }
  if (typeof isWorkerReady === 'boolean') {
    return isWorkerReady;
  }

  if (worker) {
    if (typeof worker.isRunning === 'function') {
      return Boolean(worker.isRunning());
    }
    return false;
  }

  const effectiveStatus = workerStatus !== undefined
    ? workerStatus
    : typeof customGetWorkerStatus === 'function'
      ? customGetWorkerStatus()
      : localWorkerStatus;

  return effectiveStatus === 'ready';
};
