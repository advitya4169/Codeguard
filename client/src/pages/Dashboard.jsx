import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BookMarked,
  CalendarDays,
  CheckCircle,
  CircleDot,
  Clock3,
  Code2,
  FileCode2,
  GitCommitHorizontal,
  GitPullRequest,
  Info,
  Loader2,
  LogOut,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { FaGithub } from 'react-icons/fa';
import { apiUrl } from '../config/api.js';
import { filterRepositories } from '../utils/filterRepositories.js';
import { hasActiveReviews } from '../utils/reviews.js';
import { requestReviewHistory } from '../utils/reviewHistory.js';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'suggestion'];
const REVIEW_POLL_INTERVAL_MS = 5000;

const GITHUB_APP_CALLBACK_MESSAGES = {
  connected: 'GitHub App connected. Choose an installation repository below to enable reviews.',
  cancelled: 'GitHub App setup was canceled. You can start again whenever you’re ready.',
  invalid_state: 'The GitHub App setup link expired or was already used. Start the connection again.',
  verification_failed: 'GitHub could not verify the installation. Check the App installation and try again.',
  account_mismatch: 'The GitHub App installation belongs to a different GitHub account than your CodeGuard login.',
  already_connected: 'That GitHub App installation is already associated with another CodeGuard account.',
  error: 'GitHub App setup could not be completed. Please try again.',
};

const SEVERITY_CONFIG = {
  critical: { Icon: ShieldAlert, label: 'Critical', badge: 'border-red-400/20 bg-red-400/10 text-red-300', rail: 'border-l-red-400' },
  high: { Icon: AlertTriangle, label: 'High', badge: 'border-orange-400/20 bg-orange-400/10 text-orange-300', rail: 'border-l-orange-400' },
  medium: { Icon: AlertTriangle, label: 'Medium', badge: 'border-amber-400/20 bg-amber-400/10 text-amber-300', rail: 'border-l-amber-400' },
  low: { Icon: Info, label: 'Low', badge: 'border-sky-400/20 bg-sky-400/10 text-sky-300', rail: 'border-l-sky-400' },
  suggestion: { Icon: CheckCircle, label: 'Suggestion', badge: 'border-slate-500/40 bg-slate-800 text-slate-300', rail: 'border-l-slate-500' },
};

