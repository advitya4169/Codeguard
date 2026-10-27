import { Link } from 'react-router-dom';
import { FaGithub } from 'react-icons/fa';
import {
  Code2,
  GitPullRequest,
  ShieldAlert,
  AlertTriangle,
  Info,
  CheckCircle,
  Webhook,
  Terminal,
  Shield,
  Zap,
  Database,
  ArrowRight,
} from 'lucide-react';

// ─── Illustrative sample data ──────────────────────────────────────────────────
// These findings are fictional examples that show the review output format.
// They are not stored in the database and have no connection to any real repository.
const SAMPLE_FINDINGS = [
  {
    severity: 'critical',
    category: 'security',
    filePath: 'src/auth/middleware.js',
    lineNumber: 42,
    explanation:
      'JWT token is verified without an explicit algorithm allowlist. An attacker can substitute the "none" algorithm to bypass signature validation entirely.',
    suggestedFix: "jwt.verify(token, secret, { algorithms: ['HS256'] })",
  },
  {
    severity: 'high',
    category: 'bug',
    filePath: 'src/db/userQuery.js',
    lineNumber: 18,
    explanation:
      'User-supplied input is concatenated directly into the SQL query string. Any unsanitised value can alter the query structure at runtime.',
    suggestedFix: "db.query('SELECT * FROM users WHERE id = $1', [userId])",
  },
  {
    severity: 'medium',
    category: 'performance',
    filePath: 'src/api/repos.js',
    lineNumber: 67,
    explanation:
      'Sequential awaited calls inside a for...of loop prevent concurrent execution. Total latency increases linearly with the number of items.',
    suggestedFix: 'const results = await Promise.all(items.map(fetchData));',
  },
];

