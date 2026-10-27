# CodeGuard

CodeGuard reviews GitHub pull request diffs with Groq-powered AI analysis. It processes reviews in the background, saves review history and findings, and can post a summary comment to the pull request.

## Features

- GitHub OAuth sign-in for CodeGuard accounts.
- GitHub App installation and repository management for automatic pull request delivery.
- Background review jobs with BullMQ and Redis.
- AI findings with severity, evidence, file locations, and suggested fixes.
- Dashboard review history for connected repositories.
- Optional GitHub pull request comments after findings are saved.

GitHub OAuth sign-in and GitHub App installation are separate connections. OAuth lets a user sign in and browse their GitHub repositories; OAuth access by itself does not configure automatic App webhook delivery. To receive automatic reviews, install the CodeGuard GitHub App and connect the repository through the App flow.

## Architecture

```text
GitHub App pull_request webhook
  → Express webhook handler (raw-body HMAC signature verification)
  → BullMQ job in Redis
  → background review worker
  → fetch and clean the PR diff
  → Groq AI analysis
  → diff-aware finding validation
  → MongoDB review history and findings
  → optional GitHub PR comment
  → CodeGuard dashboard
```

The webhook handler checks supported pull request events and repository association before queueing. The worker removes excluded files such as dependency lockfiles and build output before sending the diff to Groq. The finding validator checks that reported paths exist in the supplied diff, that evidence excerpts correspond to added code, and that line locations map to relevant diff lines. These checks help reject unsupported locations and claims; they do not guarantee semantic correctness. AI findings can be missed or incorrectly reported.

The dashboard provides repository search and connection management, plus review history, statuses, findings, and suggested fixes. GitHub App-connected repositories use the App installation for review delivery. Existing OAuth-connected repositories remain distinguishable and are not silently converted to App connections.

## Technology

- **Frontend:** React, Vite, Tailwind CSS, React Router, React Markdown, `remark-gfm`, Lucide React.
- **Backend:** Node.js (ES modules), Express, Mongoose.
- **Data and jobs:** MongoDB for users, repositories, reviews, and findings; Redis and BullMQ for queued background processing.
- **AI:** Groq API using `openai/gpt-oss-20b`.
- **GitHub:** GitHub App installation/API authentication for repository delivery and review actions; GitHub OAuth for CodeGuard sign-in and account repository access; JWT for CodeGuard API authentication.
- **Local infrastructure:** Docker Compose provides Redis. MongoDB must be available separately.

## Local development

Prerequisites: Node.js and npm, Docker with Docker Compose, and a reachable MongoDB instance. GitHub and Groq credentials are needed to use their respective integrations.

There is no root `package.json`; install and run the client and server separately. Start Redis from the repository root:

```bash
docker compose up -d redis
```

In a second terminal, install and start the backend:

```bash
cd server
npm install
npm run dev
```

The backend loads `server/.env`. Its startup connects to MongoDB and imports the BullMQ worker into the same server process; a separate worker command is not required. Ensure `MONGODB_URI` points to a reachable MongoDB database. Redis defaults to `redis://localhost:6379` and can be overridden with `REDIS_URL`.

In a third terminal, install and start the Vite client:

```bash
cd client
npm install
npm run dev
```

The client uses `client/.env` for Vite variables. The default local origins are `http://localhost:5173` (frontend) and `http://localhost:5000` (backend). Set `VITE_API_BASE_URL` to the backend origin and `FRONTEND_URL` to the frontend origin when using different hosts or ports. Trailing slashes are removed when the URLs are used.

### Environment configuration

No `.env.example` file is currently present. Create local environment files without committing credentials. The backend reads the following variables; the client reads the Vite variable:

| Variable | Used by | Purpose |
| --- | --- | --- |
| `PORT` | Backend | Express port; defaults to `5000`. |
| `MONGODB_URI` | Backend | MongoDB connection string. |
| `REDIS_URL` | Backend | Redis connection; defaults to local Redis on port `6379`. |
| `GROQ_API_KEY` | Backend | Groq API authentication for review analysis. |
| `JWT_SECRET` | Backend | Signs and verifies CodeGuard API tokens. |
| `FRONTEND_URL` | Backend | Frontend origin used for OAuth and GitHub App callback redirects; defaults to local Vite. |
| `GITHUB_CLIENT_ID` | Backend | GitHub OAuth App client ID for CodeGuard sign-in. |
| `GITHUB_CLIENT_SECRET` | Backend | GitHub OAuth App client secret. |
| `VITE_API_BASE_URL` | Client build | Backend origin used by frontend API requests; defaults to local Express. |
| `GITHUB_APP_ID` | Backend | GitHub App ID used to sign App JWTs. |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Backend | Preferred path to the GitHub App PEM private key. |
| `GITHUB_APP_PRIVATE_KEY` | Backend | Alternative inline PEM private key; escaped `\\n` newlines are converted. |
| `GITHUB_APP_CLIENT_ID` | Backend | GitHub App client ID for its separate user-authorization flow. |
| `GITHUB_APP_CLIENT_SECRET` | Backend | GitHub App client secret for that flow. |
| `GITHUB_APP_INSTALL_URL` | Backend | GitHub App installation URL used to begin installation. |
| `GITHUB_APP_CALLBACK_URL` | Backend | App authorization callback URL; must match the GitHub App registration. |
| `WEBHOOK_SECRET` | Backend | Secret used to verify GitHub webhook signatures; must match the App's webhook secret. |

Keep secret values out of source control. The OAuth callback URL is configured in GitHub Developer Settings rather than through a separate callback environment variable.

## GitHub configuration

GitHub App delivery requires a publicly reachable HTTPS backend. Replace `<backend-origin>` below with that backend's origin:

| GitHub setting | URL |
| --- | --- |
| GitHub App webhook | `<backend-origin>/api/webhooks/github` |
| GitHub App Setup URL | `<backend-origin>/api/github/app/installations/setup` |
| GitHub App callback URL | `<backend-origin>/api/github/app/callback` (must match `GITHUB_APP_CALLBACK_URL`) |
| CodeGuard OAuth App callback URL | `<backend-origin>/api/auth/github/callback` |

Configure the GitHub App with:

- **Repository permissions:** Pull requests: Read to receive pull request events and read PR diffs. For optional PR comments, grant Issues: Write or Pull requests: Write.
- **Webhook events:** Subscribe to `pull_request` and `installation`. CodeGuard handles pull request actions `opened` and `synchronize`, and installation actions `created`, `suspend`, `unsuspend`, and `deleted`. It also handles `installation_repositories` actions `added` and `removed`; GitHub delivers this event to Apps by default, so it is not a selectable subscription.
- **Webhook secret:** Configure a secret in GitHub and set the same value as backend `WEBHOOK_SECRET`.
- **Installation authorization:** Leave “Request user authorization during installation” disabled. The current flow associates the installation and then performs a separate authorization callback.

For CodeGuard sign-in, configure a GitHub OAuth App with the OAuth callback URL above. The implementation requests `repo` and `read:user` scopes. This OAuth App is separate from the GitHub App and its client credentials.

## Project checks

Run frontend checks from `client/`:

```bash
npm run lint
npm run build
```

The backend package provides `npm run dev` and `npm start` scripts. There is no dedicated backend test script in the current package configuration.
