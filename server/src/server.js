import dotenv from 'dotenv';
import { assertRequiredEnv, assertAnyRequiredEnv, getTrustProxySetting } from './config/env.js';

dotenv.config({ quiet: true });

const isRenderDeployment = process.env.RENDER === 'true';

if (!isRenderDeployment && !process.env.FRONTEND_URL?.trim()) {
  process.env.FRONTEND_URL = 'http://localhost:5173';
}

assertRequiredEnv(
  [
    'MONGODB_URI',
    'REDIS_URL',
    'GROQ_API_KEY',
    'JWT_SECRET',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_APP_ID',
    'GITHUB_APP_CLIENT_ID',
    'GITHUB_APP_CLIENT_SECRET',
    'GITHUB_APP_INSTALL_URL',
    'GITHUB_APP_CALLBACK_URL',
    'WEBHOOK_SECRET',
  ],
  'Backend',
);
if (isRenderDeployment) {
  assertRequiredEnv(['FRONTEND_URL'], 'Backend');
}
assertAnyRequiredEnv(['GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_PRIVATE_KEY'], 'Backend');
const { generateGitHubAppJWT } = await import('./services/githubAppService.js');
generateGitHubAppJWT();

const PORT = Number(process.env.PORT || 5000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const [
  { default: express },
  { default: cors },
  { default: connectDB },
  { default: mongoose },
  { redisConnection, pingRedis },
  { reviewQueue },
  { requireAuth },
  { default: reviewRoutes },
  { default: authRoutes },
  { default: githubRoutes },
  { default: webhookRoutes },
  { default: dashboardRoutes },
] = await Promise.all([
  import('express'),
  import('cors'),
  import('./config/db.js'),
  import('mongoose'),
  import('./config/redis.js'),
  import('./config/queue.js'),
  import('./middleware/authMiddleware.js'),
  import('./routes/reviewRoutes.js'),
  import('./routes/authRoutes.js'),
  import('./routes/githubRoutes.js'),
  import('./routes/webhookRoutes.js'),
  import('./routes/dashboardRoutes.js'),
]);

const app = express();

const parseOrigin = (value, variableName) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} entries must be HTTP(S) origins without paths.`);
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value.replace(/\/$/, '')) {
    throw new Error(`${variableName} entries must be HTTP(S) origins without paths.`);
  }

  return url.origin;
};

const allowedOrigins = new Set([
  ...(process.env.NODE_ENV === 'production'
    ? []
    : ['http://localhost:5173', 'http://127.0.0.1:5173']),
  ...(process.env.FRONTEND_URL ? [parseOrigin(process.env.FRONTEND_URL.trim(), 'FRONTEND_URL')] : []),
  ...(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => parseOrigin(origin, 'CORS_ORIGINS')),
]);

app.set('trust proxy', getTrustProxySetting());
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin));
  },
}));
app.use(express.json({
  verify: (req, res, buffer) => {
    if (req.path === '/api/webhooks/github') {
      req.rawBody = Buffer.from(buffer);
    }
  },
}));

app.get('/healthz', async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ status: 'not_ready' });
  }

  try {
    await pingRedis(2_000);
    return res.status(200).json({ status: 'ok' });
  } catch {
    return res.status(503).json({ status: 'not_ready' });
  }
});

app.use('/api/review', reviewRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/dashboard', requireAuth, dashboardRoutes);

const closeRuntime = async (httpServer) => {
  await new Promise((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  await reviewQueue.close();
  if (redisConnection.status !== 'end') await redisConnection.quit();
  await mongoose.disconnect();
};

const start = async () => {
  await connectDB();
  await pingRedis();

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; closing backend connections.`);
    try {
      await closeRuntime(httpServer);
      process.exitCode = 0;
    } catch (error) {
      console.error(`Backend shutdown failed: ${error.message}`);
      process.exitCode = 1;
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
};

start().catch(async (error) => {
  console.error(`Backend startup failed: ${error.message}`);
  try {
    if (redisConnection.status !== 'end') redisConnection.disconnect();
    await mongoose.disconnect();
  } catch {
    // Preserve the original startup error.
  }
  process.exitCode = 1;
});
