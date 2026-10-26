
import { Worker } from "bullmq";
import Groq from "groq-sdk";
import dotenv from "dotenv";

import { redisConnection } from "../config/queue.js";
import { getPRDiff, postPRComment } from '../services/githubService.js';
import { getInstallationAccessToken } from '../services/githubAppService.js';
import { cleanDiff } from "../analyzers/staticAnalyzer.js";

import ReviewJob from "../models/ReviewJob.js";
import Finding from "../models/Finding.js";
import Repository from "../models/Repository.js";
import Installation from "../models/Installation.js";

dotenv.config({ quiet: true });

if (!process.env.GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY is not defined in .env");
}

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const MODEL = "openai/gpt-oss-20b";

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
  const prompt = `
Review this Git diff as a senior software engineer.

Identify genuine:
- Bugs
- Security vulnerabilities
- Performance issues
- Code quality problems
- Maintainability issues

Do not invent findings. Report only problems supported by the diff.
Use paths from the diff and line numbers when identifiable.
Use lineNumber 0 when the line cannot be determined.
If no genuine issues exist, return an empty findings array.

Return exactly one JSON object in this format:
{
  "findings": [
    {
      "category": "bug",
      "severity": "high",
      "filePath": "src/example.js",
      "lineNumber": 10,
      "explanation": "Explain the issue",
      "suggestedFix": "Explain how to fix it"
    }
  ]
}

Allowed categories: ${allowedCategories.join(", ")}.
Allowed severities: ${allowedSeverities.join(", ")}.

Return JSON only. No Markdown fences or surrounding explanation.

Git diff:
${diff}
`;

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are an expert code reviewer. Return one valid JSON object with a findings array. Each finding must include category, severity, filePath, lineNumber, explanation, and suggestedFix. Never invent issues. Return only JSON.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0,
    max_completion_tokens: 8192,
  });

  const choice = completion.choices?.[0];
  const message = choice?.message;

  // Diagnostic metadata helps explain empty model responses.
  // Do not log the API key or the full diff.
  console.log("Groq response diagnostics:", {
    model: completion.model,
    finishReason: choice?.finish_reason,
    contentType: typeof message?.content,
    contentLength:
      typeof message?.content === "string"
        ? message.content.length
        : 0,
    refusal: Boolean(message?.refusal),
    reasoningPresent: Boolean(message?.reasoning),
    usage: completion.usage,
  });

  if (message?.refusal) {
    throw new Error(`Groq refused the review: ${message.refusal}`);
  }

  const responseText = message?.content;

  if (typeof responseText !== "string" || !responseText.trim()) {
    throw new Error(
      `Groq returned no review text. Finish reason: ${
        choice?.finish_reason ?? "unknown"
      }`
    );
  }

  let result;

  try {
    result = JSON.parse(responseText);
  } catch {
    console.error("Groq returned invalid JSON.");
    throw new Error("Groq returned invalid JSON");
  }

  if (!result || !Array.isArray(result.findings)) {
    throw new Error('AI response must contain a "findings" array');
  }

  // Validate the output before storing it in MongoDB.
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

  return result.findings;
}

