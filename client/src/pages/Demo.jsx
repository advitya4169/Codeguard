import { useState } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Code2,
  Loader2,
  AlertCircle,
  RotateCcw,
  Terminal,
  ArrowLeft,
  FlaskConical,
} from 'lucide-react';
import { FaGithub } from 'react-icons/fa';
import { apiUrl } from '../config/api.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// Must match MAX_CODE_CHARS in server/src/controllers/reviewController.js
const MAX_CHARS = 10_000;

const API_URL = apiUrl('/api/review');

// ─── Example snippets ─────────────────────────────────────────────────────────
// These are self-contained JavaScript examples with intentional issues.
// They replace the textarea content when selected; nothing is sent to the backend
// until the user clicks "Analyze Code".

const SNIPPETS = [
  {
    label: 'SQL Injection',
    description: 'User input concatenated into a query',
    code: `// Express route — user ID from query string inserted directly into SQL
const express = require('express');
const db = require('./db');

const app = express();

app.get('/users', async (req, res) => {
  const { id } = req.query;

  // Danger: user input concatenated directly into the query string
  const result = await db.query(
    \`SELECT * FROM users WHERE id = \${id}\`
  );

  res.json(result.rows);
});

app.listen(3000);`,
  },
  {
    label: 'N+1 Query',
    description: 'Sequential awaits inside a loop',
    code: `// Fetches users and their posts — runs one DB call per user, sequentially
async function getUsersWithPosts(userIds) {
  const results = [];

  for (const id of userIds) {
    // Each iteration waits for both queries before starting the next
    const user  = await db.findUser(id);
    const posts = await db.findPostsByUser(id);
    results.push({ ...user, posts });
  }

  return results;
}

module.exports = { getUsersWithPosts };`,
  },
  {
    label: 'Missing Error Handling',
    description: 'Unguarded async calls and missing validation',
    code: `// Authentication helper — no input validation, no error handling
const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const User   = require('./models/User');

async function loginUser(username, password) {
  // No validation: username or password could be null / undefined
  const user    = await User.findOne({ username });
  const isMatch = await bcrypt.compare(password, user.password);
  // If user is null, user.password throws — and the error is unhandled

  if (isMatch) {
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    // JWT_SECRET could be undefined; sign() accepts it silently
    return { token };
  }

  return { error: 'Invalid credentials' };
}

module.exports = { loginUser };`,
  },
];

// ─── Markdown render config ───────────────────────────────────────────────────

