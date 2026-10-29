import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  BookMarked,
  ChevronLeft,
  ChevronRight,
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
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { FaGithub } from 'react-icons/fa';
import { apiUrl } from '../config/api.js';
import { filterRepositories } from '../utils/filterRepositories.js';
import { hasActiveReviews } from '../utils/reviews.js';
import { requestReviewHistory, requestReviewRetry } from '../utils/reviewHistory.js';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'suggestion'];
const REVIEW_POLL_INTERVAL_MS = 5000;
const SIDEBAR_REPOSITORIES_PER_PAGE = 12;

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

  oauthRepositories.forEach((repository) => addSource(repository, 'oauth'));
  appRepositories.forEach((repository) => addSource(repository, 'app'));

  return Array.from(sourcesByName.values(), (sources) => {
    const oauthRepository = sources.oauth;
    const appRepository = sources.app;
    const connectedRepository = [appRepository, oauthRepository]
      .find((repository) => repository?.connected);
    const primaryRepository = connectedRepository || appRepository || oauthRepository;

    return {
      ...primaryRepository,
      connected: Boolean(connectedRepository),
      connectionType: connectedRepository
        ? connectedRepository.connectionType || (connectedRepository === appRepository ? 'github_app' : 'oauth')
        : appRepository ? 'github_app' : 'oauth',
      installationId: connectedRepository
        ? connectedRepository.installationId
        : appRepository?.installationId,
      private: appRepository?.private ?? oauthRepository?.private ?? primaryRepository.private,
      availableViaApp: Boolean(appRepository),
      availableViaOAuth: Boolean(oauthRepository),
      appRepository,
      oauthRepository,
    };
  });
}