export const createReviewProcessor = ({
  ReviewJobModel = ReviewJob,
  FindingModel = Finding,
  RepositoryModel = Repository,
  InstallationModel = Installation,
  getPRDiffFn = getPRDiff,
  postPRCommentFn = postPRComment,
  getInstallationAccessTokenFn = getInstallationAccessToken,
  analyzeDiffFn = analyzeDiff,
  logger = console,
} = {}) => async (job) => {
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

      // 4. Remove excluded files.
      const cleanCodeDiff = cleanDiff(rawDiff);

      if (!cleanCodeDiff.trim()) {
        reviewJob.status = "completed";
        reviewJob.summary =
          "No reviewable code changed (only ignored files).";

        await reviewJob.save();
        await job.updateProgress(100);

        console.log("Skipped: No reviewable files changed.");

        return { status: "skipped" };
      }

      await job.updateProgress(40);

      // 5. Analyze the diff using Groq.
      console.log("- Requesting Groq AI analysis...");

      const findings = await analyzeDiffFn(cleanCodeDiff);

      await job.updateProgress(80);

      // 6. Prepare MongoDB finding documents.
      const findingDocs = findings.map((finding) => ({
        reviewJobId: reviewJob._id,
        category: finding.category,
        severity: finding.severity,
        filePath: finding.filePath,
        lineNumber: finding.lineNumber || undefined,
        explanation: finding.explanation,
        suggestedFix: finding.suggestedFix,
      }));

      // Replace the prior attempt's findings, including when the new result is empty.
      await FindingModel.deleteMany({ reviewJobId: reviewJob._id });

      // 7. Save findings, if any were returned.
      if (findingDocs.length > 0) {
      await FindingModel.insertMany(findingDocs); // Your existing working code
      
      // --- NEW: STAGE 7 GITHUB POSTING ---
      await job.updateProgress(90);
      console.log('- Formatting findings for GitHub...');
      
      let markdownReport = `## 🛡️ CodeGuard Review\n\nGroq analyzed this PR and found **${findingDocs.length}** issues:\n\n`;
      markdownReport += `| Severity | Category | File | Line | Finding | Suggested Fix |\n`;
      markdownReport += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
      
      findingDocs.forEach(f => {
        const severityBadge = f.severity === 'critical' ? '🔴' : f.severity === 'high' ? '🟠' : f.severity === 'medium' ? '🟡' : '🔵';
        
        // Sanitize outputs to prevent Markdown table formatting from breaking
        const safeExplanation = f.explanation ? f.explanation.replace(/\|/g, '-').replace(/\n/g, ' ') : 'N/A'; 
        const safeFix = f.suggestedFix ? f.suggestedFix.replace(/\|/g, '-').replace(/\n/g, ' ') : 'N/A';
        
        markdownReport += `| ${severityBadge} ${f.severity.toUpperCase()} | ${f.category} | \`${f.filePath}\` | \`${f.lineNumber || 'N/A'}\` | ${safeExplanation} | ${safeFix} |\n`;
      });
      
      markdownReport += `\n*Processed by CodeGuard (Model: openai/gpt-oss-20b)*`;
      
      try {
        await postPRCommentFn(repoFullName, prNumber, authToken, markdownReport);
        logger.log('✅ Posted review comment to GitHub PR!');
      } catch (error) {
        // Comment delivery is optional; the analyzed findings are already persisted.
        logger.error(
          `GitHub PR comment failed for ${repoFullName}#${prNumber}; review results remain saved.`,
          {
            status: Number.isInteger(error?.status) ? error.status : undefined,
            errorType: error?.name || 'Error',
            endpoint: error?.endpoint,
            responseMessage: error?.responseMessage,
            acceptedPermissions: error?.acceptedPermissions,
          }
        );
      }
      // -----------------------------------
    }

      // 8. Mark the review as completed.
      reviewJob.status = "completed";
      reviewJob.summary = `Processed ${findings.length} findings.`;

      await reviewJob.save();
      await job.updateProgress(100);

      logger.log(
        `COMPLETE: Saved ${findings.length} findings to MongoDB.`
      );

      return {
        status: "success",
        findingsCount: findings.length,
      };
    } catch (error) {
      // Keep failed reviews visible instead of leaving them processing.
      if (reviewJob) {
        reviewJob.status = "failed";
        reviewJob.summary = error.message;
        await reviewJob.save();
      }

      throw error;
    }
  };

const worker = new Worker(
  "code-review-queue",
  createReviewProcessor(),
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

worker.on("failed", (job, error) => {
  console.error(
    `JOB FAILED: ${job?.id}, Reason: ${error.message}`
  );
});

export default worker;
