
import { Worker } from "bullmq";
import Groq from "groq-sdk";
import dotenv from "dotenv";

import { redisConnection } from "../config/queue.js";
import { getPRDiff, postPRComment } from '../services/githubService.js';
import { cleanDiff } from "../analyzers/staticAnalyzer.js";

import ReviewJob from "../models/ReviewJob.js";
import Finding from "../models/Finding.js";
import Repository from "../models/Repository.js";

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

const worker = new Worker(
  "code-review-queue",
  async (job) => {
    const {
      prNumber,
      repoFullName,
      commitSha,
      accessToken,
      userId,
      githubRepoId,
    } = job.data;

    console.log(
      `\nWORKER STARTING: PR #${prNumber} for ${repoFullName}`
    );

    let reviewJob;

    try {
      // 1. Find or create the repository record.
      const [owner, name] = repoFullName.split("/");

      let repo = await Repository.findOne({ githubRepoId });

      if (!repo) {
        repo = await Repository.create({
          githubRepoId,
          owner,
          name,
          fullName: repoFullName,
          userId,
        });
      }

      // 2. Create a record to track this review.
      reviewJob = await ReviewJob.create({
        repositoryId: repo._id,
        prNumber,
        commitSha,
        status: "processing",
      });

      await job.updateProgress(10);

      // 3. Fetch the PR diff from GitHub.
      console.log("- Fetching PR diff...");

      const rawDiff = await getPRDiff(
        repoFullName,
        prNumber,
        accessToken
      );

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

      const findings = await analyzeDiff(cleanCodeDiff);

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

      // 7. Save findings, if any were returned.
      if (findingDocs.length > 0) {
      await Finding.insertMany(findingDocs); // Your existing working code
      
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
      
      await postPRComment(repoFullName, prNumber, accessToken, markdownReport);
      console.log('✅ Posted review comment to GitHub PR!');
      // -----------------------------------
    }

      // 8. Mark the review as completed.
      reviewJob.status = "completed";
      reviewJob.summary = `Processed ${findings.length} findings.`;

      await reviewJob.save();
      await job.updateProgress(100);

      console.log(
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
  },
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
