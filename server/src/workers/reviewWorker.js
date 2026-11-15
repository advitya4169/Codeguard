
import { UnrecoverableError, Worker } from "bullmq";
import dotenv from "dotenv";

import { redisConnection } from "../config/redis.js";
import { REVIEW_QUEUE_NAME } from "../config/queueNames.js";
import {
  createPRReview,
  getPRDiff,
  getPRHeadSha,
  listPRComments,
  listPRReviews,
  postPRComment,
} from '../services/githubService.js';
import { getInstallationAccessToken } from '../services/githubAppService.js';
import {
  analyzeDiffWithGroq,
  calculateReviewBackoff,
  extractRateLimitRetryMs,
  isPermanentError,
  GroqTruncatedResponseError,
} from '../services/groqService.js';
import { cleanDiff } from "../analyzers/staticAnalyzer.js";
import { createFindingDiffContextExtractor, validateFindingsForReview } from "../analyzers/diffFindingValidator.js";
import { createGitHubReviewPublisher } from '../services/githubReviewPublisher.js';

import ReviewJob from "../models/ReviewJob.js";
import Finding from "../models/Finding.js";
import Repository from "../models/Repository.js";
import Installation from "../models/Installation.js";

dotenv.config({ quiet: true });

const MODEL = "openai/gpt-oss-20b";
// The configured model has a 131,072-token context window. Keep the diff below
// this conservative UTF-8 byte budget to reserve context for the prompt and
// the 8,192-token completion allowance without silently trimming review input.
export const MAX_REVIEW_DIFF_BYTES = 96_000;

const allowedCategories = [
  "bug",
  "security",
  "performance",
  "code_quality",
  "maintainability",
];

const allowedSeverities = [
  "critical",
  "high",
  "medium",
  "low",
  "suggestion",
];

// Ask Groq to review a diff and return structured findings.
async function analyzeDiff(diff) {
  return analyzeDiffWithGroq(diff, {
    parseResponseFn: parseReviewResponse,
  });
}

const normalizeFindingTitle = (title) => {
  if (typeof title !== "string") return undefined;
  const normalized = title.trim();
  if (!normalized || normalized.length > 120 || normalized.split(/\s+/).length > 8) {
    return undefined;
  }
  return normalized;
};

export const parseReviewResponse = (responseText, choice = null) => {
  if (choice?.finish_reason === "length") {
    throw new GroqTruncatedResponseError(
      "Groq review response was truncated because the completion token limit was reached."
    );
  }

  let result;

  try {
    result = JSON.parse(responseText);
  } catch {
    if (choice?.finish_reason === "length") {
      throw new GroqTruncatedResponseError(
        "Groq review response was truncated because the completion token limit was reached."
      );
    }
    console.error("Groq returned invalid JSON.");
    throw new Error("Groq returned invalid JSON");
  }

  if (!result || !Array.isArray(result.findings)) {
    throw new Error('AI response must contain a "findings" array');
  }

  // Validate the established finding fields. Titles are optional metadata and
  // malformed titles are omitted so the UI can use its fallback.
  for (const finding of result.findings) {
    if (
      !finding ||
      !allowedCategories.includes(finding.category) ||
      !allowedSeverities.includes(finding.severity) ||
      typeof finding.filePath !== "string" ||
      typeof finding.explanation !== "string" ||
      typeof finding.suggestedFix !== "string" ||
      !Number.isInteger(finding.lineNumber) ||
      finding.lineNumber < 0
    ) {
      throw new Error("AI returned a finding with invalid fields");
    }
  }

  return result.findings.map((finding) => {
    const title = normalizeFindingTitle(finding.title);
    if (!title) {
      const findingWithoutTitle = { ...finding };
      delete findingWithoutTitle.title;
      return findingWithoutTitle;
    }
    return { ...finding, title };
  });
};

