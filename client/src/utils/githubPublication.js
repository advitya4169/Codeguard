const PUBLICATION_PRESENTATION = {
  pending: {
    label: 'Pending',
    description: 'The review is complete and GitHub publication is still in progress.',
    style: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
  },
  published: {
    label: 'Published',
    description: 'GitHub publication completed.',
    style: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
  },
  duplicate: {
    label: 'Already published',
    description: 'An existing CodeGuard publication was found for this commit.',
    style: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
  },
  failed: {
    label: 'Failed',
    description: 'Analysis and findings are saved, but GitHub publication failed.',
    style: 'border-red-400/20 bg-red-400/10 text-red-300',
  },
  uncertain: {
    label: 'Needs verification',
    description: 'GitHub may have accepted the publication. Check the pull request before taking further action.',
    style: 'border-orange-400/20 bg-orange-400/10 text-orange-300',
  },
  stale: {
    label: 'Stale revision',
    description: 'The pull request advanced, so this older review was not published.',
    style: 'border-slate-500/30 bg-slate-800 text-slate-300',
  },
  not_needed: {
    label: 'Not applicable',
    description: 'No GitHub publication was needed for this review.',
    style: 'border-slate-500/30 bg-slate-800 text-slate-300',
  },
};

export const getGitHubPublicationPresentation = (status, reviewStatus = 'completed') => {
  if (reviewStatus !== 'completed') {
    return {
      label: 'Not attempted',
      description: 'GitHub publication is available after the review analysis completes.',
      style: 'border-slate-600 bg-slate-800 text-slate-300',
    };
  }

  return PUBLICATION_PRESENTATION[status] || {
  label: 'Not recorded',
  description: 'No GitHub publication status is available for this review.',
  style: 'border-slate-600 bg-slate-800 text-slate-300',
  };
};

export const canRetryGitHubPublication = (review) => (
  review?.status === 'completed' && review.githubPublicationStatus === 'failed'
);

export const getGitHubPublicationUrl = (value) => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : null;
  } catch {
    return null;
  }
};
