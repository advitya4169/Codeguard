import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Code2, Loader2, BookMarked, LogOut, 
  GitPullRequest, AlertTriangle, ShieldAlert, CheckCircle, Info 
} from 'lucide-react';
import { FaGithub } from 'react-icons/fa';

export default function Dashboard() {
  const navigate = useNavigate();
  
  // Sidebar State
  const [repos, setRepos] = useState([]);
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [selectedRepo, setSelectedRepo] = useState(null);

  // Main Content State
  const [reviews, setReviews] = useState([]);
  const [loadingReviews, setLoadingReviews] = useState(false);

  // Fetch Repositories on mount
  useEffect(() => {
    const fetchRepos = async () => {
      try {
        const token = localStorage.getItem('codeguard_token');
        const response = await fetch('http://localhost:5000/api/github/repos', {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.status === 401) {
          localStorage.removeItem('codeguard_token');
          navigate('/login');
          return;
        }

        const data = await response.json();
        setRepos(data.repositories || []);
      } catch (err) {
        console.error('Failed to fetch repos', err);
      } finally {
        setLoadingRepos(false);
      }
    };
    fetchRepos();
  }, [navigate]);

  // Fetch Reviews when a repository is selected
  useEffect(() => {
    if (!selectedRepo) return;

    const fetchReviews = async () => {
      setLoadingReviews(true);
      try {
        const token = localStorage.getItem('codeguard_token');
        const response = await fetch(`http://localhost:5000/api/dashboard/repos/${selectedRepo.id}/reviews`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await response.json();
        setReviews(data.reviews || []);
      } catch (err) {
        console.error('Failed to fetch reviews', err);
      } finally {
        setLoadingReviews(false);
      }
    };

    fetchReviews();
  }, [selectedRepo]);

  const handleLogout = () => {
    localStorage.removeItem('codeguard_token');
    navigate('/login');
  };

  const getSeverityBadge = (severity) => {
    const styles = {
      critical: 'bg-red-500/10 text-red-400 border-red-500/20',
      high: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
      medium: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
      low: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
      suggestion: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
    };
    const icons = {
      critical: <ShieldAlert className="h-3 w-3" />,
      high: <AlertTriangle className="h-3 w-3" />,
      medium: <AlertTriangle className="h-3 w-3" />,
      low: <Info className="h-3 w-3" />,
      suggestion: <CheckCircle className="h-3 w-3" />,
    };

    return (
      <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${styles[severity] || styles.suggestion}`}>
        {icons[severity]} {severity.toUpperCase()}
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex font-sans">
      
      {/* Sidebar (Kept mostly identical to Stage 3) */}
      <aside className="w-72 bg-slate-950 border-r border-slate-800 flex flex-col">
        <div className="p-4 border-b border-slate-800 flex items-center gap-2">
          <Code2 className="h-6 w-6 text-indigo-400" />
          <h1 className="text-xl font-bold text-white">CodeGuard</h1>
        </div>

        <div className="p-4 border-b border-slate-800">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">
            <FaGithub  className="h-4 w-4" /> Your Repositories
          </div>
          {loadingRepos ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading repos...
            </div>
          ) : (
            <ul className="space-y-1 overflow-y-auto max-h-[60vh] pr-2">
              {repos.map(repo => (
                <li key={repo.id}>
                  <button
                    onClick={() => setSelectedRepo(repo)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-left transition ${
                      selectedRepo?.id === repo.id ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <BookMarked className="h-4 w-4 flex-shrink-0" />
                    <span className="truncate">{repo.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-auto p-4 border-t border-slate-800">
          <button onClick={handleLogout} className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition w-full px-3 py-2 rounded-md hover:bg-slate-800">
            <LogOut className="h-4 w-4" /> Sign Out
          </button>
        </div>
      </aside>

      {/* Main Analytics Area */}
      <main className="flex-1 flex flex-col overflow-hidden bg-slate-900">
        <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm px-8 py-5 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-white">
              {selectedRepo ? selectedRepo.fullName : 'Select a repository'}
            </h2>
            <p className="text-sm text-slate-400 mt-1">Automated Pull Request Security & Quality Analysis</p>
          </div>
        </header>

        <div className="flex-1 p-8 overflow-y-auto">
          {!selectedRepo ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-500">
              <GitPullRequest className="h-12 w-12 mb-4 opacity-20" />
              <p>Select a repository from the sidebar to view automated reviews.</p>
            </div>
          ) : loadingReviews ? (
            <div className="flex items-center justify-center text-slate-400 mt-10">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-500 mr-3" /> Fetching history...
            </div>
          ) : reviews.length === 0 ? (
            <div className="text-center text-slate-400 mt-10 bg-slate-800/30 rounded-lg p-10 border border-slate-700/50">
              <p>No automated reviews found for this repository.</p>
              <p className="text-sm mt-2">Open a Pull Request on GitHub to trigger the webhook!</p>
            </div>
          ) : (
            <div className="space-y-6 max-w-5xl mx-auto">
              {reviews.map((review) => (
                <div key={review._id} className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
                  {/* PR Header */}
                  <div className="bg-slate-900/80 px-6 py-4 border-b border-slate-800 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <GitPullRequest className="h-5 w-5 text-indigo-400" />
                      <h3 className="font-semibold text-lg text-white">Pull Request #{review.prNumber}</h3>
                      <span className="text-xs font-mono text-slate-500 bg-slate-800 px-2 py-1 rounded">
                        {review.commitSha.substring(0, 7)}
                      </span>
                    </div>
                    <div className="text-sm text-slate-400">
                      {new Date(review.createdAt).toLocaleDateString()}
                    </div>
                  </div>

                  {/* Findings List */}
                  <div className="p-6">
                    {review.findings.length === 0 ? (
                      <div className="text-slate-400 flex items-center gap-2">
                        <CheckCircle className="h-5 w-5 text-emerald-400" /> No issues found. LGTM!
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {review.findings.map((finding, idx) => (
                          <div key={idx} className="bg-slate-900 rounded-lg border border-slate-800 p-5">
                            <div className="flex items-start justify-between mb-3">
                              <div className="flex items-center gap-3">
                                {getSeverityBadge(finding.severity)}
                                <span className="text-sm font-medium text-slate-300 uppercase tracking-wider">
                                  {finding.category.replace('_', ' ')}
                                </span>
                              </div>
                              <div className="text-sm font-mono text-slate-400 bg-slate-950 px-3 py-1 rounded border border-slate-800">
                                {finding.filePath}:{finding.lineNumber || 'N/A'}
                              </div>
                            </div>
                            
                            <p className="text-slate-200 text-sm mb-4 leading-relaxed">
                              {finding.explanation}
                            </p>
                            
                            {finding.suggestedFix && finding.suggestedFix !== 'N/A' && (
                              <div className="bg-slate-950 rounded border border-slate-800 overflow-hidden">
                                <div className="bg-indigo-500/10 text-indigo-300 text-xs px-3 py-1.5 border-b border-slate-800/50 font-semibold uppercase tracking-wider">
                                  Suggested Fix
                                </div>
                                <pre className="p-3 text-sm text-slate-300 overflow-x-auto">
                                  <code>{finding.suggestedFix}</code>
                                </pre>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}