export const createReviewProcessor = ({
  ReviewJobModel = ReviewJob,
  FindingModel = Finding,
  RepositoryModel = Repository,
  InstallationModel = Installation,
  getPRDiffFn = getPRDiff,
  getPRHeadShaFn = getPRHeadSha,
  listPRReviewsFn = listPRReviews,
  listPRCommentsFn = listPRComments,
  createPRReviewFn = createPRReview,
  postPRCommentFn = postPRComment,
  getInstallationAccessTokenFn = getInstallationAccessToken,
  analyzeDiffFn = analyzeDiff,
  logger = console,
} = {}) => async (job) => {
  const publishGitHubReview = createGitHubReviewPublisher({
    getPRHeadShaFn,
    listPRReviewsFn,
    listPRCommentsFn,
    createPRReviewFn,
    postPRCommentFn,
  });
  const data = job?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Review job metadata is invalid.");
  }

  const {
      prNumber,
      repoFullName: queuedRepoFullName,
      commitSha,
      accessToken,
      userId,
      githubRepoId,
      installationId,
  } = data;
  const hasInstallationMetadata = Object.prototype.hasOwnProperty.call(data, "installationId");

  if (
      !Number.isSafeInteger(prNumber) || prNumber <= 0 ||
      !Number.isSafeInteger(githubRepoId) || githubRepoId <= 0 ||
      typeof commitSha !== "string" || !commitSha.trim() ||
      typeof userId !== "string" || !/^[a-f\d]{24}$/i.test(userId)
  ) {
    throw new Error("Review job metadata is invalid.");
  }

  logger.log(
      `\nWORKER STARTING: PR #${prNumber} for ${queuedRepoFullName || "connected repository"}`
  );

  let reviewJob;
  let repo;
  let authToken;
  let needsInstallationToken = false;
  let analysisCompleted = false;
  let completedFindingsCount = 0;

  try {
      if (hasInstallationMetadata) {
        if (
          typeof installationId !== "string" ||
          !/^[1-9]\d{0,19}$/.test(installationId) ||
          Object.prototype.hasOwnProperty.call(data, "accessToken")
        ) {
          throw new Error("GitHub App review job metadata is invalid.");
        }

        const installation = await InstallationModel.findOne({
          installationId,
          userId,
          status: "active",
        });
        if (!installation) {
          throw new Error(
            "GitHub App installation is unavailable or inactive. Reauthorize the installation and retry the review."
          );
        }

        repo = await RepositoryModel.findOne({
          githubRepoId,
          userId,
          installationId,
          isConnected: true,
          isHookActive: true,
        });
        if (!repo) {
          throw new Error(
            "Repository is no longer connected to this GitHub App installation. Reconnect it and retry the review."
          );
        }

        needsInstallationToken = true;
      } else {
        if (typeof accessToken !== "string" || !accessToken) {
          throw new Error("Legacy OAuth review job is missing its GitHub access token.");
        }

        // A legacy job must remain OAuth-backed; it cannot fall through to an App repository.
        repo = await RepositoryModel.findOne({
          githubRepoId,
          userId,
          isConnected: true,
          installationId: { $in: [null, ""] },
        });
        authToken = accessToken;
      }

      // Webhooks may only process repositories explicitly connected by a user.
      // Never claim or create repository ownership from a PR event.
      if (!repo) {
        throw new Error("Repository is no longer connected to this CodeGuard user");
      }
      const repoFullName = repo.fullName;
      if (typeof repoFullName !== "string" || !repoFullName) {
        throw new Error("Connected repository metadata is invalid.");
      }

      // Reuse one persisted review record for every attempt on this PR head.
      const reviewIdentity = {
        repositoryId: repo._id,
        prNumber,
        commitSha,
      };
      const reviewUpdate = {
        $set: {
          status: "processing",
          summary: "Review is processing.",
          githubPublicationStatus: "pending",
        },
        $unset: {
          githubPublicationId: 1,
          githubPublicationUrl: 1,
          githubPublishedAt: 1,
        },
      };

      try {
        reviewJob = await ReviewJobModel.findOneAndUpdate(
          reviewIdentity,
          reviewUpdate,
          { new: true, upsert: true, setDefaultsOnInsert: true }
        );
      } catch (error) {
        // A concurrent upsert can win the unique-index race; reuse its row.
        if (error?.code !== 11000) throw error;
        reviewJob = await ReviewJobModel.findOneAndUpdate(
          reviewIdentity,
          reviewUpdate,
          { new: true }
        );
        if (!reviewJob) throw error;
      }

      if (needsInstallationToken) {
        let tokenResult;
        try {
          tokenResult = await getInstallationAccessTokenFn(installationId);
        } catch (error) {
          if ([401, 403, 404].includes(error?.status)) {
            throw new Error(
              "GitHub App installation access is unavailable. Restore the installation and repository access, then retry the review."
            );
          }
          throw new Error(
            "Could not obtain GitHub App installation access. Check the installation and App configuration, then retry the review."
          );
        }
        if (
          !tokenResult || typeof tokenResult.token !== "string" || !tokenResult.token ||
          !Number.isFinite(Date.parse(tokenResult.expiresAt)) ||
          Date.parse(tokenResult.expiresAt) <= Date.now()
        ) {
          throw new Error("GitHub App returned an invalid or expired installation token.");
        }
        authToken = tokenResult.token;
      }

      // A queued job may have waited long enough for a newer PR revision to arrive.
      const initialHeadSha = await getPRHeadShaFn(repoFullName, prNumber, authToken);
      if (initialHeadSha !== commitSha) {
        reviewJob.status = "stale";
        reviewJob.githubPublicationStatus = "stale";
        reviewJob.summary = "Skipped because the pull request has a newer commit. A newer review will handle that revision.";
        await reviewJob.save();
        logger.log('[review] skipped stale queued commit', { repositoryId: String(repo._id), prNumber, commitSha });
        return { status: "stale" };
      }

      await job.updateProgress(10);

      // 3. Fetch the PR diff from GitHub.
      console.log("- Fetching PR diff...");

      let rawDiff;
      try {
        rawDiff = await getPRDiffFn(
          repoFullName,
          prNumber,
          authToken
        );
      } catch (error) {
        if (hasInstallationMetadata && [401, 403, 404].includes(error?.status)) {
          throw new Error(
            "GitHub App can no longer access this pull request. Restore repository access in the installation, then retry the review."
          );
        }
        throw error;
      }

      // The PR can advance while its diff is being fetched. Avoid spending AI time
      // on a diff that no longer corresponds to the queued commit.
      const diffHeadSha = await getPRHeadShaFn(repoFullName, prNumber, authToken);
      if (diffHeadSha !== commitSha) {
        reviewJob.status = "stale";
        reviewJob.githubPublicationStatus = "stale";
        reviewJob.summary = "Skipped because the pull request changed while its diff was loading. A newer review will handle that revision.";
        await reviewJob.save();
        logger.log('[review] skipped commit that changed during diff fetch', { repositoryId: String(repo._id), prNumber, commitSha });
        return { status: "stale" };
      }

      // 4. Remove excluded files.
      const cleanCodeDiff = cleanDiff(rawDiff);

      if (!cleanCodeDiff.trim()) {
        reviewJob.status = "completed";
        reviewJob.githubPublicationStatus = "not_needed";
        reviewJob.summary =
          "No reviewable code changed (only ignored files).";

        await reviewJob.save();
        await job.updateProgress(100);

        console.log("Skipped: No reviewable files changed.");

        return { status: "skipped" };
      }

      const diffSizeBytes = Buffer.byteLength(cleanCodeDiff, "utf8");
      if (diffSizeBytes > MAX_REVIEW_DIFF_BYTES) {
        throw new Error(
          `This pull request diff is too large for a reliable AI review (maximum ${MAX_REVIEW_DIFF_BYTES} UTF-8 bytes). Reduce the diff or split the changes into smaller pull requests, then retry.`
        );
      }

      await job.updateProgress(40);

      // 5. Analyze the diff using Groq.
      console.log("- Requesting Groq AI analysis...");

      const aiFindings = await analyzeDiffFn(cleanCodeDiff);
      const { commentableFindings, unanchoredFindings } = validateFindingsForReview(aiFindings, cleanCodeDiff);
      const findings = [...commentableFindings, ...unanchoredFindings];
      const getFindingDiffContext = createFindingDiffContextExtractor(cleanCodeDiff);

      await job.updateProgress(80);

      // 6. Prepare MongoDB finding documents.
      const findingDocs = findings.map((finding) => {
        const diffContext = getFindingDiffContext(finding);
        return {
          reviewJobId: reviewJob._id,
          title: finding.title,
          category: finding.category,
          severity: finding.severity,
          filePath: finding.filePath,
          lineNumber: finding.lineNumber ?? undefined,
          explanation: finding.explanation,
          suggestedFix: finding.suggestedFix,
          ...(diffContext.length ? { diffContext } : {}),
        };
      });

      // Replace the prior attempt's findings, including when the new result is empty.
      await FindingModel.deleteMany({ reviewJobId: reviewJob._id });

      // 7. Save findings, if any were returned.
      if (findingDocs.length > 0) {
        await FindingModel.insertMany(findingDocs);
      }

      // Persist analysis completion before the optional external comment. Once
      // this succeeds, a later comment-side issue cannot cause AI analysis to
      // run again and post a duplicate comment on a retry.
      await job.updateProgress(90);
      reviewJob.status = "completed";
      reviewJob.summary = `Processed ${findings.length} findings.`;
      reviewJob.githubPublicationStatus = findings.length ? "pending" : "not_needed";
      await reviewJob.save();
      analysisCompleted = true;
      completedFindingsCount = findings.length;
      try {
        await job.updateProgress(100);
      } catch (error) {
        try {
          logger.error('Review results were saved, but BullMQ progress could not be updated.', {
            errorType: error?.name || 'Error',
          });
        } catch {
          // Progress reporting must not undo a successfully persisted review.
        }
      }

      if (findingDocs.length > 0) {
        const inlineCount = commentableFindings.length;
        const unanchoredCount = unanchoredFindings.length;
        let publication;
        try {
          publication = await publishGitHubReview({
            repositoryId: String(repo._id),
            repoFullName,
            prNumber,
            commitSha,
            accessToken: authToken,
            commentableFindings,
            unanchoredFindings,
          });
        } catch (error) {
          publication = { status: error?.ambiguous ? 'uncertain' : 'failed', error };
        }

        if (publication.status === 'stale') {
          reviewJob.githubPublicationStatus = 'stale';
        } else if (publication.status === 'published' || publication.status === 'duplicate') {
          reviewJob.githubPublicationStatus = publication.status;
          reviewJob.githubPublicationId = Number.isSafeInteger(publication.id) ? publication.id : undefined;
          reviewJob.githubPublicationUrl = typeof publication.url === 'string' ? publication.url : undefined;
          if (publication.status === 'published') reviewJob.githubPublishedAt = new Date();
        } else {
          reviewJob.githubPublicationStatus = publication.status;
        }
        try {
          await reviewJob.save();
        } catch (error) {
          logger.error('[github-review] publication metadata could not be persisted', { errorType: error?.name || 'Error' });
        }

        logger.log('[github-review] publication outcome', {
          repositoryId: String(repo._id),
          prNumber,
          commitSha,
          findingsConsidered: findingDocs.length,
          inlineComments: publication.inlineCount ?? 0,
          unanchoredFindings: unanchoredCount,
          status: publication.status,
          responseStatus: publication.responseStatus ?? publication.error?.status,
          endpoint: publication.error?.endpoint,
          acceptedPermissions: publication.error?.acceptedPermissions,
        });
      }

      try {
        logger.log(`COMPLETE: Saved ${findings.length} findings to MongoDB.`);
      } catch {
        // A logging failure must not re-run completed analysis or comments.
      }

      return {
        status: "success",
        findingsCount: findings.length,
      };
    } catch (error) {
      if (analysisCompleted) {
        try {
          logger.error('Review completed, but a post-completion operation failed.', {
            errorType: error?.name || 'Error',
          });
        } catch {
          // Do not retry completed analysis because diagnostics failed.
        }
        return { status: "success", findingsCount: completedFindingsCount };
      }

      // Keep the persisted state aligned with BullMQ's automatic retry lifecycle.
      if (reviewJob) {
        const permanent = isPermanentError(error);
        const hasAutomaticRetry = !permanent &&
          Number.isInteger(job?.opts?.attempts) &&
          Number.isInteger(job?.attemptsMade) &&
          job.attemptsMade + 1 < job.opts.attempts;

        const rateLimitMs = extractRateLimitRetryMs(error);
        const retryDelaySec = rateLimitMs ? Math.round(rateLimitMs / 1000) : null;

        reviewJob.status = hasAutomaticRetry ? "queued" : "failed";
        reviewJob.summary = hasAutomaticRetry
          ? (retryDelaySec ? `Rate limit reached. Automatic retry scheduled in ${retryDelaySec}s.` : "Review attempt failed. Another automatic attempt is queued.")
          : error.message;
        await reviewJob.save();

        if (permanent) {
          const unrecoverable = new UnrecoverableError(error.message);
          unrecoverable.cause = error;
          throw unrecoverable;
        }

        if (job?.opts?.backoff) {
          job.opts.backoff = {
            ...job.opts.backoff,
            type: 'custom',
          };
        }
      }

      throw error;
    }
  };

export const startReviewWorker = (overrides = {}) => {
  const worker = new Worker(
    REVIEW_QUEUE_NAME,
    createReviewProcessor(),
    {
      connection: redisConnection,
      concurrency: 5,
      ...overrides,
      settings: {
        backoffStrategy: calculateReviewBackoff,
        ...overrides.settings,
      },
    },
  );

  worker.on("failed", (job, error) => {
    console.error(`JOB FAILED: ${job?.id}, Reason: ${error.message}`);
  });

  return worker;
};

export default startReviewWorker;