function mergeLoadedRepositories(existingRepositories, incomingRepositories) {
  const repositoriesById = new Map(existingRepositories.map((repository) => [
    String(repository.id),
    repository,
  ]));
  incomingRepositories.forEach((repository) => {
    repositoriesById.set(String(repository.id), repository);
  });
  return Array.from(repositoriesById.values());
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
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [repositoryManagerOpen, setRepositoryManagerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarPage, setSidebarPage] = useState(1);
  const [manageRepositoriesPage, setManageRepositoriesPage] = useState(1);
  const [repositorySearch, setRepositorySearch] = useState('');

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
  const [connectingAppRepoId, setConnectingAppRepoId] = useState(null);
  const [appConnectError, setAppConnectError] = useState('');

  // Main Content State
  const [reviews, setReviews] = useState([]);
  const [loadingReviews, setLoadingReviews] = useState(false);
  const [reviewsError, setReviewsError] = useState('');
  const [reviewsRetry, setReviewsRetry] = useState(0);
  const [retryingReviewId, setRetryingReviewId] = useState(null);
  const [reviewRetryError, setReviewRetryError] = useState(null);

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
        const fetchedRepositories = data.repositories.map((repository) => ({
          ...repository,
          connectionType: repository.connected ? repository.connectionType || 'github_app' : null,
          installationId: repository.connected
            ? repository.installationId
            : selectedInstallationId,
        }));
        setAppRepos((current) => mergeLoadedRepositories(current, fetchedRepositories));
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
  }, [selectedInstallationId, selectedInstallation?.status, appRepoPage, appRepoRetry, handleUnauthorized]);

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

        setRepos((current) => mergeLoadedRepositories(current, data.repositories));
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
  const ownedRepositories = mergedRepositories.filter(
    (repository) => repository.ownedByAuthenticatedUser === true,
  );
  const filteredRepositories = filterRepositories(ownedRepositories, repositorySearch);
  const sidebarPageCount = Math.max(1, Math.ceil(filteredRepositories.length / SIDEBAR_REPOSITORIES_PER_PAGE));
  const currentSidebarPage = Math.min(sidebarPage, sidebarPageCount);
  const sidebarRepositories = filteredRepositories.slice(
    (currentSidebarPage - 1) * SIDEBAR_REPOSITORIES_PER_PAGE,
    currentSidebarPage * SIDEBAR_REPOSITORIES_PER_PAGE,
  );
  const manageRepositoriesPageCount = Math.max(
    1,
    Math.ceil(filteredRepositories.length / SIDEBAR_REPOSITORIES_PER_PAGE),
  );
  const currentManageRepositoriesPage = Math.min(
    manageRepositoriesPage,
    manageRepositoriesPageCount,
  );
  const managedRepositories = filteredRepositories.slice(
    (currentManageRepositoriesPage - 1) * SIDEBAR_REPOSITORIES_PER_PAGE,
    currentManageRepositoriesPage * SIDEBAR_REPOSITORIES_PER_PAGE,
  );
  const appRepositoriesHaveNextPage = Boolean(
    appRepoHasNextPage && selectedInstallation?.status === 'active',
  );
  const moreRepositorySourcesAvailable = repoHasNextPage || appRepositoriesHaveNextPage;
  const canAdvanceManageRepositories = (
    currentManageRepositoriesPage < manageRepositoriesPageCount || moreRepositorySourcesAvailable
  );
  const selectedRepoUsesApp = selectedRepo?.connectionType === 'github_app';
  const selectedRepoAppConnected = Boolean(selectedRepo?.connected && selectedRepoUsesApp);

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
  }, [selectedRepo, selectedRepoAppConnected, handleUnauthorized, reviewsRetry, fetchReviewHistory]);

  // Refresh only while persisted reviews report an active worker state.
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

  const handleLogout = () => {
    localStorage.removeItem('codeguard_token');
    navigate('/login');
  };

  const selectRepository = (repository) => {
    setSelectedRepo(repository);
    const repositoryIndex = filteredRepositories.findIndex((item) => (
      item.fullName?.toLocaleLowerCase() === repository.fullName?.toLocaleLowerCase()
    ));
    if (repositoryIndex >= 0) {
      setSidebarPage(Math.floor(repositoryIndex / SIDEBAR_REPOSITORIES_PER_PAGE) + 1);
    }
    setRepositoryManagerOpen(false);
    setMobileSidebarOpen(false);
    setAppConnectError('');
    setReviews([]);
    setReviewsError('');
    setLoadingReviews(Boolean(repository.connected));
  };

  const retryReviewHistory = () => {
    setReviews([]);
    setReviewsError('');
    setLoadingReviews(true);
    setReviewsRetry((attempt) => attempt + 1);
  };

  const handleRetryReview = async (review) => {
    if (!selectedRepoAppConnected || !selectedRepo || review.status !== 'failed' || retryingReviewId) return;
    setRetryingReviewId(review._id);
    setReviewRetryError(null);
    try {
      const token = localStorage.getItem('codeguard_token');
      await requestReviewRetry(selectedRepo.id, review._id, token);
      setReviews((current) => current.map((item) => (
        item._id === review._id
          ? { ...item, status: 'queued', summary: 'Review retry queued.' }
          : item
      )));
      setReviewsRetry((attempt) => attempt + 1);
    } catch (error) {
      if (error.status === 401) {
        handleUnauthorized();
      } else {
        setReviewRetryError({
          reviewId: review._id,
          message: error.message || 'Could not retry this review.',
        });
        // A timeout can happen after the server accepted the retry; reload to
        // reconcile the UI with the persisted review status.
        setReviewsRetry((attempt) => attempt + 1);
      }
    } finally {
      setRetryingReviewId(null);
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
    if (repo.connected && repo.connectionType === 'github_app') return;
    if (!selectedInstallationId) {
      setAppConnectError('Install or select an active GitHub App installation before connecting a repository.');
      setRepositoryManagerOpen(true);
      return;
    }
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
            <button
              type="button"
              onClick={() => setMobileSidebarOpen((open) => !open)}
              aria-expanded={mobileSidebarOpen}
              aria-controls="repository-navigation"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 lg:hidden"
            >
              <BookMarked className="h-3.5 w-3.5" aria-hidden="true" /> Browse
            </button>
            <button
              type="button"
              onClick={() => setRepositoryManagerOpen((open) => !open)}
              aria-expanded={repositoryManagerOpen}
              aria-controls="repository-manager"
              className="inline-flex items-center gap-2 rounded-lg border border-indigo-400/20 bg-indigo-500/10 px-3 py-2 text-xs font-medium text-indigo-200 transition hover:border-indigo-300/40 hover:bg-indigo-500/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              <BookMarked className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">{repositoryManagerOpen ? 'Close repositories' : 'Manage repositories'}</span>
              <span className="sm:hidden">Repositories</span>
            </button>
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

      <main className="relative mx-auto max-w-[1600px] space-y-5 px-4 py-5 sm:px-6 sm:py-7 lg:px-8">
        {githubAppNotice && (
          <div
            className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${githubAppNotice.startsWith('GitHub App connected.') ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-100' : 'border-indigo-400/20 bg-indigo-400/5 text-indigo-100'}`}
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
        <div className={'grid min-w-0 gap-4 lg:items-start ' + (sidebarCollapsed ? 'lg:grid-cols-[4.5rem_minmax(0,1fr)]' : 'lg:grid-cols-[16rem_minmax(0,1fr)]')}>
          <aside id="repository-navigation" aria-label="Repository navigation" className={(mobileSidebarOpen ? 'block' : 'hidden') + ' min-w-0 rounded-2xl border border-slate-800/90 bg-slate-950/75 p-3 shadow-xl shadow-black/10 lg:block ' + (sidebarCollapsed ? 'lg:p-2' : 'sm:p-4')}>
            <div className={'flex items-center ' + (sidebarCollapsed ? 'lg:flex-col lg:gap-3' : 'justify-between gap-2')}>
              {!sidebarCollapsed && <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-300">CodeGuard</p><h2 className="mt-1 text-sm font-semibold text-white">Repositories</h2></div>}
              <button type="button" onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} aria-label={sidebarCollapsed ? 'Expand repository sidebar' : 'Collapse repository sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="hidden rounded-lg border border-slate-800 bg-slate-900 p-2 text-slate-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 lg:inline-flex">
                {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" aria-hidden="true" /> : <PanelLeftClose className="h-4 w-4" aria-hidden="true" />}
              </button>
              <button type="button" onClick={() => setMobileSidebarOpen(false)} className="rounded px-2 py-1 text-xs text-slate-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 lg:hidden">Close</button>
            </div>
            {!sidebarCollapsed && <>
              <label htmlFor="workspace-repository-search" className="sr-only">Search repositories currently loaded</label>
              <div className="relative mt-4"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" aria-hidden="true" /><input id="workspace-repository-search" type="search" value={repositorySearch} onChange={(event) => { setRepositorySearch(event.target.value); setSidebarPage(1); }} placeholder="Search repositories…" className="w-full rounded-lg border border-slate-800 bg-slate-900/70 py-2 pl-8 pr-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-indigo-400/50 focus:outline-none focus:ring-2 focus:ring-indigo-400/20" /></div>
              <p className="mt-1.5 text-[10px] text-slate-600">Searches loaded results</p>
            </>}
            <div className={'mt-3 space-y-1 ' + (sidebarCollapsed ? 'lg:mt-4' : '')}>
              {sidebarRepositories.map((repository) => <button key={repository.fullName.toLocaleLowerCase()} type="button" onClick={() => selectRepository(repository)} aria-pressed={selectedRepo?.fullName?.toLocaleLowerCase() === repository.fullName.toLocaleLowerCase()} title={sidebarCollapsed ? repository.fullName : undefined} className={'flex w-full min-w-0 items-center rounded-lg border px-2.5 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ' + (selectedRepo?.fullName?.toLocaleLowerCase() === repository.fullName.toLocaleLowerCase() ? 'border-indigo-400/30 bg-indigo-500/[0.10] text-white' : 'border-transparent text-slate-300 hover:border-slate-800 hover:bg-slate-900/70') + (sidebarCollapsed ? ' lg:justify-center lg:px-1' : '')}>
                <span className={'min-w-0 flex-1 truncate text-xs font-medium ' + (sidebarCollapsed ? 'lg:hidden' : '')}>{repository.name}</span>
                {sidebarCollapsed && <span className="hidden text-[10px] font-semibold text-indigo-200 lg:inline" aria-hidden="true">{repository.name.slice(0, 1).toUpperCase()}</span>}
              </button>)}
              {sidebarRepositories.length === 0 && <p className="px-2 py-3 text-xs leading-relaxed text-slate-500" role="status">{loadingRepos || loadingAppRepos ? 'Loading repositories…' : repositorySearch.trim() ? 'No loaded repositories match your search.' : 'No repositories loaded yet.'}</p>}
              {filteredRepositories.length > SIDEBAR_REPOSITORIES_PER_PAGE && (
                <div className={'flex items-center justify-between border-t border-slate-800/80 px-1 pt-2 ' + (sidebarCollapsed ? 'lg:flex-col lg:gap-2' : '')}>
                  {!sidebarCollapsed && <span className="text-[10px] tabular-nums text-slate-500">{filteredRepositories.length} repositories</span>}
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => setSidebarPage((page) => Math.max(1, page - 1))} disabled={currentSidebarPage === 1} aria-label="Previous repository page" className="rounded-md border border-slate-800 p-1 text-slate-400 hover:bg-slate-900 hover:text-white disabled:opacity-35 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"><ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /></button>
                    <span className="text-[10px] tabular-nums text-slate-400" aria-live="polite">{currentSidebarPage} / {sidebarPageCount}</span>
                    <button type="button" onClick={() => setSidebarPage((page) => Math.min(sidebarPageCount, page + 1))} disabled={currentSidebarPage >= sidebarPageCount} aria-label="Next repository page" className="rounded-md border border-slate-800 p-1 text-slate-400 hover:bg-slate-900 hover:text-white disabled:opacity-35 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"><ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></button>
                  </div>
                </div>
              )}
              <button type="button" onClick={() => { setRepositoryManagerOpen(true); setMobileSidebarOpen(false); }} title={sidebarCollapsed ? 'Manage repositories' : undefined} className={'mt-2 flex w-full items-center gap-2 rounded-lg border border-slate-800/80 bg-slate-900/60 px-2.5 py-2 text-left text-xs font-medium text-indigo-300 hover:border-indigo-400/30 hover:bg-indigo-500/[0.07] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400' + (sidebarCollapsed ? ' lg:justify-center lg:px-1' : '')}><BookMarked className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span className={sidebarCollapsed ? 'lg:hidden' : ''}>Manage repositories</span></button>
            </div>
          </aside>

          <div className="min-w-0">
            <section id="repository-manager" aria-label="Repository management" hidden={!repositoryManagerOpen} className="rounded-2xl border border-slate-800/90 bg-slate-950/75 p-4 shadow-xl shadow-black/10 sm:p-5">
              <div className="mb-5 flex flex-wrap items-start justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-300">Repository settings</p><h2 className="mt-1 text-lg font-semibold text-white">Manage repositories</h2><p className="mt-1 text-xs text-slate-500">Connect through GitHub App or your GitHub account. OAuth access does not install the App or configure webhook delivery.</p></div><button type="button" onClick={() => setRepositoryManagerOpen(false)} className="rounded-md border border-slate-800 px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-900 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Back to reviews</button></div>

              <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                <section className="min-w-0 rounded-xl border border-violet-400/15 bg-[#0b1120]/70 p-4" aria-labelledby="github-app-heading">
                  <div className="flex items-start justify-between gap-3"><div><h3 id="github-app-heading" className="text-sm font-semibold text-slate-100">GitHub App</h3><p className="mt-1 text-[11px] leading-relaxed text-slate-500">Install the App and choose repositories for automatic PR review delivery.</p></div><FaGithub className="h-4 w-4 text-violet-300" aria-hidden="true" /></div>
                  <button type="button" onClick={handleStartGitHubAppInstall} disabled={startingAppInstall} className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg border border-violet-400/20 bg-violet-500/10 px-3 py-2 text-xs font-semibold text-violet-200 hover:border-violet-300/40 hover:bg-violet-500/15 disabled:cursor-wait disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">{startingAppInstall ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />}{startingAppInstall ? 'Opening GitHub…' : installations.length ? 'Install or manage GitHub App' : 'Install GitHub App'}</button>
                  {loadingInstallations ? <p className="mt-3 flex items-center gap-2 text-xs text-slate-500" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" aria-hidden="true" /> Checking App installations…</p> : installationError ? <div className="mt-3 rounded-lg border border-red-400/20 bg-red-400/5 p-3" role="alert"><p className="text-xs leading-relaxed text-red-100">{installationError}</p><button type="button" onClick={() => setInstallationRetry((attempt) => attempt + 1)} className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-indigo-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"><RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry</button></div> : installations.length === 0 ? <p className="mt-3 text-[11px] leading-relaxed text-slate-500">No GitHub App installation is linked yet. Install the App, then return here to choose repositories.</p> : <>
                    <label htmlFor="github-app-installation" className="mt-4 block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Installation</label><select id="github-app-installation" value={selectedInstallationId} onChange={(event) => { setSelectedInstallationId(event.target.value); setAppRepoPage(1); setRepositorySearch(''); setAppConnectError(''); setAppRepos([]); setAppRepoHasNextPage(false); setAppRepoError(''); }} className="mt-1.5 w-full rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-2 text-xs text-slate-200 focus:border-indigo-400/50 focus:outline-none focus:ring-2 focus:ring-indigo-400/20">{installations.map((installation) => <option key={installation.installationId} value={installation.installationId}>{installation.accountLogin} · {installation.status}</option>)}</select>
                    {selectedInstallation?.status !== 'active' ? <p className="mt-3 rounded-lg border border-amber-400/15 bg-amber-400/5 p-3 text-xs leading-relaxed text-amber-100">This installation is {selectedInstallation?.status || 'unavailable'} and cannot provide repositories. Restore App access in GitHub.</p> : loadingAppRepos ? <p className="mt-3 flex items-center gap-2 text-xs text-slate-500" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" aria-hidden="true" /> Loading installation repositories…</p> : appRepoError ? <div className="mt-3 rounded-lg border border-red-400/20 bg-red-400/5 p-3" role="alert"><p className="text-xs leading-relaxed text-red-100">{appRepoError}</p><button type="button" onClick={() => setAppRepoRetry((attempt) => attempt + 1)} className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-indigo-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"><RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry App repositories</button></div> : appRepos.length === 0 && <p className="mt-3 text-[11px] text-slate-500" role="status">No repositories are available from this installation on the current page.</p>}
                  </>}
                </section>

                <section className="min-w-0 rounded-xl border border-slate-800/80 bg-[#0b1120]/70 p-4" aria-labelledby="oauth-repositories-heading"><div className="flex items-center justify-between gap-3"><div><h3 id="oauth-repositories-heading" className="text-sm font-semibold text-slate-100">GitHub account</h3><p className="mt-1 text-[11px] text-slate-500">Repositories available to your linked GitHub account.</p></div><FaGithub className="h-4 w-4 text-slate-400" aria-hidden="true" /></div>
                  {repoError && <div className="mt-3 rounded-lg border border-red-400/20 bg-red-400/5 p-3" role="alert"><p className="text-xs leading-relaxed text-red-100">{repoError}</p>{repoReauthRequired && <a href={apiUrl('/api/auth/github')} className="mt-2 inline-flex text-xs font-semibold text-indigo-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Reconnect GitHub</a>}<button type="button" onClick={() => setRepoRetry((attempt) => attempt + 1)} className="ml-3 mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-indigo-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"><RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry</button></div>}
                  {loadingRepos && <p className="mt-3 flex items-center gap-2 text-xs text-slate-500" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" aria-hidden="true" /> Loading GitHub account repositories…</p>}
                  {!loadingRepos && !repoError && repos.length === 0 && <p className="mt-3 text-xs text-slate-500" role="status">No repositories were returned on this page.</p>}
                </section>
              </div>

              <div className="mt-4 rounded-xl border border-slate-800/80 bg-[#0b1120]/60 p-4">
                <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-100">Available repositories</h3><p className="mt-1 text-[11px] text-slate-500">Searches owned repositories loaded so far.</p></div><label htmlFor="manage-repository-search" className="sr-only">Search owned repositories</label><div className="relative w-full sm:max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" aria-hidden="true" /><input id="manage-repository-search" type="search" value={repositorySearch} onChange={(event) => { setRepositorySearch(event.target.value); setSidebarPage(1); setManageRepositoriesPage(1); }} placeholder="Search repositories…" className="w-full rounded-lg border border-slate-800 bg-slate-900/70 py-2 pl-8 pr-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-indigo-400/50 focus:outline-none focus:ring-2 focus:ring-indigo-400/20" /></div></div>
                {loadingRepos && loadingAppRepos && mergedRepositories.length === 0 ? <p className="mt-4 flex items-center gap-2 text-xs text-slate-500" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" aria-hidden="true" /> Loading available repositories…</p> : filteredRepositories.length === 0 ? <p className="mt-4 rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-xs text-slate-500" role="status">{repositorySearch.trim() ? 'No loaded repositories match this search.' : 'No repositories are available yet.'}</p> : <ul className="mt-3 divide-y divide-slate-800/70">
                  {managedRepositories.map((repository) => { const connectedViaApp = repository.connected && repository.connectionType === 'github_app'; const busy = connectingAppRepoId === repository.id; return <li key={repository.fullName.toLocaleLowerCase()} className="flex min-w-0 flex-wrap items-center gap-2 py-2.5 sm:flex-nowrap">
                    <button type="button" onClick={() => selectRepository(repository)} aria-pressed={selectedRepo?.fullName?.toLocaleLowerCase() === repository.fullName.toLocaleLowerCase()} className="min-w-0 flex-1 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"><span className="block truncate text-xs font-medium text-slate-200">{repository.name}</span><span className="mt-0.5 block text-[10px] text-slate-500">{connectedViaApp ? 'GitHub App connection active' : repository.connected ? (repository.private ? 'Private' : 'Public') + ' · OAuth linked; App connection required' : (repository.private ? 'Private' : 'Public')}</span></button>
                    {connectedViaApp ? <span className="shrink-0 rounded-full border border-emerald-400/15 bg-emerald-400/5 px-2 py-1 text-[10px] font-medium text-emerald-300">Connected</span> : <button type="button" onClick={() => handleConnectAppRepository(repository.appRepository || repository.oauthRepository || repository)} disabled={busy} className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-violet-500/90 px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-violet-400 disabled:cursor-wait disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">{busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}{busy ? 'Connecting…' : 'Connect'}</button>}
                  </li>; })}
                </ul>}
                {appConnectError && <p className="mt-2 text-xs text-red-200" role="alert">{appConnectError}</p>}
                {filteredRepositories.length > SIDEBAR_REPOSITORIES_PER_PAGE || moreRepositorySourcesAvailable ? (
                  <div className="mt-3 flex items-center justify-center gap-3 border-t border-slate-800/80 pt-3">
                    <button
                      type="button"
                      onClick={() => setManageRepositoriesPage(Math.max(1, currentManageRepositoriesPage - 1))}
                      disabled={currentManageRepositoriesPage === 1 || loadingRepos || loadingAppRepos}
                      className="rounded-md border border-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                    >Previous</button>
                    <span className="min-w-12 text-center text-xs tabular-nums text-slate-400" aria-live="polite">{currentManageRepositoriesPage} / {manageRepositoriesPageCount}</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (currentManageRepositoriesPage < manageRepositoriesPageCount) {
                          setManageRepositoriesPage(currentManageRepositoriesPage + 1);
                          return;
                        }
                        setManageRepositoriesPage(currentManageRepositoriesPage + 1);
                        if (repoHasNextPage) setRepoPage((page) => page + 1);
                        if (appRepositoriesHaveNextPage) setAppRepoPage((page) => page + 1);
                      }}
                      disabled={!canAdvanceManageRepositories || loadingRepos || loadingAppRepos}
                      className="rounded-md border border-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                    >Next</button>
                  </div>
                ) : null}
              </div>
            </section>
            <section className="min-w-0 space-y-5" aria-label="Repository review history" hidden={repositoryManagerOpen}>
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
                  {selectedRepoAppConnected
                    ? 'Review history and findings for this repository connected through the GitHub App.'
                    : selectedRepo?.connectionType === 'oauth'
                      ? 'OAuth is linked, but this repository needs a GitHub App connection for automatic reviews here.'
                      : selectedRepo
                        ? 'Connect this repository through the GitHub App to enable automatic reviews here.'
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
                      {selectedRepoAppConnected
                        ? reviews.length > 0 ? 'Review history found' : 'No review recorded'
                        : 'App connection needed'}
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

          {selectedRepoAppConnected && (
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
              <p className="text-xs font-semibold text-slate-200">
                Connected through {selectedRepoUsesApp ? 'GitHub App' : 'GitHub OAuth'}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                {selectedRepoUsesApp
                  ? 'This connection uses the GitHub App route for pull request events. CodeGuard confirms delivery only when a review appears in the history below.'
                  : 'OAuth access links this repository to CodeGuard but does not configure automatic GitHub App delivery. Use Manage repositories to connect it through the GitHub App.'}
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
          ) : !selectedRepoAppConnected ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 sm:p-8">
              <div className="mx-auto flex max-w-lg flex-col items-center text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-indigo-400/20 bg-indigo-500/10">
                  <BookMarked className="h-5 w-5 text-indigo-300" aria-hidden="true" />
                </div>
                <h2 className="mt-4 text-lg font-semibold text-white">Connect {selectedRepo.name} through GitHub App</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  {selectedRepo.connected
                    ? 'This repository is linked through GitHub OAuth, but OAuth access does not connect it to the GitHub App or enable App-based automatic PR reviews. Connect it through the App to receive reviews here.'
                    : 'Connect this repository through your GitHub App installation to enable automatic pull request reviews. GitHub account access alone does not configure App delivery.'}
                </p>
                <button
                  type="button"
                  onClick={() => setRepositoryManagerOpen(true)}
                  className="mt-5 inline-flex items-center gap-2 rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-950/30 transition hover:bg-indigo-400 disabled:cursor-wait disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
                >
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Connect repository
                </button>
                <p className="mt-4 max-w-md text-xs leading-relaxed text-slate-500">
                  Manage repositories opens the existing GitHub App installation and repository connection flow.
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
                    This repository is connected through the GitHub App. A review appears here after a supported pull request event reaches CodeGuard’s App webhook pipeline. Open a pull request or update an open one to generate review activity; this empty history does not confirm delivery.
                  </p>
                  <p className="mx-auto mt-2 max-w-lg text-[11px] leading-relaxed text-slate-500">
                    Installation alone does not prove that an event was delivered; this state changes when a review is recorded.
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
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                              <p className="text-xs leading-relaxed text-slate-400">
                                This analysis did not complete. Check the review message above and resolve any GitHub access or service issue before retrying.
                              </p>
                              <button
                                type="button"
                                onClick={() => handleRetryReview(review)}
                                disabled={Boolean(retryingReviewId)}
                                className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-indigo-400/25 bg-indigo-400/10 px-3 py-2 text-xs font-semibold text-indigo-200 transition hover:border-indigo-300/40 hover:bg-indigo-400/15 disabled:cursor-wait disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                              >
                                {retryingReviewId === review._id
                                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                  : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                                {retryingReviewId === review._id ? 'Queueing retry…' : 'Retry review'}
                              </button>
                            </div>
                          </div>
                        )}

                        {reviewRetryError?.reviewId === review._id && review.status === 'failed' && (
                          <p className="border-b border-red-400/10 px-4 py-2 text-xs text-red-200" role="alert">{reviewRetryError.message}</p>
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
          </div>
        </div>
      </main>
    </div>
  );
}
