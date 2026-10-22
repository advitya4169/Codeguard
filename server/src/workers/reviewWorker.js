import { Worker } from 'bullmq';
import { redisConnection } from '../config/queue.js';
import { getPRDiff } from '../services/githubService.js';
import { cleanDiff } from '../analyzers/staticAnalyzer.js';
import { GoogleGenAI } from '@google/genai';
import ReviewJob from '../models/ReviewJob.js';
import Finding from '../models/Finding.js';
import Repository from '../models/Repository.js';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Enforce Gemini to output a perfectly structured JSON object
const responseSchema = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["bug", "security", "performance", "code_quality", "maintainability"] },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "suggestion"] },
          filePath: { type: "string" },
          lineNumber: { type: "integer" },
          explanation: { type: "string" },
          suggestedFix: { type: "string" }
        },
        required: ["category", "severity", "filePath", "explanation"]
      }
    }
  },
  required: ["findings"]
};

const worker = new Worker(
  'code-review-queue',
  async (job) => {
    const { prNumber, repoFullName, commitSha, accessToken, userId, githubRepoId } = job.data;
    console.log(`\n⚙️ WORKER STARTING: PR #${prNumber} for ${repoFullName}`);

    // 1. Ensure the Repository exists in MongoDB
    const [owner, name] = repoFullName.split('/');
    let repo = await Repository.findOne({ githubRepoId });
    if (!repo) {
      repo = await Repository.create({ githubRepoId, owner, name, fullName: repoFullName, userId });
    }

    // 2. Create the Review Job tracking record
    const reviewJob = await ReviewJob.create({
      repositoryId: repo._id,
      prNumber,
      commitSha,
      status: 'processing'
    });

    await job.updateProgress(10);

    // 3. Fetch and clean the diff (Static Analysis layer)
    const rawDiff = await getPRDiff(repoFullName, prNumber, accessToken);
    const cleanCodeDiff = cleanDiff(rawDiff);

    if (!cleanCodeDiff.trim()) {
      reviewJob.status = 'completed';
      reviewJob.summary = 'No reviewable code changed (only ignored files).';
      await reviewJob.save();
      console.log('Skipped: No valid files to review.');
      return { status: 'skipped' };
    }

    await job.updateProgress(40);
    console.log('- Requesting AI Analysis...');

    // 4. Send to Gemini with Structured Output Enforcement
    const prompt = `You are a strict, senior software engineer reviewing a Pull Request.
Analyze the following Git Diff. Identify bugs, security flaws, performance issues, and code quality problems.
Be highly specific. If a file is fine, do not invent issues.

Git Diff:
${cleanCodeDiff}`;

    const response = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      }
    });

    await job.updateProgress(80);

    // 5. Parse and save findings to MongoDB
    let resultJson;
    try {
      resultJson = JSON.parse(response.text);
    } catch (e) {
      throw new Error(`Failed to parse AI JSON response: ${response.text}`);
    }

    const findings = resultJson.findings || [];
    const findingDocs = findings.map(f => ({
      reviewJobId: reviewJob._id,
      category: f.category,
      severity: f.severity,
      filePath: f.filePath,
      lineNumber: f.lineNumber,
      explanation: f.explanation,
      suggestedFix: f.suggestedFix
    }));

    if (findingDocs.length > 0) {
      await Finding.insertMany(findingDocs);
    }

    reviewJob.status = 'completed';
    reviewJob.summary = `Processed ${findings.length} findings.`;
    await reviewJob.save();

    await job.updateProgress(100);
    console.log(`✅ COMPLETE: Saved ${findings.length} findings to MongoDB.`);
    return { status: 'success', findingsCount: findings.length };
  },
  { connection: redisConnection, concurrency: 5 }
);

worker.on('failed', async (job, err) => {
  console.error(`❌ JOB FAILED: ${job.id}, Reason: ${err.message}`);
});

export default worker;