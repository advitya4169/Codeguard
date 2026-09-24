import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Play, Code2, Sparkles, Loader2, AlertCircle } from 'lucide-react';

const DEFAULT_CODE = `function processUserData(users) {
  for (var i = 0; i < users.length; i++) {
    if (users[i].id == req.query.id) {
      eval("var user_" + i + " = " + JSON.stringify(users[i]));
      console.log("Found user: " + users[i].name);
    }
  }
}`;

export default function App() {
  const [code, setCode] = useState(DEFAULT_CODE);
  const [review, setReview] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleReview = async () => {
    if (!code.trim()) return;
    setLoading(true);
    setError('');
    setReview('');

    try {
      const response = await fetch('http://localhost:5000/api/review', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to analyze code.');
      }

      setReview(data.review);
    } catch (err) {
      setError(err.message || 'Something went wrong while connecting to the server.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col font-sans">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-950 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Code2 className="h-6 w-6 text-indigo-400" />
          <h1 className="text-xl font-bold tracking-tight text-white">CodeGuard</h1>
          <span className="text-xs bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded border border-indigo-500/20 font-mono">
            Stage 1 - Playground
          </span>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 p-6 overflow-hidden">
        {/* Editor Panel */}
        <div className="flex flex-col bg-slate-950 rounded-lg border border-slate-800 overflow-hidden">
          <div className="bg-slate-900/80 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Input Code Snippet
            </span>
            <button
              onClick={handleReview}
              disabled={loading || !code.trim()}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 text-white text-sm px-4 py-1.5 rounded-md font-medium transition cursor-pointer disabled:cursor-not-allowed"
            >
              {loading ? (
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
            placeholder="Paste your code snippet here..."
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
            {error && (
              <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-md text-red-400 text-sm">
                <AlertCircle className="h-5 w-5 flex-shrink-0" />
                <div>
                  <p className="font-semibold">Error</p>
                  <p>{error}</p>
                </div>
              </div>
            )}

            {!loading && !error && !review && (
              <div className="h-full flex flex-col items-center justify-center text-slate-500 text-sm">
                <Code2 className="h-12 w-12 stroke-1 mb-2 opacity-50" />
                <p>Paste your code on the left and click "Run Review"</p>
              </div>
            )}

            {loading && (
              <div className="h-full flex flex-col items-center justify-center text-slate-400 text-sm">
                <Loader2 className="h-8 w-8 animate-spin text-indigo-500 mb-3" />
                <p>Gemini is reviewing your code for bugs & security issues...</p>
              </div>
            )}

            {!loading && review && (
              <div className="prose prose-invert max-w-none text-slate-300 text-sm leading-relaxed">
                <ReactMarkdown>{review}</ReactMarkdown>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}