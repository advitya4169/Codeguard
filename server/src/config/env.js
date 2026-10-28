const isPresent = (value) => typeof value === 'string' && value.trim().length > 0;

export const assertRequiredEnv = (names, serviceName) => {
  const missing = names.filter((name) => !isPresent(process.env[name]));
  if (missing.length > 0) {
    throw new Error(`${serviceName} is missing required environment variables: ${missing.join(', ')}`);
  }
};

export const assertAnyRequiredEnv = (names, serviceName) => {
  if (!names.some((name) => isPresent(process.env[name]))) {
    throw new Error(`${serviceName} requires one of these environment variables: ${names.join(' or ')}`);
  }
};

export const getTrustProxySetting = () => {
  const configured = process.env.TRUST_PROXY_HOPS?.trim();
  if (!configured || configured === 'loopback') return 'loopback';
  if (/^\d+$/.test(configured)) return Number(configured);
  throw new Error('TRUST_PROXY_HOPS must be "loopback" or a non-negative integer.');
};
