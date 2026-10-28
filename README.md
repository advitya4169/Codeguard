# CodeGuard

CodeGuard reviews GitHub pull request diffs with Groq-powered AI analysis. Reviews run as background jobs, are saved with their findings in MongoDB, and can be summarized in a GitHub pull request comment.

## Features

- GitHub OAuth sign-in for CodeGuard accounts.
- GitHub App installation and repository connection for automatic PR event delivery.
- BullMQ background processing backed by Redis.
- Diff-aware finding validation for paths, evidence excerpts, and line locations.
- Dashboard repository management, review history, findings, and suggested fixes.
- Optional GitHub PR comments after review results are persisted.

OAuth sign-in and GitHub App installation are separate integrations. OAuth lets a user authenticate and browse their GitHub account repositories; OAuth alone does not configure automatic App webhook delivery. A repository must be connected through the GitHub App flow for App-based reviews.

## Architecture

```text
GitHub App pull_request webhook
  → Express webhook handler (HMAC-SHA256 over raw request body)
  → BullMQ job in Redis
  → Render background worker
  → fetch and clean the PR diff
  → Groq AI analysis
  → diff-aware finding validation
  → MongoDB review history and findings
  → optional GitHub PR comment
  → CodeGuard dashboard
```

The webhook handler verifies signatures, checks supported PR actions and repository association, and queues the job before acknowledging supported events. The worker fetches the PR diff, removes excluded files such as dependency lockfiles and build output, and analyzes the remaining diff. The validator checks that paths appear in the diff, that evidence excerpts correspond to added code, and that line locations map to relevant diff lines. These checks reduce unsupported findings but do not guarantee semantic correctness. AI findings can be missed or incorrectly reported.

## Technology

- **Frontend:** React, Vite, Tailwind CSS, React Router, React Markdown, `remark-gfm`, Lucide React.
- **Backend:** Node.js (ES modules), Express, Mongoose.
- **Data and jobs:** MongoDB, Redis, BullMQ.
- **AI:** Groq API with `openai/gpt-oss-20b`.
- **GitHub:** GitHub App for installation-based repository access and webhooks; GitHub OAuth App for CodeGuard sign-in; JWT for CodeGuard API authentication.
- **Local infrastructure:** Docker Compose starts Redis only. MongoDB is external.

## Local development

Requires Node.js 22.12 or later, npm, Docker with Compose, a reachable MongoDB instance, and credentials for the integrations you want to run. There is no root `package.json`.

Start Redis from the repository root:

```bash
docker compose up -d redis
```

In one terminal, start the backend (Express API and MongoDB connection):

```bash
cd server
npm ci
npm run dev
```

In another terminal, start the background worker:

```bash
cd server
npm run worker
```

In a third terminal, start the Vite frontend:

```bash
cd client
npm ci
npm run dev
```

The server reads `server/.env`; Vite reads `client/.env`. Copy the corresponding example files and fill in local values. The frontend defaults to `http://localhost:5173`; the API defaults to `http://localhost:5000`; Redis defaults to `redis://localhost:6379` when `REDIS_URL` is unset. For the full app, backend startup requires `MONGODB_URI`, `REDIS_URL`, `GROQ_API_KEY`, `JWT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_INSTALL_URL`, `GITHUB_APP_CALLBACK_URL`, `WEBHOOK_SECRET`, and one of `GITHUB_APP_PRIVATE_KEY_PATH` or `GITHUB_APP_PRIVATE_KEY`. Render additionally requires `FRONTEND_URL`; local development defaults it to `http://localhost:5173` when unset. The worker requires `MONGODB_URI`, `REDIS_URL`, `GROQ_API_KEY`, `GITHUB_APP_ID`, and a GitHub App private key path or value.

## Deploy