const MD_COMPONENTS = {
  // ── Headings ──────────────────────────────────────────────────────────────
  h1: ({ children }) => (
    <h1 className="text-white text-base font-bold mt-6 mb-2 pb-1.5 border-b border-slate-800 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-white text-sm font-semibold mt-5 mb-2">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-slate-200 text-sm font-medium mt-4 mb-1.5">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-slate-300 text-xs font-semibold uppercase tracking-wider mt-3 mb-1">{children}</h4>
  ),

  // ── Body text ─────────────────────────────────────────────────────────────
  p: ({ children }) => (
    <p className="text-slate-300 text-sm leading-6 mb-3">{children}</p>
  ),

  // ── Lists ─────────────────────────────────────────────────────────────────
  ul: ({ children }) => (
    <ul className="list-disc pl-5 mb-3 space-y-1 text-slate-300 text-sm">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 mb-3 space-y-1 text-slate-300 text-sm">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="leading-6 text-slate-300">{children}</li>
  ),

  // ── Emphasis ──────────────────────────────────────────────────────────────
  strong: ({ children }) => (
    <strong className="text-white font-semibold">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="text-slate-400 italic">{children}</em>
  ),

  // ── Code ──────────────────────────────────────────────────────────────────
  // <pre> is always the wrapper for fenced code blocks.
  pre: ({ children }) => (
    <div className="my-4 rounded border border-slate-700/60 bg-slate-900 overflow-hidden">
      <pre className="overflow-x-auto p-4 text-xs font-mono leading-5">
        {children}
      </pre>
    </div>
  ),
  // <code> is called for BOTH inline code and the code inside <pre>.
  //
  // Distinguishing them reliably in react-markdown v10:
  //   • Labeled fenced block  (```js): className = "language-js"  → block
  //   • Unlabeled fenced block (```):  className = undefined, but children
  //     is a string containing '\n' because the block spans multiple lines → block
  //   • Inline code (`x`):             className = undefined, single-line   → inline
  code: ({ children, className }) => {
    const isBlock =
      Boolean(className) ||
      (typeof children === 'string' && children.includes('\n'));

    if (isBlock) {
      // Rendered inside the <pre> wrapper above; no background here.
      return (
        <code className="text-emerald-300/90 font-mono text-xs leading-5">
          {children}
        </code>
      );
    }
    // Inline code
    return (
      <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-indigo-300 break-words">
        {children}
      </code>
    );
  },

  // ── Block elements ────────────────────────────────────────────────────────
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-indigo-500/40 pl-4 my-3 text-slate-400 italic text-sm">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-slate-800 my-5" />,
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-indigo-400 underline underline-offset-2 hover:text-indigo-300 transition-colors"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),

  // ── GFM Tables ────────────────────────────────────────────────────────────
  // Enabled by remarkGfm. Without the plugin these elements never appear;
  // the raw | text | and |---| separators were rendering as plain paragraphs.
  table: ({ children }) => (
    <div className="overflow-x-auto my-4 rounded border border-slate-700/60">
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-slate-800/70 border-b border-slate-700/60">{children}</thead>
  ),
  tbody: ({ children }) => (
    <tbody className="divide-y divide-slate-800/60">{children}</tbody>
  ),
  tr: ({ children }) => (
    <tr className="transition-colors hover:bg-slate-800/30">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-300 uppercase tracking-wider whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2.5 text-xs text-slate-400 leading-relaxed align-top">
      {children}
    </td>
  ),
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Demo() {
  const [code, setCode] = useState(SNIPPETS[0].code);
  const [activeSnippet, setActiveSnippet] = useState(0);

  // 'idle' | 'loading' | 'success' | 'error'
  const [status, setStatus] = useState('idle');
  const [result, setResult] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // ── Snippet selection ──────────────────────────────────────────────────────

  function selectSnippet(idx) {
    setCode(SNIPPETS[idx].code);
    setActiveSnippet(idx);
    setStatus('idle');
    setResult('');
    setErrorMsg('');
  }

  function handleCodeChange(e) {
    setCode(e.target.value);
    setActiveSnippet(null); // deselect preset when user edits freely
  }

  // ── Analysis ──────────────────────────────────────────────────────────────

  async function handleAnalyze() {
    if (!code.trim() || code.length > MAX_CHARS || status === 'loading') return;

    setStatus('loading');
    setResult('');
    setErrorMsg('');

    try {
      let res;
      try {
        res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
      } catch {
        // fetch() itself throws a TypeError on network failure
        throw new Error(
          'Could not reach the server. Make sure the backend is running on port 5000.'
        );
      }

      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(
          `Server responded with HTTP ${res.status} and a non-JSON body.`
        );
      }

      if (!res.ok) {
        // Prefer the server's error message; fall back to a generic one
        throw new Error(data?.error || `Server error (HTTP ${res.status}).`);
      }

      if (typeof data.review !== 'string' || !data.review.trim()) {
        throw new Error(
          'The server returned an unexpected response format. Please try again.'
        );
      }

      setResult(data.review);
      setStatus('success');
    } catch (err) {
      setErrorMsg(err.message || 'An unexpected error occurred. Please try again.');
      setStatus('error');
    }
  }

  function handleReset() {
    setStatus('idle');
    setResult('');
    setErrorMsg('');
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  const charCount = code.length;
  const isOverLimit = charCount > MAX_CHARS;
  const isEmpty = !code.trim();
  const canSubmit = !isEmpty && !isOverLimit && status !== 'loading';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans">

      {/* ── Navbar ────────────────────────────────────────────────────────── */}
      <nav
        className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md"
        aria-label="Main navigation"
      >
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between h-14">
          <Link
            to="/"
            className="flex items-center gap-2.5 text-white font-semibold hover:text-indigo-300 transition-colors"
            aria-label="CodeGuard home"
          >
            <Code2 className="h-5 w-5 text-indigo-400" aria-hidden="true" />
            CodeGuard
          </Link>
          <div className="flex items-center gap-6">
            <span className="text-sm text-indigo-400 font-medium">Demo</span>
            <Link
              to="/login"
              className="flex items-center gap-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-4 py-1.5 rounded-md transition-colors"
            >
              <FaGithub className="h-4 w-4" aria-hidden="true" />
              Sign in
            </Link>
          </div>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-12">

        {/* ── Page header ─────────────────────────────────────────────────── */}
        <div className="mb-8">
          <div className="flex items-center gap-2.5 mb-4">
            <FlaskConical className="h-5 w-5 text-indigo-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold text-white tracking-tight">
              Live Code Review Demo
            </h1>
          </div>
          <p className="text-sm text-slate-400 leading-relaxed max-w-xl">
            Paste any code snippet below and CodeGuard will analyse it using the same
            Groq AI model that runs on real pull requests. No sign-in required. Results
            are not saved to the database.
          </p>
        </div>

        {/* ── Example snippet selector ────────────────────────────────────── */}
        <div className="mb-3">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
            Load an example
          </p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Example code snippets">
            {SNIPPETS.map((snippet, idx) => (
              <button
                key={snippet.label}
                type="button"
                onClick={() => selectSnippet(idx)}
                className={`text-xs px-3 py-1.5 rounded border font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 ${
                  activeSnippet === idx
                    ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-300'
                    : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600 hover:text-white'
                }`}
                aria-pressed={activeSnippet === idx}
                title={snippet.description}
              >
                {snippet.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Code editor ─────────────────────────────────────────────────── */}
        <div className="mb-4">
          <label htmlFor="code-input" className="sr-only">
            Code to review
          </label>
          <div
            className={`rounded-lg border overflow-hidden transition-colors ${
              isOverLimit
                ? 'border-red-500/50'
                : 'border-slate-700 focus-within:border-indigo-500/60'
            }`}
          >
            {/* Editor chrome */}
            <div className="flex items-center gap-2 px-4 py-2 bg-slate-950/60 border-b border-slate-800">
              <Terminal className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
              <span className="text-xs font-mono text-slate-500">code to review</span>
            </div>
            <textarea
              id="code-input"
              value={code}
              onChange={handleCodeChange}
              rows={16}
              spellCheck={false}
              aria-label="Paste or type the code you want reviewed"
              aria-describedby="char-counter"
              className="w-full bg-slate-950 px-4 py-4 text-sm font-mono text-slate-200 placeholder-slate-600 resize-y outline-none leading-relaxed"
              placeholder="Paste your code here…"
            />
          </div>

          {/* Character counter + limit */}
          <div
            id="char-counter"
            className="flex items-center justify-between mt-1.5 px-1"
            aria-live="polite"
            aria-atomic="true"
          >
            <span
              className={`text-xs font-mono tabular-nums ${
                isOverLimit
                  ? 'text-red-400'
                  : charCount > MAX_CHARS * 0.9
                  ? 'text-amber-400'
                  : 'text-slate-600'
              }`}
            >
              {charCount.toLocaleString()} / {MAX_CHARS.toLocaleString()} characters
            </span>
            {isOverLimit && (
              <span className="text-xs text-red-400" role="alert">
                Exceeds limit — shorten the snippet before analysing.
              </span>
            )}
          </div>
        </div>

        {/* ── Action row ──────────────────────────────────────────────────── */}
        <div className="flex items-center gap-4 mb-10">
          <button
            type="button"
            onClick={handleAnalyze}
            disabled={!canSubmit}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-medium text-sm px-5 py-2.5 rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
            aria-busy={status === 'loading'}
          >
            {status === 'loading' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Analysing…
              </>
            ) : (
              'Analyze Code'
            )}
          </button>

          {(status === 'success' || status === 'error') && (
            <button
              type="button"
              onClick={handleReset}
              className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-900 rounded"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Reset
            </button>
          )}
        </div>

        {/* ── Result panel ────────────────────────────────────────────────── */}
        {status === 'loading' && (
          <div
            className="flex flex-col items-center justify-center gap-4 py-16 text-slate-400"
            role="status"
            aria-live="polite"
            aria-label="Analysing your code"
          >
            <Loader2 className="h-8 w-8 animate-spin text-indigo-500" aria-hidden="true" />
            <div className="text-center">
              <p className="text-sm font-medium text-slate-300">Analysing your code…</p>
              <p className="text-xs text-slate-500 mt-1">
                Fetching a Groq review — this usually takes 5–15 seconds.
              </p>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div
            className="rounded-lg border border-red-500/20 bg-red-500/5 p-6"
            role="alert"
            aria-live="assertive"
          >
            <div className="flex items-start gap-3">
              <AlertCircle
                className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-semibold text-red-300 mb-1">Analysis failed</p>
                <p className="text-sm text-slate-400 leading-relaxed">{errorMsg}</p>
                <button
                  type="button"
                  onClick={handleAnalyze}
                  disabled={!canSubmit}
                  className="mt-4 text-xs text-indigo-400 hover:text-indigo-300 disabled:text-slate-600 transition-colors underline underline-offset-2 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 rounded"
                >
                  Try again
                </button>
              </div>
            </div>
          </div>
        )}

        {status === 'success' && result && (
          <section aria-labelledby="result-heading">
            {/* Result header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-400" aria-hidden="true" />
                <h2
                  id="result-heading"
                  className="text-sm font-semibold text-white"
                >
                  Review complete
                </h2>
              </div>
              <span className="text-xs font-mono text-slate-500">
                via Groq · openai/gpt-oss-20b
              </span>
            </div>

            {/* Review content */}
            <div className="rounded-lg border border-slate-800 bg-slate-950 px-6 py-5">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={MD_COMPONENTS}
              >
                {result}
              </ReactMarkdown>
            </div>

            {/* Disclaimer */}
            <p className="mt-4 text-xs text-slate-600 leading-relaxed">
              <span className="text-slate-500 font-medium">Note:</span> AI findings
              may be incomplete or incorrect. Always verify suggestions before applying
              them to production code.
            </p>
          </section>
        )}

        {/* ── Idle state hint ─────────────────────────────────────────────── */}
        {status === 'idle' && (
          <p className="text-xs text-slate-600 text-center py-4">
            Select an example above or paste your own code, then click{' '}
            <span className="text-slate-500">Analyze Code</span>.
          </p>
        )}

        {/* ── Back link ───────────────────────────────────────────────────── */}
        <div className="mt-12 pt-8 border-t border-slate-800/60">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-300 transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back to home
          </Link>
        </div>

      </main>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="border-t border-slate-800 mt-8" role="contentinfo">
        <div className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Code2 className="h-4 w-4 text-indigo-400/50" aria-hidden="true" />
            CodeGuard
          </div>
          <p className="text-xs text-slate-700 font-mono">
            React · Node.js · MongoDB · BullMQ · Groq AI · GitHub OAuth
          </p>
        </div>
      </footer>

    </div>
  );
}
