import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, BookMarked, Check, ChevronLeft, ChevronRight, Code2, Copy, GitBranch, GitPullRequest, Info, LayoutDashboard, Loader2, LogOut, BarChart3, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, Settings } from 'lucide-react';
import { FaGithub } from 'react-icons/fa';
import StatusBadge from '../components/StatusBadge.jsx';
import { apiUrl } from '../config/api.js';
import { filterRepositories } from '../utils/filterRepositories.js';
import { pluralize, shortSha, timeAgo } from '../utils/formatters.js';
import { hasActiveReviews } from '../utils/reviews.js';
import { requestGitHubPublicationRetry, requestReviewHistory, requestReviewRetry } from '../utils/reviewHistory.js';
import { canRetryGitHubPublication, getGitHubPublicationPresentation, getGitHubPublicationUrl } from '../utils/githubPublication.js';
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'suggestion'];
const SEVERITY_CHART_COLORS = {
  critical: 'bg-red-400',
  high: 'bg-orange-400',
  medium: 'bg-amber-400',
  low: 'bg-blue-400',
  suggestion: 'bg-slate-400',
  other: 'bg-slate-500',
};
const REVIEW_POLL_INTERVAL_MS = 5000;
const SIDEBAR_REPOSITORIES_PER_PAGE = 12;
const SEVERITY_BADGE_CLASSES = {
  critical: 'border-red-400/25 bg-red-500/10 text-red-300',
  high: 'border-orange-400/25 bg-orange-500/10 text-orange-300',
  medium: 'border-amber-400/25 bg-amber-500/10 text-amber-300',
  low: 'border-blue-400/25 bg-blue-500/10 text-blue-300',
  suggestion: 'border-slate-400/20 bg-slate-500/10 text-slate-300',
};
const DASHBOARD_VIEWS = [{
  id: 'dashboard',
  label: 'Dashboard',
  Icon: LayoutDashboard
}, {
  id: 'pull-requests',
  label: 'Pull Requests',
  Icon: GitPullRequest
}, {
  id: 'repositories',
  label: 'Repositories',
  Icon: BookMarked
}, {
  id: 'analytics',
  label: 'Analytics',
  Icon: BarChart3
}, {
  id: 'settings',
  label: 'Settings',
  Icon: Settings
}];
const GITHUB_APP_CALLBACK_MESSAGES = {
  connected: 'GitHub App connected. Choose an installation repository below to enable reviews.',
  cancelled: 'GitHub App setup was canceled. You can start again whenever you’re ready.',
  invalid_state: 'The GitHub App setup link expired or was already used. Start the connection again.',
  verification_failed: 'GitHub could not verify the installation. Check the App installation and try again.',
  account_mismatch: 'The GitHub App installation belongs to a different GitHub account than your CodeGuard login.',
  already_connected: 'That GitHub App installation is already associated with another CodeGuard account.',
  error: 'GitHub App setup could not be completed. Please try again.'
};
const formatDate = value => {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
};
function RelativeTime({
  value
}) {
  const date = value ? new Date(value) : null;
  const isValid = date && !Number.isNaN(date.getTime());
  return <time dateTime={isValid ? date.toISOString() : undefined} title={isValid ? formatDate(value) : undefined}>      {timeAgo(value)}    </time>;
}
const splitFindingEvidence = explanation => {
  if (typeof explanation !== 'string') return {
    codeExcerpt: '',
    explanation: ''
  };
  const evidenceMatch = explanation.match(/^\s*Evidence:\s*`([\s\S]*?)`\s*—\s*([\s\S]*)$/i);
  if (!evidenceMatch) return {
    codeExcerpt: '',
    explanation
  };
  return {
    codeExcerpt: evidenceMatch[1],
    explanation: evidenceMatch[2].trim()
  };
};
const getFindingTitle = finding => {
  if (typeof finding?.title === 'string' && finding.title.trim()) return finding.title.trim();
  const category = typeof finding?.category === 'string' ? finding.category.trim().replace(/[_-]+/g, ' ') : '';
  const fileName = typeof finding?.filePath === 'string' ? finding.filePath.split(/[\\/]/).filter(Boolean).at(-1) : '';
  if (category && fileName) return `${category} in ${fileName}`;
  if (category) return category;
  if (fileName) return `Finding in ${fileName}`;
  return 'Code finding';
};
const getFindingMatchKey = finding => {
  if (typeof finding?.filePath !== 'string' || !finding.filePath.trim()) return null;
  if (typeof finding?.category !== 'string' || !finding.category.trim()) return null;
  const {
    codeExcerpt
  } = splitFindingEvidence(finding.explanation);
  if (!codeExcerpt.trim()) return null; // Normalize only path separators, leading ./ segments, category casing, and
  // evidence line endings/outer whitespace. Keep evidence text otherwise exact.
  const filePath = finding.filePath.trim().replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
  const category = finding.category.trim().toLocaleLowerCase();
  const evidence = codeExcerpt.replace(/\r\n?/g, '\n').trim();
  return JSON.stringify([filePath, category, evidence]);
};
const compareReviewFindings = (previousReview, latestReview) => {
  const previousFindings = Array.isArray(previousReview?.findings) ? previousReview.findings : [];
  const latestFindings = Array.isArray(latestReview?.findings) ? latestReview.findings : [];
  const previousByKey = new Map();
  const latestByKey = new Map();
  const unmatchedPrevious = [];
  const unmatchedLatest = [];
  const groupByKey = (findings, groups, unmatched, side) => {
    findings.forEach(finding => {
      const key = getFindingMatchKey(finding);
      if (!key) {
        unmatched.push({
          finding,
          side,
          reason: 'Evidence excerpt or match fields are unavailable.'
        });
        return;
      }
      const group = groups.get(key) || [];
      group.push(finding);
      groups.set(key, group);
    });
  };
  groupByKey(previousFindings, previousByKey, unmatchedPrevious, 'previous');
  groupByKey(latestFindings, latestByKey, unmatchedLatest, 'latest');
  const candidateMatches = [];
  const notDetected = [];
  const newlyDetected = [];
  const ambiguousKeys = new Set();
  for (const [key, findings] of previousByKey) {
    const latestMatches = latestByKey.get(key) || [];
    if (findings.length > 1 || latestMatches.length > 1) {
      ambiguousKeys.add(key);
      findings.forEach(finding => unmatchedPrevious.push({
        finding,
        side: 'previous',
        reason: 'Duplicate evidence makes a one-to-one match uncertain.'
      }));
      latestMatches.forEach(finding => unmatchedLatest.push({
        finding,
        side: 'latest',
        reason: 'Duplicate evidence makes a one-to-one match uncertain.'
      }));
      continue;
    }
    if (findings.length === 1 && latestMatches.length === 1) {
      candidateMatches.push({
        previous: findings[0],
        latest: latestMatches[0]
      });
    } else if (findings.length === 1 && latestMatches.length === 0) {
      notDetected.push(findings[0]);
    }
  }
  for (const [key, findings] of latestByKey) {
    if (ambiguousKeys.has(key)) continue;
    if (findings.length > 1) {
      findings.forEach(finding => unmatchedLatest.push({
        finding,
        side: 'latest',
        reason: 'Duplicate evidence makes a one-to-one match uncertain.'
      }));
    } else if (findings.length === 1 && !previousByKey.has(key)) {
      newlyDetected.push(findings[0]);
    }
  }
  return {
    candidateMatches,
    notDetected,
    newlyDetected,
    unmatchedPrevious,
    unmatchedLatest
  };
};
const getReviewFindings = review => Array.isArray(review?.findings) ? review.findings : [];
const getReviewFindingSummary = review => {
  const findingCount = getReviewFindings(review).length;
  if (review?.status === 'failed' || review?.status === 'stale') return 'Findings unavailable';
  if (review?.status === 'queued' || review?.status === 'processing') {
    return findingCount ? pluralize(findingCount, 'finding') : 'Findings pending';
  }
  if (review?.status === 'completed' && findingCount === 0) return 'No findings';
  return pluralize(findingCount, 'finding');
};
const normalizeFilePath = filePath => typeof filePath === 'string' ? filePath.trim().replaceAll('\\', '/').replace(/^(?:\.\/)+/, '') : '';
const getActivityBucketStart = (value, bucketSize) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (bucketSize === 'week') {
    start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  } else if (bucketSize === 'month') {
    start.setDate(1);
  }
  return start;
};
const getActivityBucketKey = (date, bucketSize) => bucketSize === 'month' ? `${date.getFullYear()}-${date.getMonth()}` : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
const getActivityBucketLabel = (date, bucketSize) => {
  if (bucketSize === 'month') {
    return date.toLocaleDateString(undefined, {
      month: 'short',
      year: 'numeric'
    });
  }
  const label = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  });
  return bucketSize === 'week' ? `Week of ${label}` : label;
};
const buildReviewActivity = reviews => {
  const datedReviews = reviews.flatMap(review => {
    if (review?.createdAt === null || review?.createdAt === undefined || review.createdAt === '') return [];
    const date = new Date(review?.createdAt);
    return Number.isNaN(date.getTime()) ? [] : [{ date }];
  }).sort((left, right) => left.date - right.date);
  if (datedReviews.length === 0) return { buckets: [] };
  const firstDate = getActivityBucketStart(datedReviews[0].date, 'day');
  const lastDate = getActivityBucketStart(datedReviews.at(-1).date, 'day');
  const daySpan = Math.round((lastDate - firstDate) / 86_400_000) + 1;
  const bucketSize = daySpan <= 21 ? 'day' : daySpan <= 84 ? 'week' : 'month';
  const firstBucket = getActivityBucketStart(datedReviews[0].date, bucketSize);
  const lastBucket = getActivityBucketStart(datedReviews.at(-1).date, bucketSize);
  const countsByKey = new Map();
  datedReviews.forEach(({ date }) => {
    const bucketStart = getActivityBucketStart(date, bucketSize);
    const key = getActivityBucketKey(bucketStart, bucketSize);
    countsByKey.set(key, (countsByKey.get(key) || 0) + 1);
  });
  const buckets = [];
  const cursor = new Date(firstBucket);
  while (cursor <= lastBucket) {
    const key = getActivityBucketKey(cursor, bucketSize);
    buckets.push({ key, label: getActivityBucketLabel(cursor, bucketSize), count: countsByKey.get(key) || 0 });
    if (bucketSize === 'day') cursor.setDate(cursor.getDate() + 1);
    else if (bucketSize === 'week') cursor.setDate(cursor.getDate() + 7);
    else cursor.setMonth(cursor.getMonth() + 1);
  }
  return { buckets };
};const calculateReviewAnalytics = reviews => {
  const safeReviews = Array.isArray(reviews) ? reviews : [];
  const completedReviews = safeReviews.filter(review => review.status === 'completed');
  const failedReviewCount = safeReviews.filter(review => review.status === 'failed').length;
  const completedFindings = completedReviews.flatMap(getReviewFindings);
  const severityCounts = Object.fromEntries([...SEVERITY_ORDER, 'other'].map(severity => [severity, 0]));
  const categoriesByName = new Map();
  const filesByPath = new Map();
  completedReviews.forEach((review, reviewIndex) => {
    const reviewKey = String(review?._id ?? reviewIndex);
    getReviewFindings(review).forEach(finding => {
      const severity = SEVERITY_ORDER.includes(finding?.severity) ? finding.severity : 'other';
      severityCounts[severity] += 1;
      const category = typeof finding?.category === 'string' && finding.category.trim()
        ? finding.category.trim().replace(/[_-]+/g, ' ')
        : 'Uncategorized';
      const categoryKey = category.toLocaleLowerCase();
      const categoryStats = categoriesByName.get(categoryKey) || { label: category, count: 0 };
      categoryStats.count += 1;
      categoriesByName.set(categoryKey, categoryStats);
      const filePath = normalizeFilePath(finding?.filePath);
      if (!filePath) return;
      const fileStats = filesByPath.get(filePath) || { filePath, findingCount: 0, reviewIds: new Set() };
      fileStats.findingCount += 1;
      fileStats.reviewIds.add(reviewKey);
      filesByPath.set(filePath, fileStats);
    });
  });
  const completedFindingCount = completedFindings.length;
  const terminalReviewCount = completedReviews.length + failedReviewCount;
  const files = [...filesByPath.values()].map(({ reviewIds, ...fileStats }) => ({
    ...fileStats,
    revisionCount: reviewIds.size
  })).sort((left, right) => right.findingCount - left.findingCount || right.revisionCount - left.revisionCount || left.filePath.localeCompare(right.filePath));
  const reviewsByPullRequest = new Map();
  safeReviews.forEach(review => {
    if (review?.prNumber === undefined || review?.prNumber === null) return;
    const key = String(review.prNumber);
    const revisions = reviewsByPullRequest.get(key) || [];
    revisions.push(review);
    reviewsByPullRequest.set(key, revisions);
  });
  const latestCompletedReviews = [...reviewsByPullRequest.values()].flatMap(revisions => {
    const completedRevisions = revisions.filter(review => review.status === 'completed');
    if (completedRevisions.length === 0) return [];
    return [completedRevisions.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()).at(-1)];
  });
  const repositoryInsights = [...reviewsByPullRequest.entries()].map(([prNumber, revisions]) => {
    const orderedRevisions = [...revisions].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    const completedRevisions = revisions.filter(review => review.status === 'completed');
    return {
      prNumber,
      revisionCount: revisions.length,
      latestStatus: orderedRevisions.at(-1)?.status || 'unknown',
      findingOccurrenceCount: completedRevisions.reduce((count, review) => count + getReviewFindings(review).length, 0)
    };
  }).sort((left, right) => right.findingOccurrenceCount - left.findingOccurrenceCount || right.revisionCount - left.revisionCount || String(right.prNumber).localeCompare(String(left.prNumber), undefined, { numeric: true }));
  return {
    totalReviewRevisions: safeReviews.length,
    uniquePullRequestCount: reviewsByPullRequest.size,
    completedReviewCount: completedReviews.length,
    failedReviewCount,
    completedFindingCount,
    averageFindingsPerPullRequest: latestCompletedReviews.length
      ? latestCompletedReviews.reduce((count, review) => count + getReviewFindings(review).length, 0) / latestCompletedReviews.length
      : null,
    terminalSuccessRate: terminalReviewCount ? completedReviews.length / terminalReviewCount * 100 : null,
    severityCounts,
    categories: [...categoriesByName.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    files,
    repositoryInsights,
    activity: buildReviewActivity(safeReviews)
  };
};function AnalyticsDistribution({
  title,
  items,
  emptyMessage,
  caption,
  colorByLabel = {}
}) {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  return <section className="min-w-0 rounded-lg border border-cg-border bg-cg-surface/40 p-4 sm:p-5" aria-label={title}>
    <h2 className="text-[17px] font-semibold text-cg-primary">{title}</h2>
    {caption && <p className="mt-1 text-[13px] text-cg-muted">{caption}</p>}
    {total === 0 ? <p className="mt-4 text-sm text-cg-muted">{emptyMessage}</p> : <div className="mt-4 space-y-3">
      {items.filter(item => item.count > 0).map(item => {
        const percent = Math.round(item.count / total * 100);
        return <div key={item.label}>
          <div className="mb-1.5 flex justify-between gap-3 text-[13px]">
            <span className="truncate font-medium text-cg-primary">{item.label}</span>
            <span className="shrink-0 tabular-nums text-cg-muted">{item.count} · {percent}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-cg-raised" role="meter" aria-label={`${item.label} findings`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent}>
            <div className={`h-full rounded-full ${colorByLabel[item.label] || 'bg-cg-accent'}`} style={{ width: `${percent}%` }} />
          </div>
        </div>;
      })}
    </div>}
  </section>;
}
function ReviewActivityChart({ activity }) {
  const buckets = activity.buckets;
  const maxCount = Math.max(1, ...buckets.map(bucket => bucket.count));
  const bucketSpacing = Math.max(62, ...buckets.map(bucket => Math.min(104, bucket.label.length * 6 + 24)));
  const chartWidth = Math.max(640, buckets.length * bucketSpacing + 64);
  const chartHeight = 260;
  const left = 46;
  const right = chartWidth - 18;
  const top = 22;
  const bottom = 218;
  const xFor = index => buckets.length === 1 ? (left + right) / 2 : left + index / (buckets.length - 1) * (right - left);
  const yFor = count => bottom - count / maxCount * (bottom - top);
  const points = buckets.map((bucket, index) => `${xFor(index)},${yFor(bucket.count)}`).join(' ');
  const yTicks = [...new Set([0, Math.ceil(maxCount / 3), Math.ceil(maxCount * 2 / 3), maxCount])].sort((a, b) => a - b);
  return <section className="rounded-lg border border-cg-border bg-cg-surface/40 p-4 sm:p-5" aria-label="Review activity">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-[17px] font-semibold text-cg-primary">Review activity</h2>
      <span className="text-[13px] text-cg-muted">Review records created</span>
    </div>
    {buckets.length === 0 ? <p className="mt-4 text-sm text-cg-muted">No review activity to chart yet.</p> : <div className="mt-4 overflow-x-auto">
      <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" role="img" aria-label={`Review records created over time, ${buckets.length} date buckets`} className="h-[260px] w-full" style={{ minWidth: `${chartWidth}px` }}>
        {yTicks.map(tick => {
          const y = yFor(tick);
          return <g key={tick}>
            <line x1={left} x2={right} y1={y} y2={y} stroke="#334155" strokeOpacity="0.7" />
            <text x={left - 10} y={y + 4} textAnchor="end" fill="#94a3b8" fontSize="12">{tick}</text>
          </g>;
        })}
        <line x1={left} x2={right} y1={bottom} y2={bottom} stroke="#475569" />
        {buckets.length > 1 && <polyline points={points} fill="none" stroke="#60a5fa" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />}
        {buckets.map((bucket, index) => <g key={bucket.key}>
          <title>{`${bucket.label}: ${bucket.count} review records created`}</title>
          <circle cx={xFor(index)} cy={yFor(bucket.count)} r="5" fill="#0f172a" stroke="#60a5fa" strokeWidth="3" />
          <text x={xFor(index)} y={Math.max(14, yFor(bucket.count) - 12)} textAnchor="middle" fill="#e2e8f0" fontSize="12" fontWeight="600">{bucket.count}</text>
          <text x={xFor(index)} y={chartHeight - 14} textAnchor="middle" fill="#cbd5e1" fontSize="12">{bucket.label}</text>
        </g>)}
      </svg>
    </div>}
  </section>;
}
function RepositoryInsights({ items }) {
  return <section className="min-w-0" aria-label="Repository insights by pull request">
    <h2 className="text-[17px] font-semibold text-cg-primary">Repository insights</h2>
    <p className="mt-1 text-[13px] text-cg-muted">Pull requests in the selected repository</p>
    {items.length === 0 ? <p className="mt-4 text-sm text-cg-muted">No pull request review data yet.</p> : <ul className="mt-3 divide-y divide-cg-border border-y border-cg-border">
      {items.slice(0, 8).map(item => <li key={String(item.prNumber)} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 text-[13px] font-medium text-cg-primary">PR #{item.prNumber}</span>
          <span className="text-[13px] text-cg-muted">{pluralize(item.revisionCount, 'revision')}</span>
        </div>
        <div className="flex items-center gap-3 text-[13px]">
          <span className="capitalize text-cg-muted">{item.latestStatus}</span>
          <span className="tabular-nums text-cg-primary">{pluralize(item.findingOccurrenceCount, 'finding occurrence')}</span>
        </div>
      </li>)}
    </ul>}
  </section>;
}
function FrequentlyFlaggedFiles({ files }) {
  return <section className="min-w-0 rounded-lg border border-cg-border bg-cg-surface/40 p-4 sm:p-5" aria-label="Frequently flagged files">
    <h2 className="text-[17px] font-semibold text-cg-primary">Most-flagged files</h2>
    {files.length === 0 ? <p className="mt-4 text-sm text-cg-muted">No completed findings with a file path.</p> : <ul className="mt-3 divide-y divide-cg-border">
      {files.slice(0, 8).map(file => <li key={file.filePath} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
        <span className="min-w-0 flex-1 break-all font-mono text-[13px] text-cg-primary">{file.filePath}</span>
        <span className="shrink-0 text-right text-[13px] text-cg-muted">{pluralize(file.findingCount, 'finding occurrence')} · {pluralize(file.revisionCount, 'review revision')}</span>
      </li>)}
    </ul>}
  </section>;
}
function ComparisonFinding({ finding, review, label, onOpenReview }) {
  const { codeExcerpt, explanation } = splitFindingEvidence(finding.explanation);
  return <details className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
    <summary className="cursor-pointer list-none text-xs text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
      <span className="mr-2 text-[10px] font-semibold text-violet-300">{label}</span>
      <span className="break-all font-mono">{finding.filePath || 'File unavailable'}{finding.lineNumber ? `:${finding.lineNumber}` : ''}</span>
      {finding.severity && <span className="ml-2 text-cg-muted">{finding.severity}</span>}
    </summary>
    <div className="mt-3 space-y-3 border-t border-slate-800 pt-3">
      {codeExcerpt && <div>
        <p className="text-[10px] font-semibold text-cg-muted">Evidence</p>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-slate-900 p-2 font-mono text-xs text-slate-300">{codeExcerpt}</pre>
      </div>}
      {explanation && <p className="text-xs leading-relaxed text-slate-400">{explanation}</p>}
      {typeof finding.suggestedFix === 'string' && finding.suggestedFix.trim() && finding.suggestedFix !== 'N/A' && <div>
        <p className="text-[10px] font-semibold text-emerald-300">AI fix guidance</p>
        <p className="mt-1 whitespace-pre-wrap text-xs text-emerald-100">{finding.suggestedFix}</p>
      </div>}
      <button type="button" onClick={() => onOpenReview(review)} className="rounded-md border border-violet-400/20 bg-violet-500/10 px-2.5 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-500/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">Open original review</button>
    </div>
  </details>;
}
function RevisionComparison({
  revisions,
  onOpenReview
}) {
  const completedRevisions = revisions.filter(review => review.status === 'completed');
  if (completedRevisions.length < 2) return null;
  const [previous, latest] = completedRevisions.slice(-2);
  const comparison = compareReviewFindings(previous, latest);
  const previousCount = Array.isArray(previous.findings) ? previous.findings.length : 0;
  const latestCount = Array.isArray(latest.findings) ? latest.findings.length : 0;
  const ambiguousPrevious = comparison.unmatchedPrevious.filter(entry => entry.reason.startsWith('Duplicate'));
  const ambiguousLatest = comparison.unmatchedLatest.filter(entry => entry.reason.startsWith('Duplicate'));
  const evidenceMissingPrevious = comparison.unmatchedPrevious.filter(entry => !entry.reason.startsWith('Duplicate'));
  const evidenceMissingLatest = comparison.unmatchedLatest.filter(entry => !entry.reason.startsWith('Duplicate'));
  return <section className="mt-4 rounded-xl border border-violet-400/15 bg-slate-950/50 p-3 sm:p-4" aria-label="Review revision comparison">      <div className="flex flex-wrap items-start justify-between gap-3">        <div><h3 className="text-sm font-semibold text-white">Latest completed revision comparison</h3><p className="mt-1 text-[11px] text-cg-muted">Heuristic comparison of saved findings. Matches are candidates, not confirmed issue identities.</p></div>        <div className="text-right text-[11px] text-slate-400"><p>Previous: <span className="font-mono text-slate-300" title={previous.commitSha || undefined}>{previous.commitSha ? shortSha(previous.commitSha) : 'SHA unavailable'}</span> · {pluralize(previousCount, 'finding')}</p><p className="mt-1">Latest: <span className="font-mono text-slate-300" title={latest.commitSha || undefined}>{latest.commitSha ? shortSha(latest.commitSha) : 'SHA unavailable'}</span> · {pluralize(latestCount, 'finding')}</p></div>      </div>      <p className="mt-3 rounded-lg border border-amber-400/10 bg-amber-400/[0.03] p-2.5 text-[11px] leading-relaxed text-amber-100/80">A finding absent from the latest review is only “not detected”; its absence does not prove the issue was fixed. Failed and in-progress revisions are excluded from this comparison.</p>      {previousCount === 0 && latestCount === 0 ? <p className="mt-3 text-xs text-cg-muted">Both completed revisions contain zero saved findings.</p> : <div className="mt-4 space-y-4">          <ComparisonGroup title="Candidate matches" count={comparison.candidateMatches.length}>            {comparison.candidateMatches.map((match, index) => <div key={`match-${index}`} className="space-y-2 rounded-lg border border-emerald-400/10 bg-emerald-400/[0.025] p-2.5"><p className="text-[10px] font-semibold   text-emerald-300">Candidate match</p><ComparisonFinding finding={match.previous} review={previous} label="Previous" onOpenReview={onOpenReview} /><ComparisonFinding finding={match.latest} review={latest} label="Latest" onOpenReview={onOpenReview} /></div>)}          </ComparisonGroup>          <ComparisonGroup title="Not detected in latest review" count={comparison.notDetected.length}>            {comparison.notDetected.map((finding, index) => <ComparisonFinding key={`previous-${index}`} finding={finding} review={previous} label="Previous" onOpenReview={onOpenReview} />)}          </ComparisonGroup>          <ComparisonGroup title="Newly detected" count={comparison.newlyDetected.length}>            {comparison.newlyDetected.map((finding, index) => <ComparisonFinding key={`latest-${index}`} finding={finding} review={latest} label="Latest" onOpenReview={onOpenReview} />)}          </ComparisonGroup>          {ambiguousPrevious.length + ambiguousLatest.length + evidenceMissingPrevious.length + evidenceMissingLatest.length > 0 && <ComparisonGroup title="Unmatched — insufficient evidence for a reliable candidate" count={ambiguousPrevious.length + ambiguousLatest.length + evidenceMissingPrevious.length + evidenceMissingLatest.length}>              <p className="mb-2 text-[11px] leading-relaxed text-cg-muted">Duplicate-looking evidence and findings without a usable evidence excerpt are left unmatched rather than guessed into another category.</p>              {[...comparison.unmatchedPrevious, ...comparison.unmatchedLatest].map((entry, index) => <div key={`unmatched-${entry.side}-${index}`}><p className="mb-1 text-[10px] text-amber-200/80">{entry.side === 'previous' ? 'Previous' : 'Latest'} · {entry.reason}</p><ComparisonFinding finding={entry.finding} review={entry.side === 'previous' ? previous : latest} label={entry.side === 'previous' ? 'Previous' : 'Latest'} onOpenReview={onOpenReview} /></div>)}            </ComparisonGroup>}        </div>}    </section>;
}
function ComparisonGroup({
  title,
  count,
  children
}) {
  return <section><div className="mb-2 flex items-center justify-between gap-2"><h4 className="text-xs font-semibold text-slate-200">{title}</h4><span className="rounded-full border border-slate-800 px-2 py-0.5 text-[10px] tabular-nums text-cg-muted">{count}</span></div>{count === 0 ? <p className="text-[11px] text-cg-muted">None</p> : <div className="space-y-2">{children}</div>}</section>;
}
const inferLanguageFromPath = (filePath) => {
  if (typeof filePath !== 'string') return 'javascript';
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'py':
      return 'python';
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
      return 'css';
    case 'json':
      return 'json';
    case 'sql':
      return 'sql';
    case 'sh':
    case 'bash':
      return 'bash';
    default:
      return 'javascript';
  }
};