Deploy the frontend and backend independently. The worker is a separate Render Background Worker, so web service instances do not start duplicate queue consumers. Keep the Web Service at one instance unless the demo rate limiter is moved to shared storage: it currently uses an in-memory per-process map. Both Render services must use the same repository revision and the same MongoDB, Redis, Groq, and GitHub App settings needed by their code paths. The Render and Vercel URLs refer to each other; create the services, record their assigned domains, then set the final URL variables and redeploy before enabling GitHub delivery.

### 1. Configure MongoDB Atlas

Use an existing Atlas database if it is appropriate for CodeGuard, or create a database and a database user with access to it. Add the Render service's outbound IP addresses to Atlas Network Access; if using a Render plan with static outbound IPs, allow those addresses. Do not expose database credentials in the repository. Copy the Atlas connection URI into `MONGODB_URI` for both Render services.

### 2. Create hosted Redis

Create a hosted Redis-compatible instance reachable from both Render services. Use the provider's TLS URL (`rediss://...`) when supplied. Set the same `REDIS_URL` on the Render Web Service and Background Worker. The API producer and worker use the same `code-review-queue` queue name.

### 3. Deploy the Render Web Service

Create a **Web Service** from this repository with:

| Setting | Value |
| --- | --- |
| Root Directory | `server` |
| Runtime | Node |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |

The start script runs `node src/server.js`. The web process validates required configuration, connects to MongoDB and Redis before listening, handles `SIGTERM`/`SIGINT`, and serves `/healthz` readiness checks. `TRUST_PROXY_HOPS` defaults to `loopback`, which preserves local/ngrok development behavior. Render traffic passes through platform proxies; verify the forwarded proxy chain for the deployed service and set this variable to the corresponding numeric hop count. Do not set it to `true` or trust arbitrary forwarded headers. Until the hop count is verified, the rate limiter may see a shared proxy address rather than each visitor's address.

Set the backend environment variables listed below. Use the deployed Vercel frontend origin in `FRONTEND_URL`; add any other exact allowed browser origins to `CORS_ORIGINS` as a comma-separated list. Do not include paths or trailing slashes in origins.

Set `NODE_ENV=production` to disable the local development CORS origins. Set `TRUST_PROXY_HOPS` to the verified Render proxy hop count for client IP rate limiting; do not assume a value before checking the actual forwarded chain.

The backend requires the final `FRONTEND_URL` at startup. Create the Render service to obtain its domain, then create/deploy the Vercel project in step 4. Return to Render with both final origins, complete the required environment, and run the successful backend deploy. An initial Render startup without its required environment will fail fast with the missing variable names.

### 4. Deploy the Vite frontend to Vercel

Create a Vercel project from this repository with:

| Setting | Value |
| --- | --- |
| Root Directory | `client` |
| Framework Preset | Vite |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Node.js Version | `22.x` |

The included [`client/vercel.json`](client/vercel.json) rewrites browser routes such as `/dashboard` to the Vite entry document so direct visits and refreshes work with React Router.

Set `VITE_API_BASE_URL` to the Render Web Service's HTTPS origin (origin only, no path or trailing slash). Vite embeds this value at build time, so redeploy after changing it. Production builds fail if it is missing; local development still defaults to `http://localhost:5000`. The frontend uses this configured API origin for OAuth login and API requests.

After Vercel assigns its production domain, set that origin as Render `FRONTEND_URL` (and in `CORS_ORIGINS` if you list origins explicitly), set `NODE_ENV=production`, verify `TRUST_PROXY_HOPS`, complete the Render Web Service environment, and redeploy. Confirm `https://<render-web-service-domain>/healthz` returns `200` before adding GitHub webhooks.

### 5. Deploy the Render Background Worker

Create a **Background Worker** from the same repository and commit:

| Setting | Value |
| --- | --- |
| Root Directory | `server` |
| Runtime | Node |
| Build Command | `npm ci` |
| Start Command | `npm run worker` |

