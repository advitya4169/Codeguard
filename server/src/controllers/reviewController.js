import Groq from 'groq-sdk';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

if (!process.env.GROQ_API_KEY) {
  throw new Error('GROQ_API_KEY is not defined in .env');
}

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Maximum characters accepted per request.
// Keeps prompts within a reasonable token budget and prevents credit exhaustion.
const MAX_CODE_CHARS = 10_000;
const MAX_REVIEW_TOKENS = 2_048;

function getReviewMarkdownFailures(review) {
  const quickSummaryHeading = /^## Quick Summary\s*$/m;
  const findingsHeading = /^## Detailed Findings\s*$/m;
  const assessmentHeading = /^## Overall Assessment\s*$/m;
  const quickSummaryMatch = review.match(
    /^## Quick Summary\s*$([\s\S]*?)^## Detailed Findings\s*$/m
  );
  const findingsMatch = review.match(
    /^## Detailed Findings\s*$([\s\S]*?)^## Overall Assessment\s*$/m
  );
  const assessmentMatch = review.match(/^## Overall Assessment\s*$([\s\S]+)$/m);
  const summaryPosition = review.search(quickSummaryHeading);
  const findingsPosition = review.search(findingsHeading);
  const assessmentPosition = review.search(assessmentHeading);
  const failures = [];

  if (
    !quickSummaryHeading.test(review) ||
    !findingsHeading.test(review) ||
    !assessmentHeading.test(review)
  ) {
    failures.push('required_sections');
  }

  if (
    !quickSummaryMatch ||
    !findingsMatch ||
    !assessmentMatch ||
    !(summaryPosition < findingsPosition && findingsPosition < assessmentPosition)
  ) {
    failures.push('section_order_or_body');
  }

  if (quickSummaryMatch) {
    const summaryLines = quickSummaryMatch[1]
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const expectedHeaders = ['Area', 'Issue', 'Why It Matters', 'Fix'];
    const headerLine = summaryLines.find((line) => line.startsWith('|'));
    const headerIndex = summaryLines.indexOf(headerLine);

    if (!headerLine || headerIndex < 0) {
      failures.push('summary_table_header_missing');
    } else {
      const headers = headerLine
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      const separator = summaryLines[headerIndex + 1];
      const bodyRows = summaryLines.slice(headerIndex + 2);

      if (
        headers.length !== expectedHeaders.length ||
        !headers.every((header, index) => header === expectedHeaders[index])
      ) {
        failures.push('summary_table_header_mismatch');
      }
      if (
        !separator ||
        !/^\|\s*:?-+:?\s*\|\s*:?-+:?\s*\|\s*:?-+:?\s*\|\s*:?-+:?\s*\|$/.test(separator)
      ) {
        failures.push('summary_table_separator');
      }
      if (
        bodyRows.length === 0 ||
        !bodyRows.every((row) => row.startsWith('|') && row.split('|').length === 6)
      ) {
        failures.push('summary_table_rows');
      }
    }
  }

  const lastLine = review.trim().split('\n').at(-1)?.trim() || '';
  const fenceCount = (review.match(/```/g) || []).length;
  const assessmentText = assessmentMatch?.[1].trim() || '';

  if (!findingsMatch?.[1].trim()) failures.push('detailed_findings_empty');
  if (!assessmentText) failures.push('overall_assessment_empty');
  if (/^#{1,6}\s/m.test(assessmentText)) {
    failures.push('heading_after_overall_assessment');
  }

  if (/^#{1,6}(?:\s|$)/.test(lastLine)) failures.push('unfinished_final_heading');
  if (/^\s*(?:\d+[.)]|[-*+])\s*$/.test(lastLine)) {
    failures.push('unfinished_final_list_item');
  }
  if (fenceCount % 2 !== 0) failures.push('unclosed_code_fence');

  return failures;
}

function incompleteReviewError(message, metadata) {
  const error = new Error(message);
  error.code = 'INCOMPLETE_REVIEW';
  Object.assign(error, metadata);
  return error;
}

async function generateReview(prompt, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model: 'openai/gpt-oss-20b',
        messages: [
          {
            role: 'system',
            content:
              'You are a senior software engineer. Review code for bugs, security vulnerabilities, performance issues, and code quality. Give clear, actionable feedback.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0,
        max_completion_tokens: MAX_REVIEW_TOKENS,
      });

      const choice = completion.choices[0];
      const review = choice?.message?.content;

      if (choice?.finish_reason === 'length') {
        throw incompleteReviewError('Groq truncated the review at the token limit.', {
          finishReason: choice.finish_reason,
          responseLength: typeof review === 'string' ? review.length : 0,
          failedChecks: ['finish_reason_length'],
        });
      }

      if (typeof review !== 'string' || !review.trim()) {
        throw new Error('Groq returned an empty response');
      }

      const failedChecks = getReviewMarkdownFailures(review);
      if (failedChecks.length > 0) {
        throw incompleteReviewError('Groq returned an incomplete review.', {
          finishReason: choice?.finish_reason ?? 'unknown',
          responseLength: review.length,
          failedChecks,
        });
      }

      return review;
    } catch (error) {
      const retryableStatuses = [429, 500, 502, 503, 504];
      const isRetryable = retryableStatuses.includes(error.status);

      if (!isRetryable || attempt === retries - 1) {
        throw error;
      }

      const delay = 2000 * Math.pow(2, attempt);

      console.log(
        `Groq request failed (${error.status}). Retrying in ${
          delay / 1000
        } seconds...`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error('Code review failed after all retry attempts');
}

export const analyzeCode = async (req, res) => {
  try {
    const { code } = req.body;

    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({
        error: 'Valid code string is required in the request body.',
      });
    }

    // Reject payloads that exceed the character cap.
    // The frontend enforces the same limit; this check is the authoritative guard.
    if (code.length > MAX_CODE_CHARS) {
      return res.status(400).json({
        error: `Code must be ${MAX_CODE_CHARS.toLocaleString()} characters or fewer.`,
      });
    }

    const prompt = `
Review only the code provided below. Report genuine, high-confidence problems directly supported by that code. Do not assume behavior or context that is not shown, and do not invent file paths, line numbers, test results, or runtime behavior.

Keep the review concise. Include at most three important confirmed findings, ordered by severity. Separate confirmed issues from optional improvements; include optional improvements only when they are specific and useful, and label them clearly. Do not include generic production-readiness checklists.

Return complete, valid Markdown using exactly these top-level sections and this structure:

## Quick Summary

Include a compact Markdown table with exactly these columns: Area, Issue, Why It Matters, Fix. Keep each cell brief. Use this table to identify findings only; do not repeat their full explanations here. If there are no confirmed issues, include one row that says so.

## Detailed Findings

Explain only the most important confirmed issues. Give each a clear heading, a concise explanation grounded in the submitted code, and a concrete suggested fix. Label optional improvements separately and include them only when warranted. If there are no confirmed issues, say so briefly.

## Overall Assessment

End with one short closing paragraph. Do not add another section after it.

Before responding, check that the table is complete, every code fence is closed, all headings and list items have content, the required sections are present, and the final assessment is complete. Never leave a dangling number, unfinished heading, incomplete table, or partial code block.

Code to review:
\`\`\`
${code}
\`\`\`
`;

    const reviewText = await generateReview(prompt);

    return res.status(200).json({
      review: reviewText,
    });
  } catch (error) {
    console.error('Error generating review:', error.message);

    if (error.code === 'INCOMPLETE_REVIEW') {
      console.warn('Groq demo review rejected as incomplete:', {
        finishReason: error.finishReason,
        responseLength: error.responseLength,
        failedChecks: error.failedChecks,
      });
      const retryAdvice = error.failedChecks.includes('finish_reason_length')
        ? 'Please retry with a smaller snippet.'
        : 'Please try again.';
      return res.status(502).json({
        error: `The review response was incomplete and was not displayed. ${retryAdvice}`,
      });
    }

    return res.status(500).json({
      error: 'An error occurred while generating the code review.',
      details: error.message,
    });
  }
};
