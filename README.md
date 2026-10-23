# CodeGuard: AI-Powered PR Reviewer

CodeGuard is an automated, event-driven code review platform. It listens for GitHub Pull Request events, queues them via Redis, and leverages Groq's LLMs (openai/gpt-oss-20b) to perform static analysis and post structured feedback directly to the GitHub PR timeline.

## Architecture

1. **Event Trigger:** Developer opens a PR on GitHub.
2. **Webhook Receiver:** Express API receives the payload, verifies the HMAC signature, and instantly responds `200 OK`.
3. **Message Queue:** Job is pushed to **BullMQ** (backed by Dockerized **Redis**) to prevent API rate-limiting and handle concurrency.
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