The worker entry point connects to MongoDB and Redis, then consumes `code-review-queue`. Give it the shared variables listed below plus the GitHub App ID and private key configuration used to authenticate App-backed review jobs. It does not need `PORT`, `JWT_SECRET`, `FRONTEND_URL`, `CORS_ORIGINS`, OAuth client credentials, or `WEBHOOK_SECRET`. A Render Environment Group can hold the shared variables and App private-key secret file for both services.

### 6. Configure GitHub OAuth and GitHub App

The **GitHub OAuth App** is used for CodeGuard login. Set its Authorization callback URL to:

```text
https://<render-web-service-domain>/api/auth/github/callback
```

The OAuth implementation requests `repo` and `read:user` scopes. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` on the Render Web Service.

Configure the **GitHub App** as follows:

- **Webhook URL:** `https://<render-web-service-domain>/api/webhooks/github`
- **Setup URL:** `https://<render-web-service-domain>/api/github/app/installations/setup`
- **Callback URL:** `https://<render-web-service-domain>/api/github/app/callback`; this must exactly match `GITHUB_APP_CALLBACK_URL`.
- **Webhook secret:** set the App's webhook secret and the same value in backend `WEBHOOK_SECRET`.
- **Repository permissions:** Pull requests: Read, for PR events and diff retrieval. For optional comments, grant Issues: Write or Pull requests: Write.
- **Webhook subscriptions:** `pull_request` and `installation`. CodeGuard handles PR actions `opened` and `synchronize`, and installation actions `created`, `suspend`, `unsuspend`, and `deleted`. It also handles `installation_repositories` actions `added` and `removed`; GitHub delivers that event to Apps by default.
- Leave **Request user authorization during installation** disabled for the current two-step installation/authorization flow.

Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` or `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_INSTALL_URL`, and `GITHUB_APP_CALLBACK_URL` on the Render Web Service. Set `GITHUB_APP_ID` and the private key configuration on the Background Worker too. For a secret file named `codeguard-private-key.pem`, Render exposes it at `/etc/secrets/codeguard-private-key.pem`; set `GITHUB_APP_PRIVATE_KEY_PATH` to that path on both services, or link a shared secret file through an Environment Group. Never commit the key. App installation and OAuth callback endpoints, as well as GitHub webhooks, require a publicly reachable HTTPS backend.

### Environment variables by service

The repository includes [`server/.env.example`](server/.env.example) and [`client/.env.example`](client/.env.example). They contain placeholders only.

**Render Web Service**

- Required at Render backend startup: `MONGODB_URI`, `REDIS_URL`, `GROQ_API_KEY`, `JWT_SECRET`, `FRONTEND_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_INSTALL_URL`, `GITHUB_APP_CALLBACK_URL`, `WEBHOOK_SECRET`, and either `GITHUB_APP_PRIVATE_KEY_PATH` or `GITHUB_APP_PRIVATE_KEY`.
- Frontend/CORS/proxy: `CORS_ORIGINS` (optional if only `FRONTEND_URL` is needed), `TRUST_PROXY_HOPS` (set to the verified Render proxy hop count), `PORT` (provided by Render; local default is `5000`).
- Runtime: `NODE_ENV` (set to `production` on Render).

**Render Background Worker**

- Required at worker startup: `MONGODB_URI`, `REDIS_URL`, `GROQ_API_KEY`, `GITHUB_APP_ID`, and either `GITHUB_APP_PRIVATE_KEY_PATH` or `GITHUB_APP_PRIVATE_KEY`.

**Vercel project**

- `VITE_API_BASE_URL` — Render Web Service HTTPS origin; this is a public API URL, not a secret.

The backend and worker must share the exact `MONGODB_URI`, `REDIS_URL`, and `GROQ_API_KEY`. App-backed jobs also require matching `GITHUB_APP_ID` and private key settings on both services. OAuth and webhook secrets belong only on the Web Service.

## Checks

```bash
cd client && npm run lint && npm run build
cd ../server && npm test
```

The backend tests use Node's built-in test runner.