const REVIEW_STATUS_CONFIG = {
  queued: { label: 'Queued', Icon: Clock3, style: 'border-amber-400/20 bg-amber-400/10 text-amber-300' },
  processing: { label: 'In progress', Icon: Activity, style: 'border-indigo-400/20 bg-indigo-400/10 text-indigo-300' },
  completed: { label: 'Completed', Icon: CheckCircle, style: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' },
  failed: { label: 'Failed', Icon: AlertCircle, style: 'border-red-400/20 bg-red-400/10 text-red-300' },
};

const formatDate = (value) => {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Date unavailable'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

function SeverityBadge({ severity }) {
  const config = SEVERITY_CONFIG[severity] || {
    Icon: Info,
    label: severity || 'Unspecified',
    badge: 'border-slate-600 bg-slate-800 text-slate-300',
  };
  const { Icon } = config;

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${config.badge}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {config.label}
    </span>
  );
}

function ReviewStatus({ status }) {
  const config = REVIEW_STATUS_CONFIG[status] || {
    label: status || 'Unknown status',
    Icon: CircleDot,
    style: 'border-slate-600 bg-slate-800 text-slate-300',
  };
  const { Icon } = config;

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${config.style}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {config.label}
    </span>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  
  // Sidebar State
  const [repos, setRepos] = useState([]);
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [repoError, setRepoError] = useState('');
  const [repoReauthRequired, setRepoReauthRequired] = useState(false);
  const [repoRetry, setRepoRetry] = useState(0);
  const [repoPage, setRepoPage] = useState(1);
  const [repoHasNextPage, setRepoHasNextPage] = useState(false);
  const [repoSearch, setRepoSearch] = useState('');
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [connectingRepoId, setConnectingRepoId] = useState(null);
  const [connectError, setConnectError] = useState('');

  // GitHub App installation and repository selection state.
  const [githubAppNotice, setGithubAppNotice] = useState(() => {
    const result = new URLSearchParams(window.location.search).get('github_app');
    return result
      ? GITHUB_APP_CALLBACK_MESSAGES[result] || 'GitHub App setup returned an unrecognized result. Please try again.'
      : '';
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
  const [appRepoSearch, setAppRepoSearch] = useState('');
  const [connectingAppRepoId, setConnectingAppRepoId] = useState(null);
  const [appConnectError, setAppConnectError] = useState('');

  // Main Content State
  const [reviews, setReviews] = useState([]);
  const [loadingReviews, setLoadingReviews] = useState(false);
  const [reviewsError, setReviewsError] = useState('');
  const [reviewsRetry, setReviewsRetry] = useState(0);

  const handleUnauthorized = useCallback(() => {
    localStorage.removeItem('codeguard_token');
    navigate('/login', { replace: true });
  }, [navigate]);

  // Callback query values are mapped to fixed, user-safe messages and removed
  // from the address bar immediately.
  useEffect(() => {
    const result = searchParams.get('github_app');
    if (!result) return;

    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('github_app');
      return next;
    }, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const controller = new AbortController();
    const fetchInstallations = async () => {
      setLoadingInstallations(true);
      setInstallationError('');
      try {
        const token = localStorage.getItem('codeguard_token');
        const response = await fetch(apiUrl('/api/github/app/installations'), {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        let data = {};
        try { data = await response.json(); } catch { /* status is reported below */ }
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
        setSelectedInstallationId((current) => (
          data.installations.some((item) => item.installationId === current && item.status === 'active')
            ? current
            : data.installations.find((item) => item.status === 'active')?.installationId
              || data.installations[0]?.installationId
              || ''
        ));
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

  const selectedInstallation = installations.find(
    (installation) => installation.installationId === selectedInstallationId,
  );

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
        const response = await fetch(apiUrl(
          `/api/github/app/installations/${encodeURIComponent(selectedInstallationId)}/repos?page=${appRepoPage}`,
        ), {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        let data = {};
        try { data = await response.json(); } catch { /* status is reported below */ }
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
        setAppRepos(data.repositories.map((repository) => ({
          ...repository,
          connectionType: repository.connected ? repository.connectionType || 'github_app' : null,
          installationId: repository.connected
            ? repository.installationId
            : selectedInstallationId,
        })));
        setAppRepoHasNextPage(Boolean(data.pagination?.hasNextPage));
      } catch (error) {
        if (error.name !== 'AbortError') {
          setAppRepos([]);
          setAppRepoHasNextPage(false);
          setAppRepoError(error.message || 'Could not load App repositories.');
        }
      } finally {
        if (!controller.signal.aborted) setLoadingAppRepos(false);
      }
    };
    fetchAppRepositories();
    return () => controller.abort();
  }, [selectedInstallationId, selectedInstallation?.status, appRepoPage, appRepoRetry, handleUnauthorized]);

  const filteredAppRepos = filterRepositories(appRepos, appRepoSearch);

  // Fetch Repositories on mount
  useEffect(() => {
    const controller = new AbortController();

    const fetchRepos = async () => {
      setLoadingRepos(true);
      setRepoError('');
      setRepoReauthRequired(false);

      try {
        const token = localStorage.getItem('codeguard_token');
        const response = await fetch(apiUrl(`/api/github/repos?page=${repoPage}`), {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: controller.signal,
        });

        let data = {};
        try {
          data = await response.json();
        } catch {
          // A malformed body on an error response is reported below by status.
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

        setRepos(data.repositories);
        setRepoHasNextPage(Boolean(data.pagination?.hasNextPage));
      } catch (err) {
        if (err.name !== 'AbortError') {
          setRepos([]);
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

  const filteredRepos = filterRepositories(repos, repoSearch);
  const selectedRepoUsesApp = Boolean(
    selectedRepo?.connectionType === 'github_app' || selectedRepo?.installationId,
  );

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
  }, [handleUnauthorized]);

  // Fetch saved history when a connected repository is selected or retried.
  useEffect(() => {
    if (!selectedRepo?.connected) return undefined;

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
  }, [selectedRepo, handleUnauthorized, reviewsRetry, fetchReviewHistory]);

  // Refresh only while persisted reviews report an active worker state.
  useEffect(() => {
    if (!selectedRepo?.connected || !hasActiveReviews(reviews)) return undefined;

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
  }, [selectedRepo, reviews, fetchReviewHistory]);

  const handleLogout = () => {
    localStorage.removeItem('codeguard_token');
    navigate('/login');
  };

  const retryReviewHistory = () => {
    setReviews([]);
    setReviewsError('');
    setLoadingReviews(true);
    setReviewsRetry((attempt) => attempt + 1);
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
          Accept: 'application/json',
        },
      });
      let data = {};
      try { data = await response.json(); } catch { /* status is reported below */ }
      if (response.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || `Could not start GitHub App setup (HTTP ${response.status}).`);
      }

      const destination = new URL(data.redirectUrl);
      if (
        destination.origin !== 'https://github.com' ||
        !/^\/apps\/[a-zA-Z0-9-]+\/installations\/new\/?$/.test(destination.pathname) ||
        !destination.searchParams.has('state')
      ) {
        throw new Error('The server returned an invalid GitHub App setup link. Please retry.');
      }
      window.location.assign(destination.toString());
    } catch (error) {
      setGithubAppNotice(error.message || 'Could not start GitHub App setup. Please retry.');
      setStartingAppInstall(false);
    }
  };

  const handleConnectAppRepository = async (repo) => {
    if (!selectedInstallationId || repo.connected) return;
    setConnectingAppRepoId(repo.id);
    setAppConnectError('');
    try {
      const token = localStorage.getItem('codeguard_token');
      const response = await fetch(apiUrl(
        `/api/github/app/installations/${encodeURIComponent(selectedInstallationId)}/repos/connect`,
      ), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ repositoryId: repo.id }),
      });
      let data = {};
      try { data = await response.json(); } catch { /* status is reported below */ }
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
        installationId: selectedInstallationId,
      };
      setAppRepos((current) => current.map((item) => item.id === repo.id ? connectedRepo : item));
      setRepos((current) => current.map((item) => item.id === repo.id
        ? { ...item, connected: true, connectionType: 'github_app', installationId: selectedInstallationId }
        : item));
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

  const handleConnectRepository = async (repo) => {
    setConnectingRepoId(repo.id);
    setConnectError('');

    try {
      const token = localStorage.getItem('codeguard_token');
      const response = await fetch(apiUrl('/api/github/repos/connect'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ repositoryId: repo.id }),
      });

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      let data = {};
      try {
        data = await response.json();
      } catch {
        // The status below still reports a useful error for an invalid body.
      }
      if (!response.ok) {
        throw new Error(data.error || `Could not connect repository (HTTP ${response.status}).`);
      }

      const connectedRepo = { ...repo, connected: true, connectionType: 'oauth' };
      setRepos((currentRepos) => currentRepos.map((item) => (
        item.id === repo.id ? connectedRepo : item
      )));
      if (selectedRepo?.id === repo.id) {
        setReviews([]);
        setReviewsError('');
        setLoadingReviews(true);
        setSelectedRepo(connectedRepo);
      }
    } catch (error) {
      setConnectError(error.message || 'Could not connect repository.');
    } finally {
      setConnectingRepoId(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#090e1b] font-sans text-slate-100 selection:bg-indigo-500/30">
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-40 left-1/3 h-96 w-96 rounded-full bg-indigo-600/10 blur-[120px]" />
        <div className="absolute -right-48 top-1/3 h-96 w-96 rounded-full bg-violet-600/5 blur-[120px]" />
      </div>

      <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-[#090e1b]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-indigo-400/20 bg-indigo-500/10">
              <Code2 className="h-5 w-5 text-indigo-300" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-tight text-white">CodeGuard</p>
              <p className="hidden text-[10px] uppercase tracking-[0.18em] text-slate-500 sm:block">Review workspace</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-2 rounded-full border border-slate-800 bg-slate-900/70 px-3 py-1.5 text-xs text-slate-400 sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
              Authenticated
            </span>
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700/80 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-slate-600 hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="relative mx-auto grid max-w-[1600px] gap-5 px-4 py-5 sm:px-6 sm:py-7 lg:grid-cols-[280px_minmax(0,1fr)] lg:px-8">
        {githubAppNotice && (
          <div
            className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm lg:col-span-2 ${githubAppNotice.startsWith('GitHub App connected.') ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-100' : 'border-indigo-400/20 bg-indigo-400/5 text-indigo-100'}`}
            role="status"
            aria-live="polite"
          >
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{githubAppNotice}</span>
            <button
              type="button"
              onClick={() => setGithubAppNotice('')}
              className="ml-auto rounded px-1 text-xs text-slate-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              aria-label="Dismiss GitHub App message"
            >
              Dismiss
            </button>
          </div>
        )}
        <aside className="h-fit rounded-2xl border border-slate-800/90 bg-slate-950/75 shadow-xl shadow-black/10 lg:sticky lg:top-[84px]">
          <div className="border-b border-slate-800/80 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">GitHub App</h2>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  Install the App to choose repositories for CodeGuard PR reviews.
                </p>
              </div>
              <FaGithub className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" aria-hidden="true" />
            </div>
            <button
              type="button"
              onClick={handleStartGitHubAppInstall}
              disabled={startingAppInstall}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-violet-400/20 bg-violet-500/10 px-3 py-2 text-xs font-semibold text-violet-200 transition hover:border-violet-300/40 hover:bg-violet-500/15 disabled:cursor-wait disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
            >
              {startingAppInstall ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />}
              {startingAppInstall ? 'Opening GitHub…' : installations.length ? 'Install or manage GitHub App' : 'Install GitHub App'}
            </button>

            {loadingInstallations ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-slate-500" role="status">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" aria-hidden="true" /> Checking App installations…
              </p>
            ) : installationError ? (
              <div className="mt-3 rounded-lg border border-red-400/20 bg-red-400/5 p-3" role="alert">
                <p className="text-xs leading-relaxed text-red-100">{installationError}</p>
                <button
                  type="button"
                  onClick={() => setInstallationRetry((attempt) => attempt + 1)}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-indigo-300 hover:text-indigo-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry
                </button>
              </div>
            ) : installations.length === 0 ? (
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                No GitHub App installation is linked yet. Install the App, then return here to choose repositories.
              </p>
            ) : (
              <>
                <label htmlFor="github-app-installation" className="mt-3 block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Installation
                </label>
                <select
                  id="github-app-installation"
                  value={selectedInstallationId}
                  onChange={(event) => {
                    setSelectedInstallationId(event.target.value);
                    setAppRepoPage(1);
                    setAppRepoSearch('');
                    setAppConnectError('');
                    setAppRepos([]);
                    setAppRepoHasNextPage(false);
                    setAppRepoError('');
                  }}
                  className="mt-1.5 w-full rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-2 text-xs text-slate-200 focus:border-indigo-400/50 focus:outline-none focus:ring-2 focus:ring-indigo-400/20"
                >
                  {installations.map((installation) => (
                    <option key={installation.installationId} value={installation.installationId}>
                      {installation.accountLogin} · {installation.status}
                    </option>
                  ))}
                </select>

                {selectedInstallation?.status !== 'active' ? (
                  <div className="mt-3 rounded-lg border border-amber-400/15 bg-amber-400/5 p-3">
                    <p className="text-xs leading-relaxed text-amber-100">
                      This installation is {selectedInstallation?.status || 'unavailable'} and cannot provide repositories. Reinstall or restore the App access in GitHub.
                    </p>
                  </div>
                ) : (
                  <>
                    <label htmlFor="app-repository-search" className="sr-only">Search GitHub App repositories on this page</label>
                    <div className="relative mt-3">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" aria-hidden="true" />
                      <input
                        id="app-repository-search"
                        type="search"
                        value={appRepoSearch}
                        onChange={(event) => {
                          setAppRepoSearch(event.target.value);
                          setAppRepoPage(1);
                        }}
                        placeholder="Search App repositories…"
                        className="w-full rounded-lg border border-slate-800 bg-slate-900/70 py-2 pl-8 pr-2.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-indigo-400/50 focus:outline-none focus:ring-2 focus:ring-indigo-400/20"
                      />
                    </div>
                    {loadingAppRepos ? (
                      <p className="mt-3 flex items-center gap-2 text-xs text-slate-500" role="status">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" aria-hidden="true" /> Loading installation repositories…
                      </p>
                    ) : appRepoError ? (
                      <div className="mt-3 rounded-lg border border-red-400/20 bg-red-400/5 p-3" role="alert">
                        <p className="text-xs leading-relaxed text-red-100">{appRepoError}</p>
                        <button
                          type="button"
                          onClick={() => setAppRepoRetry((attempt) => attempt + 1)}
                          className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-indigo-300 hover:text-indigo-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                        >
                          <RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry repository list
                        </button>
                      </div>
                    ) : appRepos.length === 0 ? (
                      <div className="mt-3 rounded-lg border border-dashed border-slate-800 px-3 py-4 text-center" role="status">
                        <p className="text-xs leading-relaxed text-slate-500">
                          {appRepoPage > 1
                            ? `No repositories were returned for page ${appRepoPage}.`
                            : 'This installation has no repositories available. Check its repository access in GitHub or install it for a repository.'}
                        </p>
                        <div className="mt-2 flex justify-center gap-3">
                          {appRepoPage > 1 && <button type="button" onClick={() => setAppRepoPage((page) => Math.max(1, page - 1))} className="text-xs font-medium text-indigo-300 hover:text-indigo-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Previous page</button>}
                          {appRepoHasNextPage && <button type="button" onClick={() => setAppRepoPage((page) => page + 1)} className="text-xs font-medium text-indigo-300 hover:text-indigo-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Next page</button>}
                        </div>
                      </div>
                    ) : (
                      <>
                        <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
                          {filteredAppRepos.map((repo) => (
                            <li key={repo.id} className={`rounded-lg border p-2 ${selectedRepo?.id === repo.id ? 'border-violet-400/30 bg-violet-500/[0.07]' : 'border-slate-800/70 bg-slate-900/40'}`}>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedRepo(repo);
                                  setConnectError('');
                                  setAppConnectError('');
                                  setReviews([]);
                                  setReviewsError('');
                                  setLoadingReviews(repo.connected);
                                }}
                                aria-pressed={selectedRepo?.id === repo.id}
                                className="block w-full truncate rounded text-left text-xs font-medium text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
                              >
                                {repo.fullName}
                              </button>
                              <div className="mt-1 flex items-center justify-between gap-2 pl-0.5">
                                <span className={repo.connected ? 'text-[10px] font-medium uppercase tracking-wide text-emerald-300' : 'text-[10px] text-slate-500'}>
                                  {repo.connected
                                    ? `Connected · ${repo.connectionType === 'github_app' ? 'GitHub App' : 'OAuth'}`
                                    : repo.private ? 'Private' : 'Available'}
                                </span>
                                {!repo.connected && (
                                  <button
                                    type="button"
                                    onClick={() => handleConnectAppRepository(repo)}
                                    disabled={connectingAppRepoId === repo.id}
                                    aria-label={`Connect ${repo.fullName} through GitHub App`}
                                    className="rounded px-2 py-1 text-[10px] font-semibold text-violet-300 hover:bg-violet-400/10 disabled:cursor-wait disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
                                  >
                                    {connectingAppRepoId === repo.id ? 'Connecting…' : 'Connect'}
                                  </button>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                        {filteredAppRepos.length === 0 && (
                          <p className="mt-2 rounded-lg border border-dashed border-slate-800 px-3 py-3 text-center text-[11px] text-slate-500" role="status">
                            No repositories on this page match “{appRepoSearch.trim()}”.
                          </p>
                        )}
                        <div className="mt-2 flex items-center justify-between border-t border-slate-800/80 pt-2">
                          <span className="text-[10px] text-slate-500">App page {appRepoPage}</span>
                          <div className="flex gap-1.5">
                            <button type="button" onClick={() => setAppRepoPage((page) => Math.max(1, page - 1))} disabled={appRepoPage === 1 || loadingAppRepos} className="rounded-md border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Previous</button>
                            <button type="button" onClick={() => setAppRepoPage((page) => page + 1)} disabled={!appRepoHasNextPage || loadingAppRepos} className="rounded-md border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Next</button>
                          </div>
                        </div>
                      </>
                    )}
                    {appConnectError && <p className="mt-2 text-xs leading-relaxed text-red-200" role="alert">{appConnectError}</p>}
                  </>
                )}
              </>
            )}
          </div>
          <div className="flex items-center justify-between border-b border-slate-800/80 px-4 py-4">
            <div className="flex items-center gap-2.5">
              <FaGithub className="h-4 w-4 text-slate-400" aria-hidden="true" />
              <div>
                <h2 className="text-sm font-semibold text-slate-100">Repositories</h2>
                <p className="mt-0.5 text-[11px] text-slate-500">From your GitHub account</p>
              </div>
            </div>
            {!loadingRepos && !repoError && (
              <span className="rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-[11px] tabular-nums text-slate-400">
                {repos.length}
              </span>
            )}
          </div>

          <div className="p-3 sm:p-4">
            {loadingRepos ? (
              <div className="flex items-center gap-2 rounded-lg bg-slate-900/70 px-3 py-4 text-sm text-slate-400" role="status" aria-live="polite">
                <Loader2 className="h-4 w-4 animate-spin text-indigo-400" aria-hidden="true" />
                Loading repositories…
              </div>
            ) : repoError ? (
              <div className="rounded-xl border border-red-400/20 bg-red-400/5 p-4" role="alert">
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-medium text-red-200">Repositories unavailable</p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">{repoError}</p>
                    {repoReauthRequired && (
                      <a
                        href={apiUrl('/api/auth/github')}
                        className="mt-3 inline-flex rounded text-xs font-semibold text-indigo-300 hover:text-indigo-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                      >
                        Reconnect GitHub
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => setRepoRetry((attempt) => attempt + 1)}
                      className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-indigo-300 hover:text-indigo-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                    >
                      <RefreshCw className="h-3 w-3" aria-hidden="true" /> Try again
                    </button>
                  </div>
                </div>
              </div>
            ) : repos.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-800 px-4 py-7 text-center">
                <BookMarked className="mx-auto h-5 w-5 text-slate-600" aria-hidden="true" />
                <p className="mt-2 text-sm font-medium text-slate-300">No repositories on this page</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">This GitHub account did not return repositories for page {repoPage}.</p>
                {repoPage > 1 && (
                  <button
                    type="button"
                    onClick={() => setRepoPage((page) => Math.max(1, page - 1))}
                    className="mt-3 rounded px-2 py-1 text-xs font-medium text-indigo-300 hover:text-indigo-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                  >
                    Previous page
                  </button>
                )}
                {repoHasNextPage && (
                  <button
                    type="button"
                    onClick={() => setRepoPage((page) => page + 1)}
                    className="mt-3 ml-2 rounded px-2 py-1 text-xs font-medium text-indigo-300 hover:text-indigo-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                  >
                    Next page
                  </button>
                )}
              </div>
            ) : (
              <>
                <label htmlFor="repository-search" className="sr-only">Search repositories on this page</label>
                <div className="relative mb-3">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
                  <input
                    id="repository-search"
                    type="search"
                    value={repoSearch}
                    onChange={(event) => {
                      setRepoSearch(event.target.value);
                      setRepoPage(1);
                    }}
                    placeholder="Search this page…"
                    className="w-full rounded-lg border border-slate-800 bg-slate-900/70 py-2 pl-9 pr-3 text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-400/50 focus:outline-none focus:ring-2 focus:ring-indigo-400/20"
                  />
                  <p className="mt-1 px-1 text-[10px] text-slate-500">Searches the current GitHub results page. Use pagination to browse more.</p>
                </div>
                <div className="mb-2 flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600">
                  <span>Repository list</span>
                  <span>{repos.filter((repo) => repo.connected).length} connected on this page</span>
                </div>
                <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2 lg:mx-0 lg:max-h-[calc(100vh-250px)] lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden lg:px-0 lg:pb-0">
                  {filteredRepos.map((repo) => (
                    <li key={repo.id} className="w-[245px] shrink-0 lg:w-full">
                      <div className={`group rounded-xl border p-2 transition ${selectedRepo?.id === repo.id ? 'border-indigo-400/30 bg-indigo-500/[0.08]' : 'border-transparent bg-slate-900/50 hover:border-slate-800 hover:bg-slate-900'}`}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedRepo(repo);
                            setConnectError('');
                            setReviews([]);
                            setReviewsError('');
                            setLoadingReviews(repo.connected);
                          }}
                          aria-pressed={selectedRepo?.id === repo.id}
                          className="flex w-full items-start gap-2.5 rounded-lg p-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                        >
                          <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${repo.connected ? 'bg-emerald-400/10 text-emerald-300' : 'bg-slate-800 text-slate-400'}`}>
                            {repo.private ? <LockKeyhole className="h-4 w-4" aria-hidden="true" /> : <BookMarked className="h-4 w-4" aria-hidden="true" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-slate-200">{repo.name}</span>
                            <span className="mt-0.5 block truncate text-[11px] text-slate-500">{repo.fullName}</span>
                          </span>
                          <ArrowRight className={`mt-2 h-3.5 w-3.5 shrink-0 transition ${selectedRepo?.id === repo.id ? 'translate-x-0 text-indigo-300 opacity-100' : '-translate-x-1 text-slate-600 opacity-0 group-hover:opacity-100'}`} aria-hidden="true" />
                        </button>
                        <div className="flex items-center justify-between pl-[46px] pr-1">
                          {repo.connected ? (
                            <span className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                              Linked · {repo.connectionType === 'github_app' ? 'GitHub App' : 'OAuth'}
                            </span>
                          ) : (
                            <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Not linked</span>
                          )}
                          {!repo.connected && (
                            <button
                              type="button"
                              onClick={() => handleConnectRepository(repo)}
                              disabled={connectingRepoId === repo.id}
                              aria-label={`Connect ${repo.fullName}`}
                              className="rounded-md px-2 py-1 text-[11px] font-semibold text-indigo-300 transition hover:bg-indigo-400/10 hover:text-indigo-200 disabled:cursor-wait disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                            >
                              {connectingRepoId === repo.id ? 'Connecting…' : 'Connect'}
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                {filteredRepos.length === 0 && (
                  <p className="rounded-lg border border-dashed border-slate-800 px-3 py-4 text-center text-xs text-slate-400" role="status">
                    No repositories on this page match “{repoSearch.trim()}”.
                  </p>
                )}
                <div className="mt-3 flex items-center justify-between border-t border-slate-800/80 pt-3">
                  <span className="text-[11px] text-slate-500">Page {repoPage}</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setRepoPage((page) => Math.max(1, page - 1))}
                      disabled={repoPage === 1 || loadingRepos}
                      className="rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => setRepoPage((page) => page + 1)}
                      disabled={!repoHasNextPage || loadingRepos}
                      className="rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="border-t border-slate-800/80 px-4 py-3">
            <p className="text-[11px] leading-relaxed text-slate-500">
              Connecting associates a repository with your account. It does not install a GitHub webhook.
            </p>
          </div>
        </aside>

        <section className="min-w-0 space-y-5" aria-label="Repository review history">
          <div className="rounded-2xl border border-slate-800/90 bg-slate-950/70 p-5 shadow-xl shadow-black/10 sm:p-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                  <span>Workspace</span>
                  <span className="text-slate-700">/</span>
                  <span className="truncate text-indigo-300">{selectedRepo ? selectedRepo.name : 'Repository overview'}</span>
                </div>
                <h1 className="truncate text-xl font-semibold tracking-tight text-white sm:text-2xl">
                  {selectedRepo ? selectedRepo.fullName : 'Pull request reviews'}
                </h1>
                <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-400">
                  {selectedRepo
                    ? selectedRepo.connected
                      ? `Review history and findings for this repository connected through ${selectedRepoUsesApp ? 'the GitHub App' : 'GitHub OAuth'}.`
                      : `Connect this repository through ${selectedRepoUsesApp ? 'the GitHub App' : 'GitHub OAuth'} to make its review history available here.`
                    : 'Choose a repository to inspect its automated review history.'}
                </p>
              </div>
              {selectedRepo && (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {selectedRepo.connected ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-300">
                      <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Repository linked
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-400">
                      <CircleDot className="h-3.5 w-3.5" aria-hidden="true" /> Not linked
                    </span>
                  )}
                  {selectedRepo.connected && (
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${reviews.length > 0 ? 'border-sky-400/20 bg-sky-400/5 text-sky-200' : 'border-amber-400/20 bg-amber-400/5 text-amber-200'}`}>
                      <CircleDot className="h-3.5 w-3.5" aria-hidden="true" />
                      {reviews.length > 0 ? 'PR event received' : selectedRepoUsesApp ? 'Awaiting first review' : 'Webhook not verified'}
                    </span>
                  )}
                  {selectedRepo.url && (
                    <a
                      href={selectedRepo.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-slate-600 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                    >
                      <FaGithub className="h-3.5 w-3.5" aria-hidden="true" /> GitHub
                      <ArrowUpRight className="h-3 w-3 text-slate-500" aria-hidden="true" />
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>

          {connectError && (
            <div className="flex items-start gap-2.5 rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-200" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden="true" />
              <span>{connectError}</span>
            </div>
          )}

          {selectedRepo?.connected && (
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
              <p className="text-xs font-semibold text-slate-200">
                Connected through {selectedRepoUsesApp ? 'GitHub App' : 'GitHub OAuth'}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                {selectedRepoUsesApp
                  ? 'This connection uses the GitHub App route for pull request events. CodeGuard confirms delivery only when a review appears in the history below.'
                  : 'This legacy OAuth connection does not configure App webhooks. It needs a repository webhook pointing to CodeGuard before pull request reviews can arrive.'}
              </p>
            </div>
          )}

          {!selectedRepo ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-slate-950/40 px-6 py-12 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-indigo-400/15 bg-indigo-400/[0.07]">
                <GitPullRequest className="h-6 w-6 text-indigo-300" aria-hidden="true" />
              </div>
              <h2 className="mt-5 text-base font-semibold text-slate-200">Select a repository</h2>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-slate-500">Choose one from the repository list to see its review activity and findings.</p>
            </div>
          ) : !selectedRepo.connected ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 sm:p-8">
              <div className="mx-auto flex max-w-lg flex-col items-center text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-indigo-400/20 bg-indigo-500/10">
                  <BookMarked className="h-5 w-5 text-indigo-300" aria-hidden="true" />
                </div>
                <h2 className="mt-4 text-lg font-semibold text-white">Connect {selectedRepo.name}</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  {selectedRepoUsesApp
                    ? 'CodeGuard will verify that the selected GitHub App installation can access this repository, then link it to your CodeGuard account.'
                    : 'CodeGuard will verify access through your connected GitHub account and associate this repository with your CodeGuard account.'}
                </p>
                <button
                  type="button"
                  onClick={() => selectedRepoUsesApp
                    ? handleConnectAppRepository(selectedRepo)
                    : handleConnectRepository(selectedRepo)}
                  disabled={(selectedRepoUsesApp ? connectingAppRepoId : connectingRepoId) === selectedRepo.id}
                  className="mt-5 inline-flex items-center gap-2 rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-950/30 transition hover:bg-indigo-400 disabled:cursor-wait disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
                >
                  {(selectedRepoUsesApp ? connectingAppRepoId : connectingRepoId) === selectedRepo.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="h-4 w-4" aria-hidden="true" />}
                  {(selectedRepoUsesApp ? connectingAppRepoId : connectingRepoId) === selectedRepo.id ? 'Verifying access…' : 'Connect repository'}
                </button>
                <p className="mt-4 max-w-md text-xs leading-relaxed text-slate-500">
                  {selectedRepoUsesApp
                    ? 'Supported pull request events can reach CodeGuard through the App webhook. Review arrival is confirmed when a review appears in this dashboard.'
                    : 'This does not install a GitHub webhook. Review events appear only when a webhook is already configured for this repository.'}
                </p>
              </div>
            </div>
          ) : loadingReviews ? (
            <div className="flex min-h-[300px] flex-col items-center justify-center rounded-2xl border border-slate-800 bg-slate-950/50 text-center" role="status" aria-live="polite">
              <Loader2 className="h-7 w-7 animate-spin text-indigo-400" aria-hidden="true" />
              <p className="mt-4 text-sm font-medium text-slate-300">Loading review history</p>
              <p className="mt-1 text-xs text-slate-500">Fetching saved reviews for {selectedRepo.name}…</p>
            </div>
          ) : reviewsError ? (
            <div className="rounded-2xl border border-red-400/20 bg-red-400/[0.04] p-6 sm:p-8" role="alert">
              <div className="mx-auto flex max-w-lg flex-col items-center text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-red-400/20 bg-red-400/10">
                  <AlertCircle className="h-5 w-5 text-red-300" aria-hidden="true" />
                </div>
                <h2 className="mt-4 text-base font-semibold text-red-100">Review history could not be loaded</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">{reviewsError}</p>
                <p className="mt-2 max-w-lg text-xs leading-relaxed text-slate-500">
                  Retrying reloads saved history. It does not retry the analysis or repair webhook or GitHub authorization setup.
                </p>
                <button
                  type="button"
                  onClick={retryReviewHistory}
                  className="mt-5 inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry request
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <div className="flex items-center gap-2 text-xs font-medium text-slate-500"><GitPullRequest className="h-3.5 w-3.5 text-indigo-300" aria-hidden="true" /> Reviews</div>
                  <p className="mt-2 text-2xl font-semibold tabular-nums text-white">{reviews.length}</p>
                  <p className="mt-1 text-[11px] text-slate-500">Saved review jobs</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <div className="flex items-center gap-2 text-xs font-medium text-slate-500"><ShieldAlert className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" /> Findings</div>
                  <p className="mt-2 text-2xl font-semibold tabular-nums text-white">{reviews.reduce((total, review) => total + (Array.isArray(review.findings) ? review.findings.length : 0), 0)}</p>
                  <p className="mt-1 text-[11px] text-slate-500">Across returned reviews</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <div className="flex items-center gap-2 text-xs font-medium text-slate-500"><CalendarDays className="h-3.5 w-3.5 text-violet-300" aria-hidden="true" /> Latest activity</div>
                  <p className="mt-2 truncate text-base font-semibold text-white">{reviews.length ? formatDate(reviews[0].createdAt) : 'No activity yet'}</p>
                  <p className="mt-1 text-[11px] text-slate-500">From saved review history</p>
                </div>
              </div>

              <div className="flex flex-wrap items-end justify-between gap-3 px-1 pt-1">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold text-white">Review history</h2>
                    <span className="rounded-full border border-slate-800 bg-slate-900 px-2 py-0.5 text-[11px] tabular-nums text-slate-400">{reviews.length}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">Pull request analysis saved for this repository</p>
                </div>
                <button
                  type="button"
                  onClick={retryReviewHistory}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-400 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh history
                </button>
              </div>

              {hasActiveReviews(reviews) && (
                <p className="inline-flex items-center gap-2 rounded-lg border border-indigo-400/15 bg-indigo-400/[0.04] px-3 py-2 text-xs text-indigo-200" role="status" aria-live="polite">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  This page refreshes automatically while the review is queued or processing.
                </p>
              )}

              {reviews.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/40 px-6 py-12 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-slate-800 bg-slate-900">
                    <GitPullRequest className="h-5 w-5 text-slate-500" aria-hidden="true" />
                  </div>
                  <h3 className="mt-4 text-sm font-semibold text-slate-200">No reviews in history</h3>
                  <p className="mx-auto mt-1.5 max-w-lg text-xs leading-relaxed text-slate-400">
                    {selectedRepoUsesApp
                      ? 'This repository is connected through the GitHub App. Open a pull request or push a commit to an open pull request to request the first review. CodeGuard will show it here after the App webhook event reaches the review pipeline.'
                      : <>This repository is linked through GitHub OAuth, but webhook delivery has not been verified. To trigger a review, add a webhook in GitHub repository Settings → Webhooks pointing to your deployed CodeGuard URL plus <code className="rounded bg-slate-900 px-1 py-0.5 font-mono text-slate-300">/api/webhooks/github</code>, configure the matching <code className="rounded bg-slate-900 px-1 py-0.5 font-mono text-slate-300">WEBHOOK_SECRET</code>, and subscribe to Pull requests. Then open a pull request or push a commit to an open pull request.</>}
                  </p>
                  <p className="mx-auto mt-2 max-w-lg text-[11px] leading-relaxed text-slate-500">
                    {selectedRepoUsesApp
                      ? 'Installation alone does not prove that an event was delivered; this state changes when a review is recorded.'
                      : 'CodeGuard cannot confirm whether the webhook is installed. Linking a repository does not configure one.'}
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {reviews.map((review) => {
                    const findings = Array.isArray(review.findings) ? review.findings : [];
                    const orderedFindings = [...findings].sort((left, right) => {
                      const leftIndex = SEVERITY_ORDER.indexOf(left.severity);
                      const rightIndex = SEVERITY_ORDER.indexOf(right.severity);
                      return (leftIndex < 0 ? SEVERITY_ORDER.length : leftIndex) - (rightIndex < 0 ? SEVERITY_ORDER.length : rightIndex);
                    });
                    const findingGroups = [];
                    orderedFindings.forEach((finding) => {
                      const severity = SEVERITY_ORDER.includes(finding.severity) ? finding.severity : 'other';
                      let group = findingGroups.find((item) => item.severity === severity);
                      if (!group) {
                        group = { severity, findings: [] };
                        findingGroups.push(group);
                      }
                      group.findings.push(finding);
                    });

                    return (
                      <article key={review._id} className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/75 shadow-lg shadow-black/10">
                        <div className="flex flex-col gap-4 border-b border-slate-800/80 bg-slate-900/55 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                          <div className="flex min-w-0 items-start gap-3">
                            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-indigo-400/15 bg-indigo-400/[0.07]">
                              <GitPullRequest className="h-4 w-4 text-indigo-300" aria-hidden="true" />
                            </div>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="text-sm font-semibold text-white">Pull request #{review.prNumber}</h3>
                                <ReviewStatus status={review.status} />
                              </div>
                              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
                                <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3 w-3" aria-hidden="true" />{formatDate(review.createdAt)}</span>
                                {review.commitSha && <span className="inline-flex items-center gap-1.5 font-mono"><GitCommitHorizontal className="h-3 w-3" aria-hidden="true" />{review.commitSha.slice(0, 7)}</span>}
                              </div>
                            </div>
                          </div>
                          <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-400">
                            <ShieldAlert className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                            {findings.length} {findings.length === 1 ? 'finding' : 'findings'}
                          </span>
                        </div>

                        {review.summary && (
                          <div className="border-b border-slate-800/70 px-4 py-3 sm:px-5">
                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{review.status === 'failed' ? 'Review message' : 'Summary'}</p>
                            <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-300">{review.summary}</p>
                          </div>
                        )}

                        {review.status === 'failed' && (
                          <div className="border-b border-red-400/10 bg-red-400/[0.025] px-4 py-3 sm:px-5">
                            <p className="text-xs leading-relaxed text-slate-400">
                              This analysis did not complete. Check the review message above and the connected GitHub account’s repository access. Refreshing history only reloads the saved result; after resolving the cause, push a new commit to trigger a fresh review.
                            </p>
                          </div>
                        )}

                        <div className="space-y-4 p-4 sm:p-5">
                          {findings.length === 0 ? (
                            <div className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                              {review.status === 'completed' ? (
                                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />
                              ) : review.status === 'failed' ? (
                                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden="true" />
                              ) : (
                                <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
                              )}
                              <div>
                                <p className="text-sm font-medium text-slate-200">
                                  {review.status === 'completed' ? 'No findings recorded' : review.status === 'failed' ? 'No findings available' : 'Analysis is still running'}
                                </p>
                                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                                  {review.status === 'completed'
                                    ? 'This completed review did not return any findings.'
                                    : review.status === 'failed'
                                      ? 'The review did not complete successfully, so an empty result does not indicate that the pull request is issue-free.'
                                      : 'Findings will appear here when the review finishes.'}
                                </p>
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-5">
                              {findingGroups.map((group) => (
                                <section key={group.severity} aria-label={`${group.severity} severity findings`}>
                                  <div className="mb-2.5 flex items-center gap-2">
                                    {group.severity === 'other' ? <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Other findings</span> : <SeverityBadge severity={group.severity} />}
                                    <span className="text-[11px] tabular-nums text-slate-500">{group.findings.length}</span>
                                  </div>
                                  <div className="space-y-2.5">
                                    {group.findings.map((finding, index) => (
                                      <div key={`${finding.filePath}-${finding.lineNumber}-${index}`} className={`rounded-xl border border-slate-800 border-l-2 ${SEVERITY_CONFIG[finding.severity]?.rail || 'border-l-slate-600'} bg-slate-900/55 p-4 sm:p-5`}>
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                          <div className="flex flex-wrap items-center gap-2">
                                            <SeverityBadge severity={finding.severity} />
                                            {finding.category && <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{finding.category.replaceAll('_', ' ')}</span>}
                                          </div>
                                          <div className="flex max-w-full items-start gap-2 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-slate-300 sm:max-w-[48%]">
                                            <FileCode2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-300" aria-hidden="true" />
                                            <span className="min-w-0 break-all">{finding.filePath}{finding.lineNumber ? `:${finding.lineNumber}` : ''}</span>
                                          </div>
                                        </div>
                                        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-300">{finding.explanation}</p>
                                        {finding.suggestedFix && finding.suggestedFix !== 'N/A' && (
                                          <div className="mt-4 overflow-hidden rounded-lg border border-indigo-400/15 bg-[#0a1020]">
                                            <div className="flex items-center gap-2 border-b border-slate-800/80 bg-indigo-400/[0.05] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-indigo-300">
                                              <Code2 className="h-3 w-3" aria-hidden="true" /> Suggested fix
                                            </div>
                                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-xs leading-5 text-slate-300">{finding.suggestedFix}</pre>
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </section>
                              ))}
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
