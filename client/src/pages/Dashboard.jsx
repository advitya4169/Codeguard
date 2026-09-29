import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";

import {
  Play,
  Code2,
  Sparkles,
  Loader2,
  AlertCircle,
  BookMarked,
  LogOut,
} from "lucide-react";

import { FaGithub } from "react-icons/fa";

const DEFAULT_CODE = `function processUserData(users) {

  for (var i = 0; i < users.length; i++) {

    if (users[i].id == req.query.id) {

      eval("var user_" + i + " = " + JSON.stringify(users[i]));

      console.log("Found user: " + users[i].name);

    }

  }

}`;

export default function Dashboard() {
  const navigate = useNavigate();

  // Sidebar State
  const [repos, setRepos] = useState([]);
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [repoError, setRepoError] = useState("");
  const [selectedRepo, setSelectedRepo] = useState(null);

  // Playground State
  const [code, setCode] = useState(DEFAULT_CODE);
  const [review, setReview] = useState("");
  const [loadingReview, setLoadingReview] = useState(false);
  const [reviewError, setReviewError] = useState("");

  // Fetch Repositories on mount
  useEffect(() => {
    const fetchRepos = async () => {
      try {
        const token = localStorage.getItem("codeguard_token");

        const response = await fetch(
          "http://localhost:5000/api/github/repos",
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (response.status === 401) {
          // Token expired or invalid
          localStorage.removeItem("codeguard_token");
          navigate("/login");
          return;
        }

        if (!response.ok) {
          throw new Error("Failed to fetch repositories");
        }

        const data = await response.json();
        setRepos(data.repositories);
      } catch (err) {
        setRepoError(err.message);
      } finally {
        setLoadingRepos(false);
      }
    };

    fetchRepos();
  }, [navigate]);

  const handleLogout = () => {
    localStorage.removeItem("codeguard_token");
    navigate("/login");
  };

  const handleReview = async () => {
    if (!code.trim()) return;

    setLoadingReview(true);
    setReviewError("");
    setReview("");

    try {
      const response = await fetch("http://localhost:5000/api/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to analyze code.");
      }

      setReview(data.review);
    } catch (err) {
      setReviewError(err.message || "Something went wrong.");
    } finally {
      setLoadingReview(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex font-sans">
      {/* Sidebar */}
      <aside className="w-72 bg-slate-950 border-r border-slate-800 flex flex-col">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Code2 className="h-6 w-6 text-indigo-400" />

            <h1 className="text-xl font-bold tracking-tight text-white">
              CodeGuard
            </h1>
          </div>
        </div>

        <div className="p-4 border-b border-slate-800">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">
            <FaGithub className="h-4 w-4" />
            Your Repositories
          </div>

          {loadingRepos ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading repos...
            </div>
          ) : repoError ? (
            <div className="text-red-400 text-sm">{repoError}</div>
          ) : (
            <ul className="space-y-1 overflow-y-auto max-h-[60vh] pr-2">
              {repos.map((repo) => (
                <li key={repo.id}>
                  <button
                    onClick={() => setSelectedRepo(repo)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-left transition ${
                      selectedRepo?.id === repo.id
                        ? "bg-indigo-600 text-white"
                        : "text-slate-300 hover:bg-slate-800"
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
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition w-full px-3 py-2 rounded-md hover:bg-slate-800"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="border-b border-slate-800 bg-slate-900 px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">
            {selectedRepo
              ? `Selected: ${selectedRepo.fullName}`
              : "Manual Review Playground"}
          </h2>

          <span className="text-xs bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded border border-indigo-500/20 font-mono">
            Stage 3 - Auth & API
          </span>
        </header>

        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 p-6 overflow-hidden">
          {/* Editor Panel */}
          <div className="flex flex-col bg-slate-950 rounded-lg border border-slate-800 overflow-hidden">
            <div className="bg-slate-900/80 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Input Code Snippet
              </span>

              <button
                onClick={handleReview}
                disabled={loadingReview || !code.trim()}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 text-white text-sm px-4 py-1.5 rounded-md font-medium transition disabled:cursor-not-allowed"
              >
                {loadingReview ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Analyzing...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 fill-current" />
                    Run Review
                  </>
                )}
              </button>
            </div>

            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full flex-1 p-4 bg-slate-950 text-slate-200 font-mono text-sm resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500"
              spellCheck="false"
            />
          </div>

          {/* Output Panel */}
          <div className="flex flex-col bg-slate-950 rounded-lg border border-slate-800 overflow-hidden">
            <div className="bg-slate-900/80 px-4 py-3 border-b border-slate-800 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-400" />

              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                AI Feedback
              </span>
            </div>

            <div className="flex-1 p-6 overflow-y-auto">
              {reviewError && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-md text-red-400 text-sm mb-4">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertCircle className="h-4 w-4" />

                    <span className="font-semibold">Error</span>
                  </div>

                  {reviewError}
                </div>
              )}

              {loadingReview && (
                <div className="h-full flex flex-col items-center justify-center text-slate-400 text-sm">
                  <Loader2 className="h-8 w-8 animate-spin text-indigo-500 mb-3" />

                  <p>Analyzing code...</p>
                </div>
              )}

              {!loadingReview && review && (
                <div className="prose prose-invert max-w-none text-slate-300 text-sm leading-relaxed">
                  <ReactMarkdown>{review}</ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}