const tokenizeCodeLine = (line) => {
  const tokenRegex = /(\/\/[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:function|return|const|let|var|if|else|for|while|import|export|from|default|class|extends|new|async|await|try|catch|finally|throw|typeof|instanceof|def|elif|pass|in|is|not)\b)|(\b(?:document|window|console|JSON|Math|Promise|Array|Object|String|Number|Boolean|null|undefined|true|false)\b)|(\b[a-zA-Z_$][\w$]*(?=\s*\())|(\b\d+(?:\.\d+)?\b)|([\]{}(),;=+\-*/<>!&|.:[]+)|([^\s\]{}(),;=+\-*/<>!&|.:["]+)/g;

  let match;
  let lastIndex = 0;
  const tokens = [];

  while ((match = tokenRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'whitespace', text: line.slice(lastIndex, match.index) });
    }
    const [, comment, str, kw, builtin, fn, num, punct, ident] = match;
    if (comment) tokens.push({ type: 'comment', text: comment });
    else if (str) tokens.push({ type: 'string', text: str });
    else if (kw) tokens.push({ type: 'keyword', text: kw });
    else if (builtin) tokens.push({ type: 'builtin', text: builtin });
    else if (fn) tokens.push({ type: 'function', text: fn });
    else if (num) tokens.push({ type: 'number', text: num });
    else if (punct) tokens.push({ type: 'punctuation', text: punct });
    else if (ident) tokens.push({ type: 'identifier', text: ident });
    lastIndex = tokenRegex.lastIndex;
  }
  if (lastIndex < line.length) {
    tokens.push({ type: 'whitespace', text: line.slice(lastIndex) });
  }
  return tokens;
};

const deriveCorrectedCode = (finding) => {
  const suggestedFix = typeof finding?.suggestedFix === 'string' ? finding.suggestedFix.trim() : '';
  if (!suggestedFix || suggestedFix === 'N/A') return null;

  const language = inferLanguageFromPath(finding?.filePath);

  // 1. Check for fenced code block: ```[lang]\n[code]\n```
  const fencedMatch = suggestedFix.match(/```([\w+#.-]*)\s*\r?\n([\s\S]*?)\r?\n```/);
  if (fencedMatch) {
    const code = fencedMatch[2].trimEnd();
    const explanation = suggestedFix.replace(fencedMatch[0], '').trim();
    return {
      code,
      language: fencedMatch[1] || language,
      explanation: explanation || null,
    };
  }

  // 2. Check for explicit code snippet after "For example:" or "Example:" or in backticks
  const exampleMatch = suggestedFix.match(/(?:for\s+example|example|e\.g\.?)\s*[:,]?\s*[`"']?([\s\S]+?)[`"']?\s*$/i);
  const backtickCodeMatch = suggestedFix.match(/`([^`\n]{8,})`/);

  // 3. Extract evidence and diff context
  const { codeExcerpt } = splitFindingEvidence(finding?.explanation);
  const diffLines = Array.isArray(finding?.diffContext) ? finding.diffContext : [];
  const targetIndex = diffLines.findIndex(
    (l) => l.isTarget || (Number.isInteger(finding?.lineNumber) && l.newLineNumber === finding.lineNumber && l.lineType === 'added')
  );
  const targetLine = targetIndex >= 0 ? diffLines[targetIndex] : null;
  const targetCode = targetLine ? targetLine.code : (codeExcerpt || '');

  // 4. Derive replacement for targetCode
  let replacedTargetCode = null;

  if (/\b(?:textContent|sanitize)\b/i.test(suggestedFix) && /\.innerHTML\b/.test(targetCode)) {
    replacedTargetCode = targetCode.replace(/\.innerHTML\b/g, '.textContent');
  } else if (/\bstrict\s+equality\b|\b===\b/i.test(suggestedFix) && /\s==\s/.test(targetCode)) {
    replacedTargetCode = targetCode.replace(/\s==\s/g, ' === ');
  } else if (/\bstrict\s+inequality\b|\b!==\b/i.test(suggestedFix) && /\s!=\s/.test(targetCode)) {
    replacedTargetCode = targetCode.replace(/\s!=\s/g, ' !== ');
  } else if (/\bJSON\.parse\b/i.test(suggestedFix) && /\beval\s*\(/.test(targetCode)) {
    replacedTargetCode = targetCode.replace(/\beval\s*\(/g, 'JSON.parse(');
  } else if (exampleMatch && exampleMatch[1].trim()) {
    const rawExample = exampleMatch[1].trim().replace(/^`|`$/g, '');
    if (rawExample.includes(';') || rawExample.includes('=') || rawExample.includes('(')) {
      replacedTargetCode = rawExample;
    }
  } else if (backtickCodeMatch && backtickCodeMatch[1].trim()) {
    const rawExample = backtickCodeMatch[1].trim();
    if (rawExample.includes(';') || rawExample.includes('=') || rawExample.includes('(')) {
      replacedTargetCode = rawExample;
    }
  }

  // 5. If we have a replaced line and diffLines has enclosing block (e.g. function):
  if (replacedTargetCode !== null && targetIndex >= 0) {
    let blockStart = targetIndex;
    for (let i = targetIndex - 1; i >= 0; i--) {
      const c = diffLines[i].code.trim();
      if (/^(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/.test(c)) {
        blockStart = i;
        break;
      }
    }
    let blockEnd = targetIndex;
    for (let i = targetIndex + 1; i < diffLines.length; i++) {
      const c = diffLines[i].code.trim();
      if (c === '}' || c === '};') {
        blockEnd = i;
        break;
      }
    }

    if (blockStart < targetIndex && blockEnd > targetIndex) {
      const lines = [];
      for (let i = blockStart; i <= blockEnd; i++) {
        if (i === targetIndex) {
          lines.push(`    ${replacedTargetCode.trim()}`);
        } else {
          lines.push(diffLines[i].code);
        }
      }
      return {
        code: lines.join('\n'),
        language,
        explanation: suggestedFix,
      };
    }

    return {
      code: replacedTargetCode.trim(),
      language,
      explanation: suggestedFix,
    };
  }

  if (replacedTargetCode !== null) {
    return {
      code: replacedTargetCode.trim(),
      language,
      explanation: suggestedFix,
    };
  }

  // Do not invent code when there is not enough information
  return {
    code: null,
    language,
    explanation: suggestedFix,
  };
};

function SyntaxHighlightedCode({ code }) {
  const lines = typeof code === 'string' ? code.split('\n') : [];
  return (
    <pre className="overflow-x-auto whitespace-pre font-mono text-xs leading-6 text-slate-200">
      <code>
        {lines.map((line, lineIdx) => {
          const tokens = tokenizeCodeLine(line);
          return (
            <div key={lineIdx} className="min-h-[1.5rem]">
              {tokens.length === 0 ? '\u00A0' : tokens.map((token, tokenIdx) => {
                let tokenClass = 'text-slate-200';
                if (token.type === 'keyword') tokenClass = 'text-purple-400 font-medium';
                else if (token.type === 'builtin') tokenClass = 'text-amber-300';
                else if (token.type === 'function') tokenClass = 'text-blue-300';
                else if (token.type === 'string') tokenClass = 'text-emerald-300';
                else if (token.type === 'number') tokenClass = 'text-orange-300';
                else if (token.type === 'comment') tokenClass = 'text-slate-500 italic';
                else if (token.type === 'punctuation') tokenClass = 'text-slate-400';
                else if (token.type === 'identifier') tokenClass = 'text-sky-200';
                return (
                  <span key={tokenIdx} className={tokenClass}>
                    {token.text}
                  </span>
                );
              })}
            </div>
          );
        })}
      </code>
    </pre>
  );
}

function SuggestedFixGuidance({
  finding,
  suggestedFix: directSuggestedFix
}) {
  const suggestedFix = typeof directSuggestedFix === 'string' ? directSuggestedFix : (finding?.suggestedFix || '');
  const [copyStatus, setCopyStatus] = useState('');

  useEffect(() => {
    if (!copyStatus) return undefined;
    const timeout = window.setTimeout(() => setCopyStatus(''), 2200);
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);

  if (typeof suggestedFix !== 'string' || !suggestedFix.trim() || suggestedFix === 'N/A') {
    return null;
  }

  const fixInfo = deriveCorrectedCode({ ...finding, suggestedFix });

  const copyFix = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard access is unavailable.');
      }
      const textToCopy = fixInfo?.code || suggestedFix;
      await navigator.clipboard.writeText(textToCopy);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  };

  if (!fixInfo || !fixInfo.code) {
    return (
      <section className="overflow-hidden rounded-lg border border-cg-border bg-cg-surface/40" aria-label="Suggested fix">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cg-border bg-cg-surface px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="text-sm font-semibold text-cg-primary">Suggested Fix</h3>
          </div>
          <button
            type="button"
            onClick={copyFix}
            className="inline-flex items-center gap-1.5 rounded-md border border-cg-border bg-cg-raised px-2.5 py-1.5 text-[11px] font-medium text-cg-primary transition hover:bg-cg-border/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            {copyStatus === 'copied' ? <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
            {copyStatus === 'copied' ? 'Copied' : 'Copy guidance'}
          </button>
        </div>
        <div className="px-3 py-3">
          <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-cg-primary">{suggestedFix}</p>
        </div>
        {copyStatus === 'copied' && (
          <p className="border-t border-cg-border px-3 py-2 text-xs text-emerald-400" role="status" aria-live="polite">
            Guidance copied to clipboard.
          </p>
        )}
        {copyStatus === 'error' && (
          <p className="border-t border-red-400/20 px-3 py-2 text-xs text-red-300" role="alert">
            Could not copy guidance. Check your browser clipboard permissions.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-lg border border-emerald-400/25 bg-emerald-500/[0.035]" aria-label="Suggested fix">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-400/15 bg-emerald-500/[0.05] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="text-sm font-semibold text-emerald-200">Suggested Fix</h3>
          {fixInfo.language && (
            <span className="rounded bg-emerald-400/10 px-2 py-0.5 font-mono text-[10px] uppercase text-emerald-200/90 border border-emerald-400/20">
              {fixInfo.language}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={copyFix}
          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/25 bg-emerald-400/[0.08] px-2.5 py-1.5 text-[11px] font-medium text-emerald-200 transition hover:bg-emerald-400/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
        >
          {copyStatus === 'copied' ? <Check className="h-3 w-3 text-emerald-300" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
          {copyStatus === 'copied' ? 'Copied' : 'Copy Fix'}
        </button>
      </div>

      <div className="bg-slate-950/85 p-3 font-mono text-xs leading-6 overflow-x-auto">
        <SyntaxHighlightedCode code={fixInfo.code} />
      </div>

      {fixInfo.explanation && (
        <div className="border-t border-emerald-400/15 bg-emerald-500/[0.02] px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300/80">Explanation</p>
          <p className="mt-0.5 text-xs leading-relaxed text-emerald-100/90 whitespace-pre-wrap">{fixInfo.explanation}</p>
        </div>
      )}

      {copyStatus === 'copied' && (
        <p className="border-t border-emerald-400/10 px-3 py-2 text-xs text-emerald-300" role="status" aria-live="polite">
          Corrected code copied to clipboard.
        </p>
      )}
      {copyStatus === 'error' && (
        <p className="border-t border-red-400/10 px-3 py-2 text-xs text-red-300" role="alert">
          Could not copy fix. Check your browser clipboard permissions and try again.
        </p>
      )}
    </section>
  );
}

function ReviewDiffContext({ finding }) {
  const lines = Array.isArray(finding?.diffContext) ? finding.diffContext : [];
  if (!lines.length) return null;

  const hasExplicitTarget = lines.some((line) => Boolean(line.isTarget));
  const targetLineNumber = Number.isInteger(finding?.lineNumber)
    ? finding.lineNumber
    : lines.find((l) => l.isTarget)?.newLineNumber;

  return <section className="min-w-0 rounded-lg border border-cg-border" aria-label="Pull request diff context">
    <div className="border-b border-cg-border bg-cg-surface px-3 py-2">
      <h3 className="text-sm font-semibold text-cg-primary">Code Diff</h3>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cg-border/80 bg-cg-raised/50 px-3 py-2">
      <p className="truncate font-mono text-xs text-cg-primary" title={finding.filePath}>
        {finding.filePath}{Number.isInteger(targetLineNumber) ? `:${targetLineNumber}` : ''}
      </p>
      {lines.some((line) => line.isTarget || line.newLineNumber === targetLineNumber) ? (
        <span className="inline-flex items-center gap-1.5 rounded border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-300">
          <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
          Line {targetLineNumber} flagged
        </span>
      ) : (
        <span className="text-[11px] text-cg-muted">No validated changed-line location</span>
      )}
    </div>
    <div className="overflow-x-auto bg-cg-background">
      <div className="min-w-[560px] py-1 font-mono text-xs leading-6">
        <div className="grid grid-cols-[3.5rem_3.5rem_1.5rem_minmax(0,1fr)] border-b border-cg-border bg-cg-surface text-[10px] leading-5 text-cg-muted">
          <span className="border-r border-cg-border/70 px-2 text-right">Old</span>
          <span className="border-r border-cg-border/70 px-2 text-right">New</span>
          <span />
          <span className="px-2">Diff</span>
        </div>
        {lines.map((line, index) => {
          const added = line.lineType === 'added';
          const removed = line.lineType === 'removed';
          const isVulnerable = Boolean(
            line.isTarget ||
            (!hasExplicitTarget &&
              Number.isInteger(targetLineNumber) &&
              line.newLineNumber === targetLineNumber &&
              line.lineType !== 'removed')
          );
          const lineStyle = isVulnerable
            ? 'border-l-[3px] border-red-500 bg-red-500/15 text-red-50 font-medium'
            : added
              ? 'border-l-2 border-emerald-400/60 bg-emerald-500/[0.08] text-emerald-100'
              : removed
                ? 'border-l-2 border-red-400/50 bg-red-500/[0.08] text-red-100'
                : 'border-l-2 border-transparent text-cg-primary';
          const prefix = added ? '+' : removed ? '−' : ' ';
          return (
            <div
              key={`${line.lineType}-${line.oldLineNumber ?? 'x'}-${line.newLineNumber ?? 'x'}-${index}`}
              className={`grid grid-cols-[3.5rem_3.5rem_1.5rem_minmax(0,1fr)] ${lineStyle}`}
              aria-label={isVulnerable ? `Vulnerable code at line ${line.newLineNumber ?? ''}` : undefined}
            >
              <span className={`select-none border-r border-cg-border/70 px-2 text-right ${isVulnerable ? 'text-red-300 font-medium' : 'text-cg-muted'}`}>
                {line.oldLineNumber ?? ''}
              </span>
              <span className={`select-none border-r border-cg-border/70 px-2 text-right ${isVulnerable ? 'text-red-300 font-medium' : 'text-cg-muted'}`}>
                {line.newLineNumber ?? ''}
              </span>
              <span className={`select-none text-center ${isVulnerable ? 'font-bold text-red-400' : 'text-cg-muted'}`}>
                {prefix}
              </span>
              <code className={`overflow-x-visible whitespace-pre px-2 ${isVulnerable ? 'text-red-100 font-semibold' : ''}`}>
                {tokenizeCodeLine(line.code).map((token, tokenIdx) => {
                  let tokenClass = isVulnerable ? 'text-red-100' : 'text-cg-primary';
                  if (!isVulnerable) {
                    if (token.type === 'keyword') tokenClass = 'text-purple-400 font-medium';
                    else if (token.type === 'builtin') tokenClass = 'text-amber-300';
                    else if (token.type === 'function') tokenClass = 'text-blue-300';
                    else if (token.type === 'string') tokenClass = added ? 'text-emerald-200' : 'text-emerald-300';
                    else if (token.type === 'number') tokenClass = 'text-orange-300';
                    else if (token.type === 'comment') tokenClass = 'text-slate-500 italic';
                    else if (token.type === 'punctuation') tokenClass = 'text-slate-400';
                    else if (token.type === 'identifier') tokenClass = 'text-sky-200';
                  } else {
                    if (token.type === 'keyword') tokenClass = 'text-purple-200 font-semibold';
                    else if (token.type === 'builtin') tokenClass = 'text-amber-200 font-semibold';
                    else if (token.type === 'function') tokenClass = 'text-blue-200 font-semibold';
                    else if (token.type === 'string') tokenClass = 'text-emerald-200';
                    else if (token.type === 'punctuation') tokenClass = 'text-red-300/80';
                    else if (token.type === 'identifier') tokenClass = 'text-red-50 font-bold';
                  }
                  return <span key={tokenIdx} className={tokenClass}>{token.text}</span>;
                })}
                {line.truncated ? <span className="ml-2 text-cg-muted">… line truncated</span> : null}
              </code>
            </div>
          );
        })}
      </div>
    </div>
  </section>;
}

function ReviewFindingDetails({ finding }) {
  const evidence = splitFindingEvidence(finding.explanation);
  const hasDiffContext = Array.isArray(finding.diffContext) && finding.diffContext.length > 0;

  return <div className="min-w-0 space-y-5">
    {hasDiffContext
      ? <ReviewDiffContext finding={finding} />
      : evidence.codeExcerpt && <section className="min-w-0 rounded-lg border border-red-500/30 overflow-hidden" aria-label="Code evidence">
        <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-red-200">Flagged Evidence</h3>
          {finding.filePath && <span className="font-mono text-[11px] text-red-300/80">{finding.filePath}{finding.lineNumber ? `:${finding.lineNumber}` : ''}</span>}
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words border-l-[3px] border-red-500 bg-red-500/[0.08] px-3 py-2.5 font-mono text-xs leading-relaxed text-red-100"><code>{evidence.codeExcerpt}</code></pre>
      </section>}
    <section className="overflow-hidden rounded-lg border border-cg-border bg-cg-raised/45" aria-label="Why this finding matters">
      <div className="flex items-center gap-2 border-b border-cg-border px-3 py-2.5">
        <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-bold text-blue-300" aria-hidden="true">AI</span>
        <h3 className="text-sm font-semibold text-cg-primary">CodeGuard Analysis</h3>
      </div>
      <p className="whitespace-pre-wrap break-words px-3 py-3 text-sm leading-relaxed text-cg-primary">{evidence.explanation || finding.explanation || 'No explanation was saved for this finding.'}</p>
    </section>
    <SuggestedFixGuidance finding={finding} suggestedFix={finding.suggestedFix} />
  </div>;
}

function GitHubPublicationStatus({
  review,
  compact = false,
  tableCompact = false,
  onRetry,
  retrying,
  busy = false,
  error
}) {
  const presentation = getGitHubPublicationPresentation(review.githubPublicationStatus, review.status);
  const publicationUrl = getGitHubPublicationUrl(review.githubPublicationUrl);
  const canRetry = canRetryGitHubPublication(review);
  return <div className={`flex flex-wrap items-center ${tableCompact ? 'gap-2' : 'justify-between gap-3'} ${compact ? '' : 'rounded-xl border border-slate-800 bg-slate-950/60 p-4'}`}>
    <div className="min-w-0">
      {!compact && <p className="text-[10px] font-semibold text-cg-muted">GitHub publication</p>}
      <div className={`flex flex-wrap items-center gap-2 ${compact ? '' : 'mt-1.5'}`}>
        {compact && !tableCompact && <span className="text-[11px] text-cg-muted">GitHub</span>}
        {tableCompact ? <span className="opacity-75"><StatusBadge status={review.githubPublicationStatus || 'not_needed'} label={presentation.label} /></span> : <StatusBadge status={review.githubPublicationStatus || 'not_needed'} label={presentation.label} />}
        {publicationUrl && (tableCompact ? <a href={publicationUrl} target="_blank" rel="noreferrer" aria-label={`Open GitHub review for PR #${review.prNumber}`} title="Open GitHub review" className="inline-flex rounded text-cg-muted hover:text-cg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><ArrowUpRight className="h-3 w-3" aria-hidden="true" /></a> : <a href={publicationUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-violet-200 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">View GitHub review <ArrowUpRight className="h-3 w-3" aria-hidden="true" /></a>)}
      </div>
      {!compact && <p className="mt-2 text-xs leading-relaxed text-slate-400">{presentation.description}</p>}
      {error && <p className="mt-2 text-xs text-red-200" role="alert">{error}</p>}
    </div>
    {canRetry && onRetry && <button type="button" onClick={onRetry} disabled={busy} className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition disabled:cursor-wait disabled:opacity-60 focus:outline-none focus-visible:ring-2 ${tableCompact ? 'border-cg-border text-cg-muted hover:bg-cg-raised hover:text-cg-primary focus-visible:ring-blue-400' : 'border-violet-400/25 bg-violet-500/10 px-3 text-violet-200 hover:border-violet-300/40 hover:bg-violet-500/15 focus-visible:ring-violet-400'}`}>
      {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
      {tableCompact ? retrying ? 'Retrying' : 'Retry' : retrying ? 'Retrying publication…' : 'Retry GitHub publication'}
    </button>}
  </div>;
}
function PullRequestTableRow({
  group,
  repository,
  metadata,
  onOpenReview,
  onRetryReview,
  retryingReviewId,
  reviewRetryError,
  onRetryPublication,
  retryingPublicationId,
  publicationRetryError
}) {
  const [revisionsExpanded, setRevisionsExpanded] = useState(false);
  const { prNumber, revisions, latestRevision } = group;
  const openLatestReview = () => onOpenReview(latestRevision);
  const handleRowClick = event => {
    if (event.target.closest('button, a, summary, input')) return;
    openLatestReview();
  };
  const githubPullRequestUrl = repository?.url && Number.isInteger(prNumber)
    ? `${repository.url}/pull/${prNumber}`
    : null;
  const sourceBranch = metadata?.sourceBranch;
  const targetBranch = metadata?.targetBranch;

  return <>
    <tr className="cursor-pointer transition-colors hover:bg-cg-raised/50 focus-within:bg-cg-raised/50" onClick={handleRowClick}>
      <td className="px-3 py-3 align-top sm:px-4">
        <div className="flex items-start gap-2">
          <button type="button" onClick={openLatestReview} className="min-w-0 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
            <span className="block truncate text-sm font-semibold text-cg-primary" title={metadata?.title || undefined}>
              {metadata?.title || 'Title unavailable'}
            </span>
            <span className="mt-1 block truncate text-[11px] text-cg-muted">
              #{prNumber}{metadata?.author ? ` · @${metadata.author}` : ''}{latestRevision.commitSha ? ` · ${shortSha(latestRevision.commitSha)}` : ''}
            </span>
          </button>
          {githubPullRequestUrl && <a href={githubPullRequestUrl} target="_blank" rel="noreferrer" aria-label={`Open PR #${prNumber} on GitHub`} title="Open pull request on GitHub" className="mt-0.5 shrink-0 rounded p-1 text-cg-muted hover:text-cg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>}
        </div>
        {revisions.length > 1 && <button type="button" aria-expanded={revisionsExpanded} onClick={() => setRevisionsExpanded(open => !open)} className="ml-0.5 mt-1 flex items-center gap-1 rounded text-[11px] text-cg-muted hover:text-cg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
          <ChevronRight className={`h-3 w-3 transition-transform ${revisionsExpanded ? 'rotate-90' : ''}`} aria-hidden="true" />
          {revisions.length} revisions
        </button>}
      </td>
      <td className="px-3 py-3 align-top sm:px-4">
        <span className="block truncate text-sm text-cg-primary" title={repository?.fullName || undefined}>
          {repository?.name || repository?.fullName || 'Repository unavailable'}
        </span>
      </td>
      <td className="px-3 py-3 align-top sm:px-4">
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-cg-muted" title={sourceBranch && targetBranch ? `${sourceBranch} → ${targetBranch}` : undefined}>
          <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {sourceBranch && targetBranch
            ? <><span className="max-w-[42%] truncate">{sourceBranch}</span><span aria-hidden="true">→</span><span className="max-w-[42%] truncate">{targetBranch}</span></>
            : <span className="truncate">Branches unavailable</span>}
        </div>
      </td>
      <td className="px-3 py-3 align-top sm:px-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge status={latestRevision.status} />
          <span className="text-[11px] text-cg-muted">{getReviewFindingSummary(latestRevision)}</span>
          {latestRevision.status === 'failed' && <button type="button" onClick={() => onRetryReview(latestRevision)} disabled={Boolean(retryingReviewId)} aria-label={`Retry analysis for PR #${prNumber}`} title="Retry review" className="rounded p-1 text-cg-muted hover:bg-cg-raised hover:text-cg-primary disabled:cursor-wait disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
            {retryingReviewId === latestRevision._id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          </button>}
        </div>
        {reviewRetryError?.reviewId === latestRevision._id && latestRevision.status === 'failed' && <p className="mt-1 text-[11px] text-red-200" role="alert">{reviewRetryError.message}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="text-[10px] text-cg-muted">GitHub</span>
          <GitHubPublicationStatus review={latestRevision} compact tableCompact onRetry={() => onRetryPublication(latestRevision)} retrying={retryingPublicationId === latestRevision._id} busy={Boolean(retryingPublicationId)} error={publicationRetryError?.reviewId === latestRevision._id ? publicationRetryError.message : ''} />
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-3 align-top text-xs text-cg-muted sm:px-4">
        {metadata?.updatedAt ? <RelativeTime value={metadata.updatedAt} /> : 'Unavailable'}
      </td>
    </tr>
    {revisionsExpanded && revisions.length > 1 && <tr className="bg-cg-surface/60">
      <td colSpan={5} className="px-3 pb-4 pt-1 sm:px-4">
        <ol className="divide-y divide-cg-border border-y border-cg-border">
          {revisions.slice(0, -1).map((revision, index) => <li key={revision._id} className="grid min-w-0 gap-2 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <button type="button" onClick={() => onOpenReview(revision)} className="min-w-0 rounded py-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs font-medium text-cg-primary">Revision {index + 1}</span>
                <StatusBadge status={revision.status} />
                <span className="text-[11px] text-cg-muted">{getReviewFindingSummary(revision)}</span>
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-cg-muted">
                <span className="font-mono" title={revision.commitSha || undefined}>{revision.commitSha ? shortSha(revision.commitSha) : 'SHA unavailable'}</span>
                <RelativeTime value={revision.createdAt} />
              </span>
            </button>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-cg-muted">GitHub</span>
              <GitHubPublicationStatus review={revision} compact tableCompact onRetry={() => onRetryPublication(revision)} retrying={retryingPublicationId === revision._id} busy={Boolean(retryingPublicationId)} error={publicationRetryError?.reviewId === revision._id ? publicationRetryError.message : ''} />
              {revision.status === 'failed' && <button type="button" onClick={() => onRetryReview(revision)} disabled={Boolean(retryingReviewId)} aria-label={`Retry analysis for PR #${prNumber}, revision ${index + 1}`} className="rounded p-1 text-cg-muted hover:bg-cg-raised hover:text-cg-primary disabled:cursor-wait disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
                {retryingReviewId === revision._id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
              </button>}
            </div>
            {reviewRetryError?.reviewId === revision._id && revision.status === 'failed' && <p className="text-[11px] text-red-200" role="alert">{reviewRetryError.message}</p>}
          </li>)}
        </ol>
        <RevisionComparison revisions={revisions} onOpenReview={onOpenReview} />
      </td>
    </tr>}
  </>;
}
function SelectRepositoryPrompt({
  onBrowse
}) {
  return <EmptyPanel title="Select a repository" message="Choose a repository from the sidebar to view its pull requests and saved reviews." action="Browse repositories" onAction={onBrowse} />;
}
function ConnectRepositoryPrompt({
  repository,
  onConnect
}) {
  return <EmptyPanel title={`Connect ${repository.name} through GitHub App`} message={repository.connected ? 'This repository is linked through GitHub OAuth, but OAuth access does not configure App webhook delivery.' : 'Connect this repository through your GitHub App installation to enable automatic pull request reviews.'} action="Connect repository" onAction={onConnect} />;
}
function LoadingPanel({
  label
}) {
  return <div className="rounded-2xl border border-slate-800 bg-slate-950/50 p-8 text-center" role="status" aria-live="polite">      <Loader2 className="mx-auto h-6 w-6 animate-spin text-violet-400" aria-hidden="true" />      <p className="mt-3 text-sm text-slate-300">{label}</p>    </div>;
}
function ErrorPanel({
  message,
  onRetry
}) {
  return <div className="rounded-2xl border border-red-400/20 bg-red-400/[0.04] p-6 text-center" role="alert">      <p className="text-sm text-red-100">{message}</p>      <p className="mt-2 text-xs text-cg-muted">Retry reloads saved history; it does not restart the review job.</p>      <button type="button" onClick={onRetry} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Retry request</button>    </div>;
}
function EmptyPanel({
  title,
  message,
  action,
  onAction
}) {
  return <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/50 px-6 py-12 text-center">      <GitPullRequest className="mx-auto h-7 w-7 text-violet-300" aria-hidden="true" />      <h2 className="mt-3 text-sm font-semibold text-slate-200">{title}</h2>      <p className="mx-auto mt-1.5 max-w-lg text-xs leading-relaxed text-cg-muted">{message}</p>      {action && <button type="button" onClick={onAction} className="mt-4 rounded-lg border border-violet-400/25 bg-violet-500/10 px-3 py-2 text-xs font-semibold text-violet-200 hover:bg-violet-500/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">{action}</button>}    </div>;
}
function mergeRepositorySources(oauthRepositories, appRepositories) {
  const sourcesByName = new Map();
  const addSource = (repository, source) => {
    const fullName = repository.fullName?.trim();
    if (!fullName) return;
    const key = fullName.toLocaleLowerCase();
    const sources = sourcesByName.get(key) || {};
    sources[source] = repository;
    sourcesByName.set(key, sources);
  };
  oauthRepositories.forEach(repository => addSource(repository, 'oauth'));
  appRepositories.forEach(repository => addSource(repository, 'app'));
  return Array.from(sourcesByName.values(), sources => {
    const oauthRepository = sources.oauth;
    const appRepository = sources.app;
    const connectedRepository = [appRepository, oauthRepository].find(repository => repository?.connected);
    const primaryRepository = connectedRepository || appRepository || oauthRepository;
    return {
      ...primaryRepository,
      connected: Boolean(connectedRepository),
      connectionType: connectedRepository ? connectedRepository.connectionType || (connectedRepository === appRepository ? 'github_app' : 'oauth') : appRepository ? 'github_app' : 'oauth',
      installationId: connectedRepository ? connectedRepository.installationId : appRepository?.installationId,
      private: appRepository?.private ?? oauthRepository?.private ?? primaryRepository.private,
      availableViaApp: Boolean(appRepository),
      availableViaOAuth: Boolean(oauthRepository),
      appRepository,
      oauthRepository
    };
  });
}
function mergeLoadedRepositories(existingRepositories, incomingRepositories) {
  const repositoriesById = new Map(existingRepositories.map(repository => [String(repository.id), repository]));
  incomingRepositories.forEach(repository => {
    repositoriesById.set(String(repository.id), repository);
  });
  return Array.from(repositoriesById.values());
}
export default function Dashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams(); // Sidebar State
  const [repos, setRepos] = useState([]);
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [repoError, setRepoError] = useState('');
  const [repoReauthRequired, setRepoReauthRequired] = useState(false);
  const [repoRetry, setRepoRetry] = useState(0);
  const [repoPage, setRepoPage] = useState(1);
  const [repoHasNextPage, setRepoHasNextPage] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [activeView, setActiveView] = useState('dashboard');
  const [selectedReviewId, setSelectedReviewId] = useState(null);
  const [selectedFindingIndex, setSelectedFindingIndex] = useState(0);
  const [reviewDetailsReturnView, setReviewDetailsReturnView] = useState('pull-requests');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarPage, setSidebarPage] = useState(1);
  const [manageRepositoriesPage, setManageRepositoriesPage] = useState(1);
  const [repositorySearch, setRepositorySearch] = useState(''); // GitHub App installation and repository selection state.
  const [pullRequestSearch, setPullRequestSearch] = useState('');
  const [githubAppNotice, setGithubAppNotice] = useState(() => {
    const result = new URLSearchParams(window.location.search).get('github_app');
    return result ? GITHUB_APP_CALLBACK_MESSAGES[result] || 'GitHub App setup returned an unrecognized result. Please try again.' : '';
  });
  const [startingAppInstall, setStartingAppInstall] = useState(false);
  const [installations, setInstallations] = useState([]);
  const [selectedInstallationId, setSelectedInstallationId] = useState('');
  const [loadingInstallations, setLoadingInstallations] = useState(true);
  const [installationError, setInstallationError] = useState('');
  const [installationRetry, setInstallationRetry] = useState(0);
  const [appRepos, setAppRepos] = useState([]);
  const [loadingAppRepos, setLoadingAppRepos] = useState(false);
  const [appRepoError, setAppRepoError] = useState('');
  const [appRepoRetry, setAppRepoRetry] = useState(0);
  const [appRepoPage, setAppRepoPage] = useState(1);
  const [appRepoHasNextPage, setAppRepoHasNextPage] = useState(false);
  const [connectingAppRepoId, setConnectingAppRepoId] = useState(null);
  const [appConnectError, setAppConnectError] = useState(''); // Main Content State
  const [reviews, setReviews] = useState([]);
  const [loadingReviews, setLoadingReviews] = useState(false);
  const [reviewsError, setReviewsError] = useState('');
  const [reviewsRetry, setReviewsRetry] = useState(0);
  const [analyticsDateFilter, setAnalyticsDateFilter] = useState('all');
  const [pullRequestMetadataByRepository, setPullRequestMetadataByRepository] = useState({});
  const [retryingReviewId, setRetryingReviewId] = useState(null);
  const [reviewRetryError, setReviewRetryError] = useState(null);
  const [retryingPublicationId, setRetryingPublicationId] = useState(null);
  const [publicationRetryError, setPublicationRetryError] = useState(null);
  const handleUnauthorized = useCallback(() => {
    localStorage.removeItem('codeguard_token');
    navigate('/login', {
      replace: true
    });
  }, [navigate]); // Callback query values are mapped to fixed, user-safe messages and removed
  // from the address bar immediately.
  useEffect(() => {
    const result = searchParams.get('github_app');
    if (!result) return;
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.delete('github_app');
      return next;
    }, {
      replace: true
    });
  }, [searchParams, setSearchParams]);
  useEffect(() => {
    const controller = new AbortController();
    const fetchInstallations = async () => {
      setLoadingInstallations(true);
      setInstallationError('');
      try {
        const token = localStorage.getItem('codeguard_token');
        const response = await fetch(apiUrl('/api/github/app/installations'), {
          headers: {
            Authorization: `Bearer ${token}`
          },
          signal: controller.signal
        });
        let data = {};
        try {
          data = await response.json();
        } catch {/* status is reported below */}
        if (response.status === 401) {
          handleUnauthorized();
          return;
        }
        if (!response.ok) {
          throw new Error(data.error || `Could not load GitHub App installations (HTTP ${response.status}).`);
        }
        if (!Array.isArray(data.installations)) {
          throw new Error('The server returned an unexpected GitHub App installation response.');
        }
        setInstallations(data.installations);
        setSelectedInstallationId(current => data.installations.some(item => item.installationId === current && item.status === 'active') ? current : data.installations.find(item => item.status === 'active')?.installationId || data.installations[0]?.installationId || '');
      } catch (error) {
        if (error.name !== 'AbortError') {
          setInstallations([]);
          setSelectedInstallationId('');
          setInstallationError(error.message || 'Could not load GitHub App installations.');
        }
      } finally {
        if (!controller.signal.aborted) setLoadingInstallations(false);
      }
    };
    fetchInstallations();
    return () => controller.abort();
  }, [handleUnauthorized, installationRetry]);
  const selectedInstallation = installations.find(installation => installation.installationId === selectedInstallationId);
  useEffect(() => {
    if (!selectedInstallationId || selectedInstallation?.status !== 'active') {
      return undefined;
    }
    const controller = new AbortController();
    const fetchAppRepositories = async () => {
      setLoadingAppRepos(true);
      setAppRepoError('');
      try {
        const token = localStorage.getItem('codeguard_token');
        const response = await fetch(apiUrl(`/api/github/app/installations/${encodeURIComponent(selectedInstallationId)}/repos?page=${appRepoPage}`), {
          headers: {
            Authorization: `Bearer ${token}`
          },
          signal: controller.signal
        });
        let data = {};
        try {
          data = await response.json();
        } catch {/* status is reported below */}
        if (response.status === 401) {
          handleUnauthorized();
          return;
        }
        if (response.status === 404) {
          throw new Error('This active installation is no longer available. Reconnect the GitHub App and try again.');
        }
        if (!response.ok) {
          throw new Error(data.error || `Could not load App repositories (HTTP ${response.status}).`);
        }
        if (!Array.isArray(data.repositories)) {
          throw new Error('The server returned an unexpected App repository response.');
        }
        const fetchedRepositories = data.repositories.map(repository => ({
          ...repository,
          connectionType: repository.connected ? repository.connectionType || 'github_app' : null,
          installationId: repository.connected ? repository.installationId : selectedInstallationId
        }));
        setAppRepos(current => mergeLoadedRepositories(current, fetchedRepositories));
        setAppRepoHasNextPage(Boolean(data.pagination?.hasNextPage));
      } catch (error) {
        if (error.name !== 'AbortError') {
          setAppRepoHasNextPage(false);
          setAppRepoError(error.message || 'Could not load App repositories.');
        }
      } finally {
        if (!controller.signal.aborted) setLoadingAppRepos(false);
      }
    };
    fetchAppRepositories();
    return () => controller.abort();
  }, [selectedInstallationId, selectedInstallation?.status, appRepoPage, appRepoRetry, handleUnauthorized]); // Fetch Repositories on mount
  useEffect(() => {
    const controller = new AbortController();
    const fetchRepos = async () => {
      setLoadingRepos(true);
      setRepoError('');
      setRepoReauthRequired(false);
      try {
        const token = localStorage.getItem('codeguard_token');
        const response = await fetch(apiUrl(`/api/github/repos?page=${repoPage}`), {
          headers: {
            'Authorization': `Bearer ${token}`
          },
          signal: controller.signal
        });
        let data = {};
        try {
          data = await response.json();
        } catch {// A malformed body on an error response is reported below by status.
        }
        if (response.status === 401 || response.status === 403) {
          if (data.code === 'GITHUB_REAUTH_REQUIRED' || data.code === 'GITHUB_ACCESS_DENIED') {
            setRepoReauthRequired(true);
            throw new Error(data.error || 'GitHub authorization needs attention.');
          }
          if (response.status === 401) {
            handleUnauthorized();
            return;
          }
        }
        if (!response.ok) {
          throw new Error(data.error || `Failed to load repositories (HTTP ${response.status}).`);
        }
        if (!Array.isArray(data.repositories)) {
          throw new Error('The server returned an unexpected repository response.');
        }
        setRepos(current => mergeLoadedRepositories(current, data.repositories));
        setRepoHasNextPage(Boolean(data.pagination?.hasNextPage));
      } catch (err) {
        if (err.name !== 'AbortError') {
          setRepoHasNextPage(false);
          setRepoError(err.message || 'Could not load repositories.');
        }
      } finally {
        if (!controller.signal.aborted) setLoadingRepos(false);
      }
    };
    fetchRepos();
    return () => controller.abort();
  }, [handleUnauthorized, repoPage, repoRetry]);
  const mergedRepositories = mergeRepositorySources(repos, appRepos);
  const ownedRepositories = mergedRepositories.filter(repository => repository.ownedByAuthenticatedUser === true);
  const filteredRepositories = filterRepositories(ownedRepositories, repositorySearch);
  const sidebarPageCount = Math.max(1, Math.ceil(filteredRepositories.length / SIDEBAR_REPOSITORIES_PER_PAGE));
  const currentSidebarPage = Math.min(sidebarPage, sidebarPageCount);
  const sidebarRepositories = filteredRepositories.slice((currentSidebarPage - 1) * SIDEBAR_REPOSITORIES_PER_PAGE, currentSidebarPage * SIDEBAR_REPOSITORIES_PER_PAGE);
  const manageRepositoriesPageCount = Math.max(1, Math.ceil(filteredRepositories.length / SIDEBAR_REPOSITORIES_PER_PAGE));
  const currentManageRepositoriesPage = Math.min(manageRepositoriesPage, manageRepositoriesPageCount);
  const managedRepositories = filteredRepositories.slice((currentManageRepositoriesPage - 1) * SIDEBAR_REPOSITORIES_PER_PAGE, currentManageRepositoriesPage * SIDEBAR_REPOSITORIES_PER_PAGE);
  const appRepositoriesHaveNextPage = Boolean(appRepoHasNextPage && selectedInstallation?.status === 'active');
  const moreRepositorySourcesAvailable = repoHasNextPage || appRepositoriesHaveNextPage;
  const canAdvanceManageRepositories = currentManageRepositoriesPage < manageRepositoriesPageCount || moreRepositorySourcesAvailable;
  const selectedRepoUsesApp = selectedRepo?.connectionType === 'github_app';
  const selectedRepoAppConnected = Boolean(selectedRepo?.connected && selectedRepoUsesApp);
  const totalFindings = reviews.reduce((total, review) => total + (Array.isArray(review.findings) ? review.findings.length : 0), 0);
  const analyticsFilteredReviews = useMemo(() => {
    if (analyticsDateFilter === 'all') return reviews;
    const dayCount = { '7d': 7, '30d': 30, '90d': 90 }[analyticsDateFilter];
    // Cutoff = midnight at the start of (today - (dayCount - 1) days).
    // "7 days" = today + previous 6 calendar days = 7 dates total.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (dayCount - 1));
    cutoff.setHours(0, 0, 0, 0);
    return reviews.filter(r => r.createdAt && new Date(r.createdAt) >= cutoff);
  }, [reviews, analyticsDateFilter]);
  const reviewAnalytics = calculateReviewAnalytics(analyticsFilteredReviews);
  const pullRequestRevisionGroups = Array.from(reviews.reduce((reviewsByPr, review) => {
    const revisions = reviewsByPr.get(review.prNumber) || [];
    revisions.push(review);
    reviewsByPr.set(review.prNumber, revisions);
    return reviewsByPr;
  }, new Map()).entries()).map(([prNumber, revisions]) => {
    const chronologicalRevisions = [...revisions].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    return {
      prNumber,
      revisions: chronologicalRevisions,
      latestRevision: chronologicalRevisions[chronologicalRevisions.length - 1]
    };
  }).sort((left, right) => new Date(right.latestRevision?.createdAt).getTime() - new Date(left.latestRevision?.createdAt).getTime());
  const selectedRepositoryMetadata = pullRequestMetadataByRepository[String(selectedRepo?.id)] || {};
  const normalizedPullRequestSearch = pullRequestSearch.trim().toLocaleLowerCase();
  const visiblePullRequestRevisionGroups = normalizedPullRequestSearch ? pullRequestRevisionGroups.filter(group => {
    const metadataEntry = selectedRepositoryMetadata[String(group.prNumber)];
    const metadata = metadataEntry?.metadata;
    const reviewContent = group.revisions.flatMap(review => [
      review.commitSha,
      review.status,
      review.githubPublicationStatus,
      review.createdAt,
      ...getReviewFindings(review).flatMap(finding => [finding.title, finding.category, finding.filePath])
    ]);
    return [group.prNumber, selectedRepo?.fullName, selectedRepo?.name, metadata?.title, metadata?.author, metadata?.sourceBranch, metadata?.targetBranch, metadata?.updatedAt, ...reviewContent]
      .filter(value => value !== null && value !== undefined)
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedPullRequestSearch);
  }) : pullRequestRevisionGroups;
  const pullRequests = pullRequestRevisionGroups.map(group => group.latestRevision);
  const selectedReview = reviews.find(review => String(review._id) === selectedReviewId);
  const selectedReviewMetadata = selectedRepositoryMetadata[String(selectedReview?.prNumber)]?.metadata;
  const navigationView = activeView === 'review-details' ? reviewDetailsReturnView : activeView === 'review-history' ? 'pull-requests' : activeView;
  const selectedReviewFindings = Array.isArray(selectedReview?.findings) ? selectedReview.findings : [];
  const sortedSelectedReviewFindings = selectedReviewFindings
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => {
      const leftSeverity = SEVERITY_ORDER.indexOf(left.finding?.severity);
      const rightSeverity = SEVERITY_ORDER.indexOf(right.finding?.severity);
      const leftRank = leftSeverity < 0 ? SEVERITY_ORDER.length : leftSeverity;
      const rightRank = rightSeverity < 0 ? SEVERITY_ORDER.length : rightSeverity;
      return leftRank - rightRank || left.index - right.index;
    });
  const selectedFinding = sortedSelectedReviewFindings[selectedFindingIndex]?.finding || sortedSelectedReviewFindings[0]?.finding || null;
  const fetchReviewHistory = useCallback(async (repository, signal) => {
    try {
      const token = localStorage.getItem('codeguard_token');
      const fetchedReviews = await requestReviewHistory(repository.id, token, signal);
      setReviews(fetchedReviews);
      setReviewsError('');
    } catch (err) {
      if (err.name !== 'AbortError') {
        if (err.status === 401) {
          handleUnauthorized();
        } else {
          setReviewsError(err.message || 'Could not load review history.');
        }
      }
    }
  }, [handleUnauthorized]); // Fetch saved history when a connected repository is selected or retried.
  useEffect(() => {
    if (!selectedRepoAppConnected) return undefined;
    const controller = new AbortController();
    const requestTimeout = setTimeout(async () => {
      try {
        await fetchReviewHistory(selectedRepo, controller.signal);
      } finally {
        if (!controller.signal.aborted) setLoadingReviews(false);
      }
    }, 0);
    return () => {
      clearTimeout(requestTimeout);
      controller.abort();
    };
  }, [selectedRepo, selectedRepoAppConnected, handleUnauthorized, reviewsRetry, fetchReviewHistory]); // Refresh only while persisted reviews report an active worker state.
  useEffect(() => {
    if (!selectedRepoAppConnected || !hasActiveReviews(reviews)) return undefined;
    const controller = new AbortController();
    let pollInProgress = false;
    const intervalId = setInterval(async () => {
      if (pollInProgress || controller.signal.aborted) return;
      pollInProgress = true;
      try {
        await fetchReviewHistory(selectedRepo, controller.signal);
      } finally {
        pollInProgress = false;
      }
    }, REVIEW_POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(intervalId);
    };
  }, [selectedRepo, selectedRepoAppConnected, reviews, fetchReviewHistory]);
  useEffect(() => {
    const repositoryId = selectedRepo?.id;
    const pullRequestViewActive = activeView === 'pull-requests' || (
      activeView === 'review-details' && reviewDetailsReturnView === 'pull-requests'
    );
    if (!pullRequestViewActive || !repositoryId || !selectedRepo.connected || loadingReviews || reviewsError || !reviews.length) {
      return undefined;
    }

    const repositoryKey = String(repositoryId);
    const cachedMetadata = pullRequestMetadataByRepository[repositoryKey] || {};
    const latestReviewByNumber = new Map();
    reviews.forEach(review => {
      if (!Number.isSafeInteger(review.prNumber) || review.prNumber < 1) return;
      const current = latestReviewByNumber.get(review.prNumber);
      if (!current || new Date(review.createdAt).getTime() > new Date(current.createdAt).getTime()) {
        latestReviewByNumber.set(review.prNumber, review);
      }
    });
    const requestedNumbers = Array.from(latestReviewByNumber.entries())
      .filter(([number, latestReview]) => {
        const cached = cachedMetadata[String(number)];
        return !cached || cached.reviewCommitSha !== latestReview.commitSha;
      })
      .map(([number]) => number);
    if (!requestedNumbers.length) return undefined;

    const controller = new AbortController();
    const fetchMetadata = async () => {
      const fetchedByNumber = {};
      for (let index = 0; index < requestedNumbers.length; index += 25) {
        const batch = requestedNumbers.slice(index, index + 25);
        try {
          const token = localStorage.getItem('codeguard_token');
          const response = await fetch(apiUrl(`/api/dashboard/repos/${encodeURIComponent(repositoryId)}/pull-request-metadata`), {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ pullRequestNumbers: batch }),
            signal: controller.signal,
          });
          let data = {};
          try {
            data = await response.json();
          } catch { /* Missing optional metadata must not block review history. */ }
          if (response.status === 401) {
            handleUnauthorized();
            return;
          }
          if (!response.ok || !Array.isArray(data.pullRequests)) {
            batch.forEach(number => { fetchedByNumber[String(number)] = null; });
            continue;
          }

          const returnedByNumber = new Map(data.pullRequests.map(item => [item.number, item]));
          batch.forEach(number => {
            fetchedByNumber[String(number)] = returnedByNumber.get(number) || null;
          });
        } catch (error) {
          if (error.name === 'AbortError') return;
          batch.forEach(number => { fetchedByNumber[String(number)] = null; });
        }
      }

      if (controller.signal.aborted) return;
      const latestCommitByNumber = new Map(Array.from(latestReviewByNumber, ([number, review]) => [number, review.commitSha]));
      setPullRequestMetadataByRepository(current => ({
        ...current,
        [repositoryKey]: {
          ...(current[repositoryKey] || {}),
          ...Object.fromEntries(Object.entries(fetchedByNumber).map(([number, metadata]) => [number, {
            metadata,
            reviewCommitSha: latestCommitByNumber.get(Number(number)),
          }])),
        },
      }));
    };

    fetchMetadata();
    return () => controller.abort();
  }, [activeView, reviewDetailsReturnView, selectedRepo?.id, selectedRepo?.connected, loadingReviews, reviewsError, reviews, pullRequestMetadataByRepository, handleUnauthorized]);
  const handleLogout = () => {
    localStorage.removeItem('codeguard_token');
    navigate('/login');
  };
  const selectRepository = repository => {
    setSelectedRepo(repository);
    setActiveView('dashboard');
    setSelectedReviewId(null);
    setAnalyticsDateFilter('all');
    const repositoryIndex = filteredRepositories.findIndex(item => item.fullName?.toLocaleLowerCase() === repository.fullName?.toLocaleLowerCase());
    if (repositoryIndex >= 0) {
      setSidebarPage(Math.floor(repositoryIndex / SIDEBAR_REPOSITORIES_PER_PAGE) + 1);
    }
    setMobileSidebarOpen(false);
    setAppConnectError('');
    setReviews([]);
    setReviewsError('');
    setLoadingReviews(Boolean(repository.connected));
  };
  const openReviewDetails = (review, returnView = activeView) => {
    if (!review?._id) return;
    setSelectedReviewId(String(review._id));
    setSelectedFindingIndex(0);
    setReviewDetailsReturnView(returnView === 'dashboard' ? 'dashboard' : 'pull-requests');
    setActiveView('review-details');
    setMobileSidebarOpen(false);
  };
  const returnFromReviewDetails = () => {
    setActiveView(reviewDetailsReturnView);
  };
  const retryReviewHistory = () => {
    if (selectedRepo?.id) {
      setPullRequestMetadataByRepository(current => ({ ...current, [String(selectedRepo.id)]: {} }));
    }
    setReviews([]);
    setReviewsError('');
    setLoadingReviews(true);
    setReviewsRetry(attempt => attempt + 1);
  };
  const handleRetryReview = async review => {
    if (!selectedRepoAppConnected || !selectedRepo || review.status !== 'failed' || retryingReviewId) return;
    setRetryingReviewId(review._id);
    setReviewRetryError(null);
    try {
      const token = localStorage.getItem('codeguard_token');
      await requestReviewRetry(selectedRepo.id, review._id, token);
      setReviews(current => current.map(item => item._id === review._id ? {
        ...item,
        status: 'queued',
        summary: 'Review retry queued.'
      } : item));
      setReviewsRetry(attempt => attempt + 1);
    } catch (error) {
      if (error.status === 401) {
        handleUnauthorized();
      } else {
        setReviewRetryError({
          reviewId: review._id,
          message: error.message || 'Could not retry this review.'
        }); // A timeout can happen after the server accepted the retry; reload to
        // reconcile the UI with the persisted review status.
        setReviewsRetry(attempt => attempt + 1);
      }
    } finally {
      setRetryingReviewId(null);
    }
  };
  const handleRetryPublication = async review => {
    if (!selectedRepo || !canRetryGitHubPublication(review) || retryingPublicationId) return;
    setRetryingPublicationId(review._id);
    setPublicationRetryError(null);
    try {
      const token = localStorage.getItem('codeguard_token');
      const result = await requestGitHubPublicationRetry(selectedRepo.id, review._id, token);
      setReviews(current => current.map(item => item._id === review._id ? {
        ...item,
        githubPublicationStatus: result.githubPublicationStatus,
        githubPublicationUrl: result.githubPublicationUrl
      } : item));
      setReviewsRetry(attempt => attempt + 1);
    } catch (error) {
      if (error.status === 401) {
        handleUnauthorized();
      } else {
        setPublicationRetryError({
          reviewId: review._id,
          message: error.message || 'Could not retry GitHub publication.'
        });
        setReviewsRetry(attempt => attempt + 1);
      }
    } finally {
      setRetryingPublicationId(null);
    }
  };
  const handleStartGitHubAppInstall = async () => {
    setStartingAppInstall(true);
    setGithubAppNotice('');
    try {
      const token = localStorage.getItem('codeguard_token');
      const response = await fetch(apiUrl('/api/github/app/installations/start'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      });
      let data = {};
      try {
        data = await response.json();
      } catch {/* status is reported below */}
      if (response.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || `Could not start GitHub App setup (HTTP ${response.status}).`);
      }
      const destination = new URL(data.redirectUrl);
      if (destination.origin !== 'https://github.com' || !/^\/apps\/[a-zA-Z0-9-]+\/installations\/new\/?$/.test(destination.pathname) || !destination.searchParams.has('state')) {
        throw new Error('The server returned an invalid GitHub App setup link. Please retry.');
      }
      window.location.assign(destination.toString());
    } catch (error) {
      setGithubAppNotice(error.message || 'Could not start GitHub App setup. Please retry.');
      setStartingAppInstall(false);
    }
  };
  const handleConnectAppRepository = async repo => {
    if (repo.connected && repo.connectionType === 'github_app') return;
    if (!selectedInstallationId) {
      setAppConnectError('Install or select an active GitHub App installation before connecting a repository.');
      setActiveView('repositories');
      return;
    }
    setConnectingAppRepoId(repo.id);
    setAppConnectError('');
    try {
      const token = localStorage.getItem('codeguard_token');
      const response = await fetch(apiUrl(`/api/github/app/installations/${encodeURIComponent(selectedInstallationId)}/repos/connect`), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          repositoryId: repo.id
        })
      });
      let data = {};
      try {
        data = await response.json();
      } catch {/* status is reported below */}
      if (response.status === 401) {
        handleUnauthorized();
        return;
      }
      if (response.status === 404) {
        throw new Error('The GitHub App installation is not active. Reconnect it before linking repositories.');
      }
      if (response.status === 409) {
        throw new Error(data.error || 'This repository is already connected through another CodeGuard account or integration.');
      }
      if (!response.ok) {
        throw new Error(data.error || `Could not connect repository (HTTP ${response.status}).`);
      }
      if (!data.repository) {
        throw new Error('The server did not confirm the repository connection. Please retry.');
      }
      const connectedRepo = {
        ...repo,
        ...data.repository,
        connected: true,
        connectionType: 'github_app',
        installationId: selectedInstallationId
      };
      setAppRepos(current => current.map(item => item.id === repo.id ? connectedRepo : item));
      setRepos(current => current.map(item => item.id === repo.id ? {
        ...item,
        connected: true,
        connectionType: 'github_app',
        installationId: selectedInstallationId
      } : item));
      if (selectedRepo?.id === repo.id) {
        setReviews([]);
        setReviewsError('');
        setLoadingReviews(true);
        setSelectedRepo(connectedRepo);
      }
    } catch (error) {
      setAppConnectError(error.message || 'Could not connect this App repository.');
    } finally {
      setConnectingAppRepoId(null);
    }
  };
  return <div className="min-h-screen bg-cg-background font-sans text-cg-primary selection:bg-blue-500/25">      <header className="sticky top-0 z-20 border-b border-cg-border bg-cg-background">        <div className="mx-auto flex h-16 max-w-[1680px] items-center justify-between px-4 sm:px-6 lg:px-8">          <div className="flex items-center gap-3">            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-blue-400/20 bg-blue-500/10">              <Code2 className="h-5 w-5 text-blue-300" aria-hidden="true" />            </div>            <div>              <p className="text-sm font-semibold text-cg-primary">CodeGuard</p>            </div>          </div>          <div className="flex items-center gap-3">            <button type="button" onClick={() => setMobileSidebarOpen(open => !open)} aria-expanded={mobileSidebarOpen} aria-controls="repository-navigation" className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 lg:hidden">              <BookMarked className="h-3.5 w-3.5" aria-hidden="true" /> Browse            </button>            <button type="button" onClick={() => setActiveView('settings')} aria-label="Account settings" title="Account settings" className="inline-flex items-center gap-2 rounded-lg border border-cg-border px-3 py-2 text-xs font-medium text-cg-muted transition hover:bg-cg-raised hover:text-cg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">              <Settings className="h-3.5 w-3.5" aria-hidden="true" />              <span className="hidden sm:inline">Settings</span>            </button>            <button type="button" onClick={handleLogout} className="inline-flex items-center gap-2 rounded-lg border border-cg-border px-3 py-2 text-xs font-medium text-cg-muted transition hover:bg-cg-raised hover:text-cg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />              <span className="hidden sm:inline">Sign out</span>            </button>          </div>        </div>      </header>      <main className="relative mx-auto max-w-[1680px] space-y-5 px-4 py-5 sm:px-6 sm:py-7 lg:px-8">        {githubAppNotice && <div className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${githubAppNotice.startsWith('GitHub App connected.') ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-100' : 'border-blue-400/20 bg-blue-400/5 text-blue-100'}`} role="status" aria-live="polite">            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />            <span>{githubAppNotice}</span>            <button type="button" onClick={() => setGithubAppNotice('')} className="ml-auto rounded px-1 text-xs text-slate-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400" aria-label="Dismiss GitHub App message">              Dismiss            </button>          </div>}        <div className={'grid min-w-0 gap-4 lg:items-start ' + (sidebarCollapsed ? 'lg:grid-cols-[4.5rem_minmax(0,1fr)]' : 'lg:grid-cols-[16rem_minmax(0,1fr)]')}>          <aside id="repository-navigation" aria-label="Repository navigation" className={(mobileSidebarOpen ? 'block' : 'hidden') + ' min-w-0 max-h-[85vh] overflow-y-auto border-b border-cg-border bg-cg-surface/70 p-3 lg:block lg:max-h-none lg:overflow-visible lg:sticky lg:top-20 lg:rounded-xl lg:border lg:p-4 ' + (sidebarCollapsed ? 'lg:p-2' : '')}>            <div className={'flex items-center ' + (sidebarCollapsed ? 'lg:flex-col lg:gap-3' : 'justify-between gap-2')}>              {!sidebarCollapsed && <h2 className="min-w-0 text-sm font-semibold text-cg-primary">Repositories</h2>}              <button type="button" onClick={() => setSidebarCollapsed(collapsed => !collapsed)} aria-label={sidebarCollapsed ? 'Expand repository sidebar' : 'Collapse repository sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="hidden rounded-lg border border-slate-800 bg-slate-900 p-2 text-slate-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 lg:inline-flex">                {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" aria-hidden="true" /> : <PanelLeftClose className="h-4 w-4" aria-hidden="true" />}              </button>              <button type="button" onClick={() => setMobileSidebarOpen(false)} className="rounded px-2 py-1 text-xs text-slate-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 lg:hidden">Close</button>            </div>            <nav aria-label="Dashboard navigation" className="mt-4 space-y-1 border-b border-cg-border pb-4">              {DASHBOARD_VIEWS.map(({
              id,
              label,
              Icon
            }) => <button key={id} type="button" onClick={() => {
              setActiveView(id);
              setMobileSidebarOpen(false);
            }} aria-current={navigationView === id ? 'page' : undefined} title={sidebarCollapsed ? label : undefined} className={'flex w-full min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ' + (navigationView === id ? 'border-blue-400/25 bg-blue-500/10 text-blue-100' : 'border-transparent text-slate-400 hover:border-slate-800 hover:bg-slate-900/70 hover:text-slate-100') + (sidebarCollapsed ? ' lg:justify-center lg:px-1' : '')}>                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />                  <span className={sidebarCollapsed ? 'lg:hidden' : ''}>{label}</span>                  {id === 'pull-requests' && pullRequests.length > 0 && !sidebarCollapsed && <span className="ml-auto rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-400">{pullRequests.length}</span>}                </button>)}            </nav>            {!sidebarCollapsed && <>              <label htmlFor="workspace-repository-search" className="sr-only">Search repositories</label>              <div className="relative mt-4"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cg-muted" aria-hidden="true" /><input id="workspace-repository-search" type="search" value={repositorySearch} onChange={event => {
                setRepositorySearch(event.target.value);
                setSidebarPage(1);
              }} placeholder="Search repositories…" className="w-full rounded-lg border border-slate-800 bg-slate-900/70 py-2 pl-8 pr-2 text-xs text-slate-200 placeholder:text-cg-muted focus:border-blue-400/50 focus:outline-none focus:ring-2 focus:ring-blue-400/20" /></div>            </>}            <div className={'mt-3 space-y-1 ' + (sidebarCollapsed ? 'lg:mt-4' : '')}>              {sidebarRepositories.map(repository => <button key={repository.fullName.toLocaleLowerCase()} type="button" onClick={() => selectRepository(repository)} aria-pressed={selectedRepo?.fullName?.toLocaleLowerCase() === repository.fullName.toLocaleLowerCase()} title={sidebarCollapsed ? repository.fullName : undefined} className={'flex w-full min-w-0 items-center rounded-lg border px-2.5 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ' + (selectedRepo?.fullName?.toLocaleLowerCase() === repository.fullName.toLocaleLowerCase() ? 'border-blue-400/30 bg-blue-500/[0.10] text-white' : 'border-transparent text-slate-300 hover:border-slate-800 hover:bg-slate-900/70') + (sidebarCollapsed ? ' lg:justify-center lg:px-1' : '')}>                <span className={'min-w-0 flex-1 truncate text-xs font-medium ' + (sidebarCollapsed ? 'lg:hidden' : '')}>{repository.name}</span>                {sidebarCollapsed && <span className="hidden text-[10px] font-semibold text-blue-200 lg:inline" aria-hidden="true">{repository.name.slice(0, 1).toUpperCase()}</span>}              </button>)}              {sidebarRepositories.length === 0 && <p className="px-2 py-3 text-xs leading-relaxed text-cg-muted" role="status">{loadingRepos || loadingAppRepos ? 'Loading repositories…' : repositorySearch.trim() ? 'No loaded repositories match your search.' : 'No repositories loaded yet.'}</p>}              {filteredRepositories.length > SIDEBAR_REPOSITORIES_PER_PAGE && <div className={'flex items-center justify-between border-t border-slate-800/80 px-1 pt-2 ' + (sidebarCollapsed ? 'lg:flex-col lg:gap-2' : '')}>                  {!sidebarCollapsed && <span className="text-[10px] tabular-nums text-cg-muted">{filteredRepositories.length} repositories</span>}                  <div className="flex items-center gap-1.5">                    <button type="button" onClick={() => setSidebarPage(page => Math.max(1, page - 1))} disabled={currentSidebarPage === 1} aria-label="Previous repository page" className="rounded-md border border-slate-800 p-1 text-slate-400 hover:bg-slate-900 hover:text-white disabled:opacity-35 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /></button>                    <span className="text-[10px] tabular-nums text-slate-400" aria-live="polite">{currentSidebarPage} / {sidebarPageCount}</span>                    <button type="button" onClick={() => setSidebarPage(page => Math.min(sidebarPageCount, page + 1))} disabled={currentSidebarPage >= sidebarPageCount} aria-label="Next repository page" className="rounded-md border border-slate-800 p-1 text-slate-400 hover:bg-slate-900 hover:text-white disabled:opacity-35 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></button>                  </div>                </div>}            </div>          </aside>          <div className="min-w-0">            <section id="repository-manager" aria-label="Repository management" hidden={activeView !== 'repositories'} className="min-w-0 space-y-4">
  <header className="flex flex-wrap items-end justify-between gap-3 border-b border-cg-border pb-4">
    <div>
      <h1 className="text-xl font-semibold text-cg-primary">Repositories</h1>
      <p className="mt-1 text-sm text-cg-muted">Manage App connections and browse account repositories.</p>
    </div>
    <button type="button" onClick={() => setActiveView('dashboard')} className="rounded-md border border-cg-border px-3 py-1.5 text-xs text-cg-muted hover:bg-cg-raised hover:text-cg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">Back to dashboard</button>
  </header>

  <div className="grid min-w-0 gap-3 lg:grid-cols-2">
    <section className="min-w-0 rounded-xl border border-cg-border bg-cg-surface p-4" aria-labelledby="github-app-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <FaGithub className="h-4 w-4 shrink-0 text-blue-300" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id="github-app-heading" className="text-sm font-semibold text-cg-primary">GitHub App</h2>
            <p className="mt-0.5 text-xs text-cg-muted">Installation access for automatic PR reviews</p>
          </div>
        </div>
        <button type="button" onClick={handleStartGitHubAppInstall} disabled={startingAppInstall} className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:cursor-wait disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
          {startingAppInstall ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />}
          {startingAppInstall ? 'Opening GitHub…' : installations.length ? 'Manage installation' : 'Install GitHub App'}
        </button>
      </div>
      {githubAppNotice && <p className="mt-3 rounded-md border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-100" role="status">{githubAppNotice}</p>}
      {loadingInstallations ? <p className="mt-3 flex items-center gap-2 text-xs text-cg-muted" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300" aria-hidden="true" /> Checking installations…</p> : installationError ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2" role="alert"><p className="text-xs text-red-100">{installationError}</p><button type="button" onClick={() => setInstallationRetry(attempt => attempt + 1)} className="inline-flex items-center gap-1 text-xs font-medium text-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry</button></div> : installations.length === 0 ? <p className="mt-3 text-xs text-cg-muted">No installation is linked to this CodeGuard account.</p> : <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
        <label htmlFor="github-app-installation" className="shrink-0 text-xs text-cg-muted">Installation</label>
        <select id="github-app-installation" value={selectedInstallationId} onChange={event => {
          setSelectedInstallationId(event.target.value);
          setAppRepoPage(1);
          setRepositorySearch('');
          setAppConnectError('');
          setAppRepos([]);
          setAppRepoHasNextPage(false);
          setAppRepoError('');
        }} className="min-w-0 flex-1 rounded-md border border-cg-border bg-cg-raised px-2.5 py-1.5 text-xs text-cg-primary focus:border-blue-400/50 focus:outline-none focus:ring-2 focus:ring-blue-400/20">
          {installations.map(installation => <option key={installation.installationId} value={installation.installationId}>{installation.accountLogin}{installation.accountName ? ' · ' + installation.accountName : ''} · {installation.status}</option>)}
        </select>
      </div>}
      {!loadingInstallations && !installationError && selectedInstallation && <div className="mt-3 border-t border-cg-border pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-cg-muted">{selectedInstallation.accountLogin}{selectedInstallation.accountName ? ' · ' + selectedInstallation.accountName : ''}</span>
          <span className={'text-xs font-medium ' + (selectedInstallation.status === 'active' ? 'text-emerald-300' : 'text-amber-300')}>{selectedInstallation.status}</span>
        </div>
        {selectedInstallation.status !== 'active' ? <p className="mt-2 text-xs text-amber-200">This installation cannot provide repositories while it is {selectedInstallation.status}.</p> : loadingAppRepos ? <p className="mt-2 flex items-center gap-2 text-xs text-cg-muted" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300" aria-hidden="true" /> Loading installation repositories…</p> : appRepoError ? <div className="mt-2 flex flex-wrap items-center justify-between gap-2" role="alert"><p className="text-xs text-red-200">{appRepoError}</p><button type="button" onClick={() => setAppRepoRetry(attempt => attempt + 1)} className="inline-flex items-center gap-1 text-xs font-medium text-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry</button></div> : appRepos.length === 0 ? <p className="mt-2 text-xs text-cg-muted" role="status">No repositories returned on this page.</p> : <p className="mt-2 text-xs text-cg-muted">{appRepos.length} repositories available through this installation</p>}
      </div>}
    </section>

    <section className="min-w-0 rounded-xl border border-cg-border bg-cg-surface p-4" aria-labelledby="oauth-repositories-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <FaGithub className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id="oauth-repositories-heading" className="text-sm font-semibold text-cg-primary">GitHub account</h2>
            <p className="mt-0.5 text-xs text-cg-muted">OAuth access for account repository discovery</p>
          </div>
        </div>
        {loadingRepos ? <span className="text-xs text-cg-muted">Checking access…</span> : repoError ? <span className={'text-xs font-medium ' + (repoReauthRequired ? 'text-amber-300' : 'text-red-300')}>{repoReauthRequired ? 'Reconnect needed' : 'Unavailable'}</span> : <span className="text-xs font-medium text-emerald-300">Connected</span>}
      </div>
      {repoError ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2" role="alert"><p className="text-xs text-red-100">{repoError}</p><div className="flex shrink-0 items-center gap-3">{repoReauthRequired && <a href={apiUrl('/api/auth/github')} className="text-xs font-semibold text-blue-300 hover:text-blue-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">Reconnect</a>}<button type="button" onClick={() => setRepoRetry(attempt => attempt + 1)} className="inline-flex items-center gap-1 text-xs font-medium text-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry</button></div></div> : loadingRepos ? <p className="mt-3 flex items-center gap-2 text-xs text-cg-muted" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300" aria-hidden="true" /> Loading account repositories…</p> : <p className="mt-3 text-xs text-cg-muted" role="status">{repos.length === 0 ? 'No repositories returned on this page.' : repos.length + ' repositories returned on this page.'}</p>}
    </section>
  </div>

  <section className="min-w-0 overflow-hidden rounded-xl border border-cg-border bg-cg-surface" aria-labelledby="available-repositories-heading">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cg-border px-4 py-3">
      <div>
        <h2 id="available-repositories-heading" className="text-sm font-semibold text-cg-primary">Available repositories</h2>
        <p className="mt-0.5 text-xs text-cg-muted">Connect with the GitHub App to enable automatic reviews.</p>
      </div>
      <label htmlFor="manage-repository-search" className="sr-only">Search owned repositories</label>
      <div className="relative w-full sm:max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cg-muted" aria-hidden="true" /><input id="manage-repository-search" type="search" value={repositorySearch} onChange={event => {
        setRepositorySearch(event.target.value);
        setSidebarPage(1);
        setManageRepositoriesPage(1);
      }} placeholder="Search repositories…" className="w-full rounded-md border border-cg-border bg-cg-raised py-2 pl-8 pr-2 text-xs text-cg-primary placeholder:text-cg-muted focus:border-blue-400/50 focus:outline-none focus:ring-2 focus:ring-blue-400/20" /></div>
    </div>
    {loadingRepos && loadingAppRepos && mergedRepositories.length === 0 ? <p className="flex items-center gap-2 px-4 py-5 text-xs text-cg-muted" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300" aria-hidden="true" /> Loading repositories…</p> : filteredRepositories.length === 0 ? <p className="px-4 py-8 text-center text-xs text-cg-muted" role="status">{repositorySearch.trim() ? 'No loaded repositories match this search.' : 'No repositories are available yet.'}</p> : <ul className="divide-y divide-cg-border">
      {managedRepositories.map(repository => {
        const connectedViaApp = repository.connected && repository.connectionType === 'github_app';
        const busy = connectingAppRepoId === repository.id;
        return <li key={repository.fullName.toLocaleLowerCase()} className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-2.5 sm:flex-nowrap">
          <button type="button" onClick={() => selectRepository(repository)} aria-pressed={selectedRepo?.fullName?.toLocaleLowerCase() === repository.fullName.toLocaleLowerCase()} className="min-w-0 flex-1 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><span className="block truncate text-xs font-medium text-cg-primary">{repository.fullName}</span><span className="mt-0.5 block text-[11px] text-cg-muted">{repository.private ? 'Private' : 'Public'}{repository.connected && repository.connectionType === 'oauth' ? ' · OAuth access only' : ''}</span></button>
          {connectedViaApp ? <span className="shrink-0 text-xs font-medium text-emerald-300">Connected</span> : <button type="button" onClick={() => handleConnectAppRepository(repository.appRepository || repository.oauthRepository || repository)} disabled={busy} className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:cursor-wait disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">{busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}{busy ? 'Connecting…' : 'Connect'}</button>}
        </li>;
      })}
    </ul>}
    {appConnectError && <p className="border-t border-red-400/20 px-4 py-2.5 text-xs text-red-200" role="alert">{appConnectError}</p>}
    {(filteredRepositories.length > SIDEBAR_REPOSITORIES_PER_PAGE || moreRepositorySourcesAvailable) && <div className="flex items-center justify-center gap-3 border-t border-cg-border px-4 py-3">
      <button type="button" onClick={() => setManageRepositoriesPage(Math.max(1, currentManageRepositoriesPage - 1))} disabled={currentManageRepositoriesPage === 1 || loadingRepos || loadingAppRepos} className="rounded-md border border-cg-border px-3 py-1.5 text-xs text-cg-muted hover:bg-cg-raised hover:text-cg-primary disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">Previous</button>
      <span className="min-w-12 text-center text-xs tabular-nums text-cg-muted" aria-live="polite">{currentManageRepositoriesPage} / {manageRepositoriesPageCount}</span>
      <button type="button" onClick={() => {
        if (currentManageRepositoriesPage < manageRepositoriesPageCount) {
          setManageRepositoriesPage(currentManageRepositoriesPage + 1);
          return;
        }
        setManageRepositoriesPage(currentManageRepositoriesPage + 1);
        if (repoHasNextPage) setRepoPage(page => page + 1);
        if (appRepositoriesHaveNextPage) setAppRepoPage(page => page + 1);
      }} disabled={!canAdvanceManageRepositories || loadingRepos || loadingAppRepos} className="rounded-md border border-cg-border px-3 py-1.5 text-xs text-cg-muted hover:bg-cg-raised hover:text-cg-primary disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">Next</button>
    </div>}
  </section>
</section><section aria-label="Dashboard overview" hidden={activeView !== 'dashboard'} className="min-w-0">
  {!selectedRepo ? <SelectRepositoryPrompt onBrowse={() => setActiveView('repositories')} /> : !selectedRepoAppConnected ? <ConnectRepositoryPrompt repository={selectedRepo} onConnect={() => setActiveView('repositories')} /> : loadingReviews ? <LoadingPanel label="Loading saved review data…" /> : reviewsError ? <ErrorPanel message={reviewsError} onRetry={retryReviewHistory} /> : <div className="min-w-0">
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-cg-border pb-4">
      <div className="min-w-0">
        <p className="text-xs font-medium text-cg-muted">Dashboard</p>
        <h1 className="mt-1 truncate text-xl font-semibold text-cg-primary sm:text-2xl" title={selectedRepo.fullName || selectedRepo.name}>{selectedRepo.name}</h1>
        {selectedRepo.fullName && selectedRepo.fullName !== selectedRepo.name && <p className="mt-1 truncate text-xs text-cg-muted">{selectedRepo.fullName}</p>}
      </div>
      <button type="button" onClick={() => setActiveView('pull-requests')} className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-cg-border px-3 py-2 text-xs font-medium text-cg-primary transition hover:bg-cg-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
        <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" /> Pull Requests
      </button>
    </header>
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-b border-cg-border py-4 sm:grid-cols-3 xl:grid-cols-5" aria-label="Repository review summary">
      <div><dt className="text-xs text-cg-muted">Review revisions</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-cg-primary">{reviews.length}</dd></div>
      <div><dt className="text-xs text-cg-muted">Findings</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-cg-primary">{totalFindings}</dd></div>
      <div><dt className="text-xs text-cg-muted">Completed</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-cg-primary">{reviews.filter(review => review.status === 'completed').length}</dd></div>
      <div><dt className="text-xs text-cg-muted">In progress</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-cg-primary">{reviews.filter(review => review.status === 'queued' || review.status === 'processing').length}</dd></div>
      <div><dt className="text-xs text-cg-muted">Failed</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-cg-primary">{reviews.filter(review => review.status === 'failed').length}</dd></div>
    </dl>
    <section className="pt-5" aria-labelledby="recent-reviews-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="recent-reviews-heading" className="text-base font-semibold text-cg-primary">Recent reviews</h2>
        {reviews.length > 0 && <span className="text-xs text-cg-muted">{pluralize(Math.min(reviews.length, 5), 'recent review')}</span>}
      </div>
      {reviews.length === 0 ? <p className="mt-3 border-y border-cg-border py-6 text-sm text-cg-muted">No reviews have been recorded for this repository yet.</p> : <ul className="mt-2 divide-y divide-cg-border border-y border-cg-border">
        {reviews.slice(0, 5).map(review => <li key={review._id}>
          <button type="button" onClick={() => openReviewDetails(review, 'dashboard')} className="grid w-full min-w-0 grid-cols-1 items-center gap-3 px-2 py-3 text-left transition hover:bg-cg-raised/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 sm:grid-cols-[minmax(0,1fr)_auto]">
            <span className="flex min-w-0 items-center gap-3">
              <GitPullRequest className="h-4 w-4 shrink-0 text-cg-accent" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-cg-primary">PR #{review.prNumber}</span>
                <span className="mt-1 block truncate font-mono text-[11px] text-cg-muted"><span title={review.commitSha || undefined}>{review.commitSha ? shortSha(review.commitSha) : 'Commit unavailable'}</span><span aria-hidden="true"> · </span><RelativeTime value={review.createdAt} /></span>
              </span>
            </span>
            <span className="flex min-w-0 items-center justify-between gap-4 pl-7 sm:justify-end sm:pl-0">
              <StatusBadge status={review.status} />
              <span className="shrink-0 text-xs text-cg-muted">{pluralize(review.findings?.length || 0, 'finding')}</span>
            </span>
          </button>
        </li>)}
      </ul>}
    </section>
  </div>}
</section><section aria-label="Pull requests" hidden={activeView !== 'pull-requests'} className="min-w-0 space-y-4">
  <header className="flex flex-wrap items-end justify-between gap-4 border-b border-cg-border pb-4">
    <div className="min-w-0">
      <h1 className="text-xl font-semibold text-cg-primary sm:text-2xl">Pull Requests</h1>
      {selectedRepo && <p className="mt-1 truncate text-xs text-cg-muted">{selectedRepo.fullName || selectedRepo.name}</p>}
      {selectedRepo && !loadingReviews && !reviewsError && <p className="mt-2 text-xs text-cg-muted">{pluralize(pullRequestRevisionGroups.length, 'pull request')} · {pluralize(reviews.length, 'review revision')}</p>}
    </div>
    <div className="flex flex-wrap items-center gap-3">
      {selectedRepoAppConnected && !loadingReviews && !reviewsError && hasActiveReviews(reviews) && <span className="text-xs text-cg-muted" role="status">Reviews updating</span>}
      {selectedRepoAppConnected && !loadingReviews && !reviewsError && <button type="button" onClick={retryReviewHistory} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-cg-muted hover:bg-cg-raised hover:text-cg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh
      </button>}
      {selectedRepo && selectedRepoAppConnected && !loadingReviews && !reviewsError && <div className="relative w-full sm:w-64">
        <label htmlFor="pull-request-search" className="sr-only">Search pull requests</label>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cg-muted" aria-hidden="true" />
        <input id="pull-request-search" type="search" value={pullRequestSearch} onChange={event => setPullRequestSearch(event.target.value)} placeholder="Search pull requests…" className="w-full rounded-md border border-cg-border bg-cg-surface py-2 pl-8 pr-3 text-xs text-cg-primary placeholder:text-cg-muted focus:border-blue-400/60 focus:outline-none focus:ring-2 focus:ring-blue-400/20" />
      </div>}
    </div>
  </header>
  {!selectedRepo ? <SelectRepositoryPrompt onBrowse={() => setActiveView('repositories')} /> : !selectedRepoAppConnected ? <ConnectRepositoryPrompt repository={selectedRepo} onConnect={() => setActiveView('repositories')} /> : loadingReviews ? <LoadingPanel label="Loading pull request reviews…" /> : reviewsError ? <ErrorPanel message={reviewsError} onRetry={retryReviewHistory} /> : pullRequestRevisionGroups.length === 0 ? <EmptyPanel title="No pull requests reviewed" message="A pull request appears here after a supported event is received and a review is saved." /> : visiblePullRequestRevisionGroups.length === 0 ? <EmptyPanel title="No matching pull requests" message="Try another PR number, commit SHA, status, category or file path." /> : <div className="min-w-0 overflow-x-auto rounded-lg border border-cg-border">
    <table className="w-full min-w-[900px] table-fixed border-collapse text-left">
      <caption className="sr-only">Pull request reviews for {selectedRepo.fullName || selectedRepo.name}</caption>
      <thead className="bg-cg-surface text-[11px] font-medium text-cg-muted">
        <tr className="border-b border-cg-border">
          <th scope="col" className="w-[32%] px-3 py-2.5 sm:px-4">PR / Title</th>
          <th scope="col" className="w-[15%] px-3 py-2.5 sm:px-4">Repository</th>
          <th scope="col" className="w-[22%] px-3 py-2.5 sm:px-4">Branch</th>
          <th scope="col" className="w-[21%] px-3 py-2.5 sm:px-4">Status</th>
          <th scope="col" className="w-[10%] px-3 py-2.5 sm:px-4">Activity</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-cg-border">
        {visiblePullRequestRevisionGroups.map(group => <PullRequestTableRow
          key={group.prNumber}
          group={group}
          repository={selectedRepo}
          metadata={selectedRepositoryMetadata[String(group.prNumber)]?.metadata}
          onOpenReview={review => openReviewDetails(review, 'pull-requests')}
          onRetryReview={handleRetryReview}
          retryingReviewId={retryingReviewId}
          reviewRetryError={reviewRetryError}
          onRetryPublication={handleRetryPublication}
          retryingPublicationId={retryingPublicationId}
          publicationRetryError={publicationRetryError}
        />)}
      </tbody>
    </table>
  </div>}
</section><section aria-label="Review analytics" hidden={activeView !== 'analytics'} className="min-w-0 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cg-border pb-3">
                <h1 className="text-xl font-semibold text-cg-primary sm:text-2xl">Analytics</h1>
                <div role="group" aria-label="Date range filter" className="flex flex-wrap items-center gap-1 rounded-lg border border-cg-border bg-cg-surface p-1">
                  {[{ value: 'all', label: 'All time' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }, { value: '90d', label: '90 days' }].map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setAnalyticsDateFilter(opt.value)}
                      aria-pressed={analyticsDateFilter === opt.value}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${analyticsDateFilter === opt.value ? 'border border-blue-400/25 bg-blue-500/15 text-blue-200' : 'border border-transparent text-cg-muted hover:bg-cg-raised hover:text-cg-primary'}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              {!selectedRepo ? <SelectRepositoryPrompt onBrowse={() => setActiveView('repositories')} /> : !selectedRepoAppConnected ? <ConnectRepositoryPrompt repository={selectedRepo} onConnect={() => setActiveView('repositories')} /> : loadingReviews ? <LoadingPanel label="Loading review statistics…" /> : reviewsError ? <ErrorPanel message={reviewsError} onRetry={retryReviewHistory} /> : <>
                <dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-y border-cg-border py-3 sm:grid-cols-3 xl:grid-cols-6" aria-label="Review analytics overview">
                  <div><dt className="text-[13px] text-cg-muted">Unique PRs</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-cg-primary">{reviewAnalytics.uniquePullRequestCount}</dd></div>
                  <div><dt className="text-[13px] text-cg-muted">Review revisions</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-cg-primary">{reviewAnalytics.totalReviewRevisions}</dd></div>
                  <div><dt className="text-[13px] text-cg-muted">Completed revisions</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-cg-primary">{reviewAnalytics.completedReviewCount}</dd></div>
                  <div><dt className="text-[13px] text-cg-muted">Finding occurrences</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-cg-primary">{reviewAnalytics.completedFindingCount}</dd></div>
                  <div><dt className="text-[13px] text-cg-muted">Average findings per PR</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-cg-primary">{reviewAnalytics.averageFindingsPerPullRequest === null ? '—' : reviewAnalytics.averageFindingsPerPullRequest.toFixed(1)}</dd></div>
                  <div><dt className="text-[13px] text-cg-muted">Success rate</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-cg-primary">{reviewAnalytics.terminalSuccessRate === null ? '—' : `${reviewAnalytics.terminalSuccessRate.toFixed(1)}%`}</dd></div>
                </dl>
                <p className="-mt-3 text-xs text-cg-muted">Finding occurrences count detections across completed revisions; repeated detections are counted again.</p>
                {reviewAnalytics.totalReviewRevisions < 5 ? <p className="py-10 text-center text-sm text-cg-muted">More review activity is needed to show useful breakdowns.</p> : <div className="space-y-5">
                  <ReviewActivityChart activity={reviewAnalytics.activity} />
                  <div className="grid gap-6 lg:grid-cols-2">
                    <AnalyticsDistribution title="Findings by severity" caption="Occurrences in completed reviews" items={[...SEVERITY_ORDER, 'other'].map(severity => ({
                      label: severity === 'other' ? 'Other' : severity.charAt(0).toUpperCase() + severity.slice(1),
                      count: reviewAnalytics.severityCounts[severity] || 0
                    }))} emptyMessage="No findings are attached to completed reviews." colorByLabel={Object.fromEntries(Object.entries(SEVERITY_CHART_COLORS).map(([severity, color]) => [severity === 'other' ? 'Other' : severity.charAt(0).toUpperCase() + severity.slice(1), color]))} />
                    <AnalyticsDistribution title="Findings by category" caption="Occurrences in completed reviews" items={reviewAnalytics.categories} emptyMessage="No finding categories are available in completed reviews." />
                  </div>
                  <div className="grid gap-6 lg:grid-cols-2">
                    <RepositoryInsights items={reviewAnalytics.repositoryInsights} />
                    <FrequentlyFlaggedFiles files={reviewAnalytics.files} />
                  </div>
                </div>}
              </>}
            </section>            <section aria-label="CodeGuard settings" hidden={activeView !== 'settings'} className="min-w-0 space-y-4">
  <header className="border-b border-cg-border pb-4">
    <h1 className="text-xl font-semibold text-cg-primary">Settings</h1>
    <p className="mt-1 text-sm text-cg-muted">Manage the GitHub connections used by CodeGuard.</p>
  </header>

  <div className="grid min-w-0 gap-3 lg:grid-cols-2">
    <section className="min-w-0 rounded-xl border border-cg-border bg-cg-surface p-4" aria-labelledby="settings-oauth-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <FaGithub className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
          <div>
            <h2 id="settings-oauth-heading" className="text-sm font-semibold text-cg-primary">GitHub account · OAuth</h2>
            <p className="mt-0.5 text-xs text-cg-muted">Sign-in and account repository discovery</p>
          </div>
        </div>
        {loadingRepos ? <span className="text-xs text-cg-muted">Checking access…</span> : repoError ? <span className={'text-xs font-medium ' + (repoReauthRequired ? 'text-amber-300' : 'text-red-300')}>{repoReauthRequired ? 'Reconnect needed' : 'Unavailable'}</span> : <span className="text-xs font-medium text-emerald-300">Connected</span>}
      </div>
      {repoError ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2" role="alert"><p className="text-xs text-red-100">{repoError}</p><div className="flex shrink-0 items-center gap-3">{repoReauthRequired && <a href={apiUrl('/api/auth/github')} className="text-xs font-semibold text-blue-300 hover:text-blue-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">Reconnect</a>}<button type="button" onClick={() => setRepoRetry(attempt => attempt + 1)} className="inline-flex items-center gap-1 text-xs font-medium text-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry</button></div></div> : loadingRepos ? <p className="mt-3 flex items-center gap-2 text-xs text-cg-muted" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300" aria-hidden="true" /> Checking the connected GitHub account…</p> : <p className="mt-3 text-xs text-cg-muted">{repos.length ? repos.length + ' repositories returned on this page.' : 'No repositories returned on this page.'}</p>}
      <div className="mt-4 border-t border-cg-border pt-3">
        <p className="text-xs text-cg-muted">OAuth account access is separate from GitHub App installation access.</p>
        <button type="button" onClick={() => setActiveView('repositories')} className="mt-3 rounded-md border border-cg-border px-3 py-1.5 text-xs font-medium text-cg-primary hover:bg-cg-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">Browse repositories</button>
      </div>
    </section>

    <section className="min-w-0 rounded-xl border border-cg-border bg-cg-surface p-4" aria-labelledby="settings-app-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <FaGithub className="h-4 w-4 shrink-0 text-blue-300" aria-hidden="true" />
          <div>
            <h2 id="settings-app-heading" className="text-sm font-semibold text-cg-primary">GitHub App</h2>
            <p className="mt-0.5 text-xs text-cg-muted">Installation access for connected repositories</p>
          </div>
        </div>
        <button type="button" onClick={handleStartGitHubAppInstall} disabled={startingAppInstall} className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:cursor-wait disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
          {startingAppInstall ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />}
          {startingAppInstall ? 'Opening GitHub…' : installations.length ? 'Manage installation' : 'Install GitHub App'}
        </button>
      </div>
      {githubAppNotice && <p className="mt-3 rounded-md border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-100" role="status">{githubAppNotice}</p>}
      {loadingInstallations ? <p className="mt-3 flex items-center gap-2 text-xs text-cg-muted" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300" aria-hidden="true" /> Checking linked installations…</p> : installationError ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2" role="alert"><p className="text-xs text-red-100">{installationError}</p><button type="button" onClick={() => setInstallationRetry(attempt => attempt + 1)} className="inline-flex items-center gap-1 text-xs font-medium text-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry</button></div> : installations.length === 0 ? <p className="mt-3 text-xs text-cg-muted">No installation is linked to this CodeGuard account.</p> : <ul className="mt-3 divide-y divide-cg-border border-y border-cg-border">
        {installations.map(installation => <li key={installation.installationId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
          <span className="min-w-0 truncate text-cg-primary">{installation.accountLogin}{installation.accountName ? ' · ' + installation.accountName : ''}</span>
          <span className={'shrink-0 font-medium ' + (installation.status === 'active' ? 'text-emerald-300' : 'text-amber-300')}>{installation.status}</span>
        </li>)}
      </ul>}
      {selectedInstallation && !installationError && <p className="mt-2 text-xs text-cg-muted">Selected for repository browsing: {selectedInstallation.accountLogin}</p>}
      <button type="button" onClick={() => setActiveView('repositories')} className="mt-3 rounded-md border border-cg-border px-3 py-1.5 text-xs font-medium text-cg-primary hover:bg-cg-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">Manage repositories</button>
    </section>
  </div>
</section><section aria-label="Pull request review workspace" hidden={activeView !== 'review-details'} className="min-w-0 space-y-5">              {!selectedReview ? <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 sm:p-8">                  <h1 className="mt-2 text-lg font-semibold text-white">Review not found</h1>                  <p className="mt-2 text-sm leading-relaxed text-slate-400">This review is no longer present in the selected repository’s loaded history.</p>                  <button type="button" onClick={returnFromReviewDetails} className="mt-4 rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">                    Back to {reviewDetailsReturnView === 'dashboard' ? 'Dashboard' : 'Pull Requests'}                  </button>                </div> : <>                  <header className="space-y-3 border-b border-cg-border pb-4" aria-labelledby="review-workspace-heading">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <button type="button" onClick={returnFromReviewDetails} className="text-xs font-medium text-cg-muted hover:text-cg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">← Back to {reviewDetailsReturnView === 'dashboard' ? 'Dashboard' : 'Pull Requests'}</button>
                      {selectedRepo?.url && Number.isInteger(selectedReview.prNumber) && <a href={`${selectedRepo.url}/pull/${selectedReview.prNumber}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">Open PR <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></a>}
                    </div>
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-xs text-cg-muted">{selectedRepo?.fullName || selectedRepo?.name || 'Repository unavailable'}</p>
                        <h1 id="review-workspace-heading" className="mt-1 text-base font-semibold leading-snug text-cg-primary sm:text-lg">{selectedReviewMetadata?.title || `Pull request #${selectedReview.prNumber}`}</h1>
                      </div>
                      <div className="flex items-center gap-2">
                        {selectedReview.commitSha && <span className="inline-flex items-center gap-1.5 rounded-md border border-cg-border bg-cg-surface px-2 py-1.5 font-mono text-[11px] text-cg-muted" title={selectedReview.commitSha}><GitBranch className="h-3 w-3" aria-hidden="true" />{shortSha(selectedReview.commitSha)}</span>}
                        <span className="rounded-md border border-cg-border px-2 py-1 text-xs tabular-nums text-cg-muted">#{selectedReview.prNumber}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-cg-border/70 pt-2.5">
                      <StatusBadge status={selectedReview.status} />
                      <RelativeTime value={selectedReview.createdAt} />
                      <GitHubPublicationStatus review={selectedReview} compact onRetry={() => handleRetryPublication(selectedReview)} retrying={retryingPublicationId === selectedReview._id} busy={Boolean(retryingPublicationId)} error={publicationRetryError?.reviewId === selectedReview._id ? publicationRetryError.message : ''} />
                    </div>
                  </header>
                  {selectedReview.status === 'failed' && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cg-border pb-4" role="status">
                    <p className="text-sm text-cg-muted">{selectedReview.summary || 'This review did not complete successfully.'}</p>
                    <button type="button" onClick={() => handleRetryReview(selectedReview)} disabled={Boolean(retryingReviewId)} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-cg-border px-3 py-2 text-xs font-medium text-cg-primary transition hover:bg-cg-raised disabled:cursor-wait disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
                      {retryingReviewId === selectedReview._id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                      {retryingReviewId === selectedReview._id ? 'Queueing retry…' : 'Retry review'}
                    </button>
                    {reviewRetryError?.reviewId === selectedReview._id && <p className="w-full text-xs text-red-200" role="alert">{reviewRetryError.message}</p>}
                  </div>}
                  <section className="min-w-0" aria-labelledby="review-findings-heading">
                    <div className="grid min-w-0 overflow-hidden rounded-lg border border-cg-border xl:grid-cols-[minmax(280px,0.29fr)_minmax(0,0.71fr)]">
                      <aside className="flex min-w-0 flex-col border-b border-cg-border xl:h-[min(72vh,760px)] xl:min-h-0 xl:border-b-0 xl:border-r" aria-label="Review findings list">
                        <header className="flex items-center justify-between gap-3 border-b border-cg-border bg-cg-surface px-3 py-3">
                          <h2 id="review-findings-heading" className="text-sm font-semibold text-cg-primary">Review Findings</h2>
                          <span className="rounded-md border border-cg-border bg-cg-raised px-2 py-1 text-xs tabular-nums text-cg-primary">{selectedReviewFindings.length}</span>
                        </header>
                        {selectedReviewFindings.length === 0 ? <div className="px-3 py-5" role="status">
                          <p className="text-sm font-medium text-cg-primary">{selectedReview.status === 'completed' ? 'No findings recorded' : selectedReview.status === 'failed' ? 'Findings unavailable' : selectedReview.status === 'stale' ? 'Review superseded' : 'Review in progress'}</p>
                          <p className="mt-1 text-xs leading-relaxed text-cg-muted">{selectedReview.status === 'completed' ? 'This review completed without saved findings.' : selectedReview.status === 'failed' ? 'The review did not complete successfully.' : selectedReview.status === 'stale' ? 'Open the latest revision to see current results.' : 'Findings will appear when analysis completes.'}</p>
                        </div> : <div className="max-h-[40vh] space-y-1.5 overflow-y-auto p-2 xl:max-h-none xl:flex-1 xl:min-h-0">
                          {sortedSelectedReviewFindings.map(({ finding }, index) => {
                            const location = `${finding.filePath || 'File path unavailable'}${Number.isInteger(finding.lineNumber) ? `:${finding.lineNumber}` : ''}`;
                            const category = typeof finding.category === 'string' ? finding.category.replaceAll('_', ' ') : '';
                            const severity = typeof finding.severity === 'string' ? finding.severity : 'other';
                            const severityClass = SEVERITY_BADGE_CLASSES[severity] || 'border-slate-400/20 bg-slate-500/10 text-slate-300';
                            return <button
                              key={finding._id || `${finding.filePath || 'file'}-${finding.lineNumber ?? 'line'}-${index}`}
                              type="button"
                              aria-pressed={selectedFinding === finding}
                              onClick={() => setSelectedFindingIndex(index)}
                              className={`flex w-full min-w-0 items-start justify-between gap-2 rounded-lg border border-l-2 px-2.5 py-2.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 ${selectedFinding === finding ? 'border-blue-400/35 border-l-blue-400 bg-cg-raised' : 'border-transparent border-l-transparent hover:bg-cg-raised/65'}`}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block line-clamp-2 text-[13px] font-semibold leading-snug text-cg-primary">{getFindingTitle(finding)}</span>
                                <span className="mt-1.5 block truncate font-mono text-[11px] text-cg-muted" title={location}>{location}</span>
                                {category && <span className="mt-1 block text-[11px] capitalize text-cg-muted">{category}</span>}
                              </span>
                              <span className={`shrink-0 rounded-md border px-2 py-1 text-[10px] font-medium capitalize ${severityClass}`}>{severity}</span>
                            </button>;
                          })}
                        </div>}
                      </aside>
                      <div className="min-w-0 p-3 sm:p-4 xl:p-5">
                        {selectedFinding ? <>
                          <header className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-cg-border pb-3">
                            <div className="min-w-0">
                              <h3 className="truncate text-sm font-semibold text-cg-primary">{getFindingTitle(selectedFinding)}</h3>
                              <p className="mt-1 break-all font-mono text-[11px] text-cg-muted">
                                {selectedFinding.filePath || 'File path unavailable'}{Number.isInteger(selectedFinding.lineNumber) ? `:${selectedFinding.lineNumber}` : ''}
                              </p>
                            </div>
                            {selectedFinding.category && <span className="shrink-0 rounded border border-cg-border px-2 py-1 text-[10px] capitalize text-cg-muted">{selectedFinding.category.replaceAll('_', ' ')}</span>}
                          </header>
                          <ReviewFindingDetails finding={selectedFinding} />
                        </> : <div className="flex min-h-64 flex-col items-center justify-center py-10 text-center" role="status">
                          <h3 className="text-sm font-semibold text-cg-primary">{selectedReview.status === 'completed' ? 'No findings in this review' : selectedReview.status === 'failed' ? 'Findings unavailable' : selectedReview.status === 'stale' ? 'This revision is out of date' : 'Review in progress'}</h3>
                          <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-cg-muted">{selectedReview.status === 'completed' ? 'The review completed without saved findings.' : selectedReview.status === 'failed' ? 'Analysis did not complete, so findings are not available.' : selectedReview.status === 'stale' ? 'Open the latest revision to view the current review.' : 'Findings will appear here when the review finishes.'}</p>
                        </div>}
                      </div>
                    </div>
                  </section></>}            </section>          </div>        </div>      </main>    </div>;
}
