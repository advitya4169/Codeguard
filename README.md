# CodeGuard: AI-Powered PR Reviewer

CodeGuard is an automated, event-driven code review platform. It listens for GitHub Pull Request events, queues them via Redis, and leverages Groq's LLMs (openai/gpt-oss-20b) to perform static analysis and post structured feedback directly to the GitHub PR timeline.

## Architecture

1. **Event Trigger:** Developer opens a PR on GitHub.
2. **Webhook Receiver:** Express API receives the payload and verifies the HMAC signature. For supported pull request events, it resolves the connected repository and user and adds the job to BullMQ before returning a successful acknowledgement. Intentionally ignored events are acknowledged without queueing.
3. **Message Queue:** The job is pushed to **BullMQ** (backed by Dockerized **Redis**) to handle background processing and retries.
4. **Background Worker:** A Node.js worker process picks up the job, fetches the PR diff via the GitHub API, and runs it through a custom static analyzer to strip lockfiles and binaries.
5. **AI Inference:** The cleaned diff is sent to **Groq API**.
6. **Persistence & Feedback:** Structured JSON findings are saved to **MongoDB** and dynamically formatted into a Markdown table posted back to the GitHub PR via the Comments API.
7. **Analytics UI:** A **React/Tailwind** dashboard fetches review history from MongoDB.

## Tech Stack
* **Frontend:** React, Tailwind CSS, Lucide Icons
* **Backend:** Node.js, Express, MongoDB (Mongoose)
* **Infrastructure:** Docker, Redis, BullMQ
* **AI:** Groq API (openai/gpt-oss-20b)
* **Auth:** GitHub OAuth, JWT

## Frontend and backend URLs

The frontend uses `VITE_API_BASE_URL` as the backend origin for API requests and the GitHub login link. The backend uses `FRONTEND_URL` as the frontend origin for OAuth success and failure redirects. Both variables should be set to origins without a path; trailing slashes are removed automatically.

For local development, the defaults are `http://localhost:5000` for the backend and `http://localhost:5173` for the frontend. For deployment, set `VITE_API_BASE_URL` in the client build environment and `FRONTEND_URL` in the server runtime environment. The GitHub OAuth App's callback URL must also be configured in GitHub Developer Settings to point to the deployed backend's `/api/auth/github/callback` route.

### GitHub App configuration

The GitHub App installation association flow requires these server environment variables:

- `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` for GitHub App JWT authentication.
- `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` for the separate GitHub App user-authorization code flow. These are distinct from `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` used for CodeGuard login.
- `GITHUB_APP_INSTALL_URL`, set to the App's GitHub installation URL (for example, `https://github.com/apps/<app-slug>/installations/new`).
- `GITHUB_APP_CALLBACK_URL`, set to the backend `/api/github/app/callback` URL and registered as a GitHub App callback URL.
- `WEBHOOK_SECRET`, set in the server runtime and entered as the GitHub App's Webhook secret. The values must match; do not commit or share the secret.

The GitHub App needs **Pull requests: read** to receive pull request events and fetch PR diffs. CodeGuard posts comments optionally through the issue-comment API, which requires **Issues: write** or **Pull requests: write**. Subscribe the App to the `pull_request` and `installation` webhook events. CodeGuard processes pull request actions `opened` and `synchronize`, and installation actions `created`, `suspend`, `unsuspend`, and `deleted`. The code also handles `installation_repositories` events (`added` and `removed`) to track repository access changes; GitHub delivers this event to Apps by default, so it is not a selectable event subscription.

Configure the following URLs in GitHub Developer settings, replacing `<backend-origin>` with the deployed backend's public origin:

| GitHub setting | URL |
| --- | --- |
| GitHub App Webhook URL | `<backend-origin>/api/webhooks/github` |
| GitHub App Setup URL | `<backend-origin>/api/github/app/installations/setup` |
| GitHub App Callback URL | `<backend-origin>/api/github/app/callback` (must match `GITHUB_APP_CALLBACK_URL`) |
| CodeGuard OAuth App callback URL | `<backend-origin>/api/auth/github/callback` |

The backend must be publicly reachable over HTTPS so GitHub can deliver webhooks and reach the Setup and callback routes. Do not enable **Request user authorization during installation** for the current two-step flow: GitHub does not allow a Setup URL when that option is enabled. After GitHub returns to the Setup URL, CodeGuard validates the installation and starts the separate user-authorization flow using the configured callback URL. Installation access tokens are short-lived and are not stored.
