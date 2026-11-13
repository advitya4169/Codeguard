import { createHash } from 'node:crypto';

import {
  createPRReview,
  getPRHeadSha,
  listPRComments,
  listPRReviews,
  postPRComment,
} from './githubService.js';

export const createCodeGuardMarker = (repositoryId, prNumber, commitSha) => {
  const identity = `${repositoryId}:${prNumber}:${commitSha}`;
  const digest = createHash('sha256').update(identity).digest('hex');
  return `<!-- codeguard-review:v1:${digest} -->`;
};

const formatFinding = (finding) => {
  const suggestedFix = typeof finding.suggestedFix === 'string' && finding.suggestedFix.trim()
    ? `\n\n**Suggested fix:** ${finding.suggestedFix}`
    : '';

  return `**Category:** ${finding.category}\n**Severity:** ${finding.severity}\n\n${finding.explanation}${suggestedFix}`;
};

const formatUnanchoredFindings = (findings) => findings.map((finding) =>
  `- **${finding.severity} ${finding.category}** in \`${finding.filePath}\`: ${finding.explanation}${
    finding.suggestedFix ? ` Suggested fix: ${finding.suggestedFix}` : ''
  }`
).join('\n');

const reviewBody = (marker, unanchoredFindings, inlineCount) => {
  const inlineSummary = inlineCount > 0
    ? `${inlineCount} inline ${inlineCount === 1 ? 'comment is' : 'comments are'} attached to the reviewed commit where the diff provides a reliable changed-line location.`
    : 'No inline comments were attached because no finding had a reliable changed-line location.';
  const details = unanchoredFindings.length
    ? `\n\n### Findings without a reliable changed-line location\n${formatUnanchoredFindings(unanchoredFindings)}`
    : '';
  return `## CodeGuard review\n${inlineSummary}${details}\n\n${marker}`;
};

const fallbackBody = (marker, findings) => `## CodeGuard review\n${findings.map((finding) =>
  `### ${finding.severity} ${finding.category} — \`${finding.filePath}\`${
    Number.isInteger(finding.lineNumber) ? `:${finding.lineNumber}` : ''
  }\n${finding.explanation}${finding.suggestedFix ? `\n\n**Suggested fix:** ${finding.suggestedFix}` : ''}`
).join('\n\n')}\n\n${marker}`;

const markerExists = (marker, commitSha, reviews, comments) => {
  const reviewMatch = reviews.find((review) =>
    typeof review.body === 'string' && review.body.includes(marker) && review.commit_id === commitSha
  );
  if (reviewMatch) return { id: reviewMatch.id, url: reviewMatch.html_url, type: 'review' };

  const commentMatch = comments.find((comment) =>
    typeof comment.body === 'string' && comment.body.includes(marker)
  );
  return commentMatch
    ? { id: commentMatch.id, url: commentMatch.html_url, type: 'comment' }
    : null;
};

/** Publishes one idempotent grouped review, falling back only for definitive API rejection. */
export const createGitHubReviewPublisher = ({
  getPRHeadShaFn = getPRHeadSha,
  listPRReviewsFn = listPRReviews,
  listPRCommentsFn = listPRComments,
  createPRReviewFn = createPRReview,
  postPRCommentFn = postPRComment,
} = {}) => async ({
  repositoryId,
  repoFullName,
  prNumber,
  commitSha,
  accessToken,
  commentableFindings,
  unanchoredFindings,
}) => {
  const marker = createCodeGuardMarker(repositoryId, prNumber, commitSha);
  const currentHead = await getPRHeadShaFn(repoFullName, prNumber, accessToken);
  if (currentHead !== commitSha) return { status: 'stale' };

  const findExisting = async () => {
    const [reviews, comments] = await Promise.all([
      listPRReviewsFn(repoFullName, prNumber, accessToken),
      listPRCommentsFn(repoFullName, prNumber, accessToken),
    ]);
    return markerExists(marker, commitSha, reviews, comments);
  };

  const existing = await findExisting();
  if (existing) return { status: 'duplicate', ...existing };

  // Existing-review pagination can take time; recheck immediately before the write.
  const headBeforeReview = await getPRHeadShaFn(repoFullName, prNumber, accessToken);
  if (headBeforeReview !== commitSha) return { status: 'stale' };

  const comments = commentableFindings.map((finding) => ({
    path: finding.filePath,
    line: finding.lineNumber,
    side: 'RIGHT',
    body: formatFinding(finding),
  }));
  const payload = {
    commit_id: commitSha,
    event: 'COMMENT',
    body: reviewBody(marker, unanchoredFindings, comments.length),
    comments,
  };

  try {
    const response = await createPRReviewFn(repoFullName, prNumber, accessToken, payload);
    const created = response?.data ?? response;
    return {
      status: 'published',
      id: created?.id,
      url: created?.html_url,
      type: 'review',
      responseStatus: response?.status,
      inlineCount: comments.length,
    };
  } catch (error) {
    if (error?.ambiguous) {
      try {
        const accepted = await findExisting();
        if (accepted) return { status: 'published', ...accepted, inlineCount: comments.length };
      } catch {
        // An ambiguous write with an unavailable lookup must not be repeated.
      }
      return { status: 'uncertain', error };
    }

    if (![403, 422].includes(error?.status)) return { status: 'failed', error };

    // A rejected review may still have been accepted. Check its marker before fallback.
    let accepted;
    try {
      accepted = await findExisting();
    } catch {
      return { status: 'uncertain', error };
    }
    if (accepted) return { status: 'published', ...accepted, inlineCount: comments.length };

    const headBeforeFallback = await getPRHeadShaFn(repoFullName, prNumber, accessToken);
    if (headBeforeFallback !== commitSha) return { status: 'stale' };

    try {
      const fallback = await postPRCommentFn(
        repoFullName,
        prNumber,
        accessToken,
        fallbackBody(marker, [...commentableFindings, ...unanchoredFindings]),
        { includeStatus: true },
      );
      const fallbackData = fallback?.data ?? fallback;
      return {
        status: 'published',
        id: fallbackData?.id,
        url: fallbackData?.html_url,
        type: 'comment',
        responseStatus: fallback?.status,
        inlineCount: 0,
      };
    } catch (fallbackError) {
      if (!fallbackError?.ambiguous) return { status: 'failed', error: fallbackError };
      try {
        const acceptedFallback = await findExisting();
        if (acceptedFallback) return { status: 'published', ...acceptedFallback, inlineCount: 0 };
      } catch {
        // Keep the outcome uncertain; never blindly repeat a potentially accepted comment.
      }
      return { status: 'uncertain', error: fallbackError };
    }
  }
};