// Severity colours match the Dashboard exactly.
const SEVERITY_CONFIG = {
  critical:   { className: 'bg-red-500/10    text-red-400    border-red-500/20',    Icon: ShieldAlert   },
  high:       { className: 'bg-orange-500/10 text-orange-400 border-orange-500/20', Icon: AlertTriangle },
  medium:     { className: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20', Icon: AlertTriangle },
  low:        { className: 'bg-blue-500/10   text-blue-400   border-blue-500/20',   Icon: Info          },
  suggestion: { className: 'bg-slate-500/10  text-slate-400  border-slate-500/20',  Icon: CheckCircle   },
};

// ─── Actual workflow steps (mirrors the backend pipeline) ──────────────────────
const WORKFLOW_STEPS = [
  {
    number: '01',
    Icon: GitPullRequest,
    title: 'PR opened or updated',
    description:
      'A developer opens or pushes to a pull request on any connected GitHub repository.',
  },
  {
    number: '02',
    Icon: Webhook,
    title: 'Webhook received',
    description:
      'CodeGuard receives the signed webhook event, verifies the HMAC-SHA256 signature, and enqueues a review job.',
  },
  {
    number: '03',
    Icon: Terminal,
    title: 'AI diff analysis',
    description:
      'The PR diff is fetched, stripped of lock files and generated code, then analysed by Groq AI for bugs, security issues, performance problems and code quality.',
  },
  {
    number: '04',
    Icon: CheckCircle,
    title: 'Findings posted',
    description:
      'Structured findings are saved to the review dashboard and posted as a formatted comment directly on the GitHub pull request.',
  },
];

// ─── Verified capabilities only ───────────────────────────────────────────────
const FEATURES = [
  {
    Icon: GitPullRequest,
    title: 'Triggered on every PR',
    description:
      'Runs automatically when a pull request is opened or synchronised. No manual invocation required.',
  },
  {
    Icon: Shield,
    title: 'HMAC signature verification',
    description:
      'All incoming webhook payloads are verified with a cryptographic signature before any processing begins.',
  },
  {
    Icon: ShieldAlert,
    title: 'Five severity levels',
    description:
      'Each finding is graded critical, high, medium, low, or suggestion — with a matching icon and colour in both the dashboard and the GitHub comment.',
  },
  {
    Icon: Terminal,
    title: 'Five finding categories',
    description:
      'Bug, security, performance, code quality, and maintainability — each with a precise file path and line number.',
  },
  {
    Icon: Zap,
    title: 'Asynchronous queue',
    description:
      'BullMQ and Redis decouple webhook receipt from analysis. The webhook endpoint responds instantly; heavy work runs in the background.',
  },
  {
    Icon: Database,
    title: 'Persistent review history',
    description:
      'Every finding is stored in MongoDB. The per-repository dashboard shows the full history of automated reviews.',
  },
];

// ─── Shared sub-components ────────────────────────────────────────────────────

function SeverityBadge({ severity }) {
  const cfg = SEVERITY_CONFIG[severity] ?? SEVERITY_CONFIG.suggestion;
  const { Icon } = cfg;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-semibold font-mono tracking-wider ${cfg.className}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {severity.toUpperCase()}
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Landing() {
  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans">

      {/* ── Navbar ─────────────────────────────────────────────────────────── */}
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
            <Link
              to="/demo"
              className="text-sm text-slate-400 hover:text-slate-100 transition-colors"
            >
              Demo
            </Link>
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

      <main>

        {/* ── Hero ───────────────────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-6 pt-24 pb-20 text-center">
          <div className="inline-flex items-center gap-2 text-xs font-mono text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-3 py-1.5 rounded mb-8">
            <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
            GitHub-native pull request analysis
          </div>

          <h1 className="text-5xl sm:text-6xl font-bold text-white tracking-tight leading-tight mb-6">
            AI code review on
            <br className="hidden sm:block" />
            {' '}
            <span className="text-indigo-400">every pull request.</span>
          </h1>

          <p className="text-lg text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            CodeGuard connects to your GitHub repositories and automatically analyses each
            PR diff for bugs, security vulnerabilities, performance issues and code quality
            problems — posting structured findings directly onto the PR.
          </p>

          <div className="flex items-center justify-center gap-4 flex-wrap">
            <Link
              to="/demo"
              className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-100 font-medium px-6 py-3 rounded-md border border-slate-700 transition-colors"
            >
              Explore Live Demo
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <Link
              to="/login"
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-6 py-3 rounded-md transition-colors"
            >
              <FaGithub className="h-4 w-4" aria-hidden="true" />
              Connect GitHub
            </Link>
          </div>
        </section>

        {/* ── Product Preview ─────────────────────────────────────────────────── */}
        <section
          className="max-w-5xl mx-auto px-6 pb-24"
          aria-labelledby="preview-heading"
        >
          <h2 id="preview-heading" className="sr-only">Sample review output</h2>

          <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-950 shadow-xl shadow-black/30">

            {/* Window chrome */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/60 flex-wrap gap-2">
              <div className="flex items-center gap-3">
                {/* Traffic-light dots */}
                <div className="flex gap-1.5" aria-hidden="true">
                  <div className="w-3 h-3 rounded-full bg-slate-700" />
                  <div className="w-3 h-3 rounded-full bg-slate-700" />
                  <div className="w-3 h-3 rounded-full bg-slate-700" />
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <GitPullRequest className="h-4 w-4 text-indigo-400" aria-hidden="true" />
                  <span>
                    Pull Request <span className="font-mono">#47</span>
                  </span>
                  <span className="font-mono text-slate-700" aria-hidden="true">·</span>
                  <span className="font-mono text-slate-500">a3f8c12</span>
                </div>
              </div>
              <span
                className="text-xs font-medium text-amber-400/80 bg-amber-400/10 border border-amber-400/20 px-2.5 py-1 rounded font-mono"
                role="note"
                aria-label="This is illustrative sample data"
              >
                Sample output — illustrative only
              </span>
            </div>

            {/* Finding cards */}
            <div className="divide-y divide-slate-800/60">
              {SAMPLE_FINDINGS.map((finding, idx) => (
                <article key={idx} className="px-5 py-5">
                  <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
                    <div className="flex items-center gap-3 flex-wrap">
                      <SeverityBadge severity={finding.severity} />
                      <span className="text-xs font-mono text-slate-500 uppercase tracking-widest">
                        {finding.category.replace('_', '\u00a0')}
                      </span>
                    </div>
                    <span className="text-xs font-mono text-slate-400 bg-slate-900 px-2.5 py-1 rounded border border-slate-800 whitespace-nowrap">
                      {finding.filePath}
                      <span className="text-slate-600">:{finding.lineNumber}</span>
                    </span>
                  </div>

                  <p className="text-sm text-slate-300 leading-relaxed mb-3">
                    {finding.explanation}
                  </p>

                  <div className="bg-slate-900 rounded border border-slate-800 overflow-hidden">
                    <div className="text-xs font-mono text-indigo-300/70 px-3 py-1.5 border-b border-slate-800/60 bg-indigo-500/5 uppercase tracking-wider">
                      Suggested fix
                    </div>
                    <pre className="px-4 py-3 text-xs text-emerald-300/90 font-mono overflow-x-auto">
                      <code>{finding.suggestedFix}</code>
                    </pre>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ── How It Works ────────────────────────────────────────────────────── */}
        <section className="border-t border-slate-800 bg-slate-950/40">
          <div className="max-w-6xl mx-auto px-6 py-20">
            <h2 className="text-2xl font-bold text-white mb-1">How it works</h2>
            <p className="text-slate-500 text-sm mb-12">
              The full review pipeline runs automatically, end to end.
            </p>

            {/*
              gap-px with a coloured parent creates clean 1px dividers at every
              breakpoint without per-cell conditional border classes.
            */}
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-px bg-slate-800 border border-slate-800 rounded-lg overflow-hidden">
              {WORKFLOW_STEPS.map((step) => (
                <div key={step.number} className="bg-slate-950 p-6">
                  <div className="flex items-center gap-3 mb-4">
                    <span className="text-xs font-mono font-bold text-indigo-400/50">
                      {step.number}
                    </span>
                    <step.Icon className="h-4 w-4 text-indigo-400" aria-hidden="true" />
                  </div>
                  <h3 className="text-sm font-semibold text-white mb-2">{step.title}</h3>
                  <p className="text-xs text-slate-400 leading-relaxed">{step.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Features ────────────────────────────────────────────────────────── */}
        <section className="border-t border-slate-800">
          <div className="max-w-6xl mx-auto px-6 py-20">
            <h2 className="text-2xl font-bold text-white mb-1">Built for production</h2>
            <p className="text-slate-500 text-sm mb-12">
              Every capability listed here is implemented and active.
            </p>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-10 gap-y-8">
              {FEATURES.map((feature) => (
                <div key={feature.title} className="flex gap-4">
                  <div className="mt-0.5 flex-shrink-0">
                    <feature.Icon
                      className="h-4 w-4 text-indigo-400"
                      aria-hidden="true"
                    />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white mb-1">
                      {feature.title}
                    </h3>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      {feature.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Closing CTA ─────────────────────────────────────────────────────── */}
        <section className="border-t border-slate-800 bg-slate-950/40">
          <div className="max-w-6xl mx-auto px-6 py-24 text-center">
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4 tracking-tight">
              Stop reviewing blind spots manually.
            </h2>
            <p className="text-slate-400 mb-10 max-w-xl mx-auto text-sm leading-relaxed">
              Connect CodeGuard to a GitHub repository in minutes. Every pull request
              gets a structured AI review before it reaches your main branch.
            </p>
            <div className="flex items-center justify-center gap-6 flex-wrap">
              <Link
                to="/login"
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-6 py-3 rounded-md transition-colors"
              >
                <FaGithub className="h-4 w-4" aria-hidden="true" />
                Connect GitHub
              </Link>
              <Link
                to="/demo"
                className="text-sm text-slate-400 hover:text-slate-200 transition-colors underline underline-offset-4"
              >
                Try the demo first
              </Link>
            </div>
          </div>
        </section>

      </main>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="border-t border-slate-800" role="contentinfo">
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
