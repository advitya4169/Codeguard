
import { FaGithub } from "react-icons/fa";
import { Code2 } from "lucide-react";
import { useSearchParams } from 'react-router-dom';
import { apiUrl } from '../config/api.js';

export default function Login() {
  const [searchParams] = useSearchParams();
  const oauthError = searchParams.get('error');
  const oauthMessages = {
    access_denied: {
      message: 'GitHub authorization was cancelled. You can continue by authorizing CodeGuard.',
      action: 'Authorize GitHub',
    },
    auth_failed: {
      message: 'GitHub sign-in could not be completed. Please try again.',
      action: 'Try GitHub again',
    },
    no_token: {
      message: 'GitHub sign-in did not return a session. Please try again.',
      action: 'Try GitHub again',
    },
  };
  const errorNotice = oauthMessages[oauthError];

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4 text-slate-100">
      <div className="max-w-md w-full bg-slate-950 rounded-xl border border-slate-800 p-8 text-center shadow-2xl">
        
        <div className="flex justify-center mb-6">
          <div className="bg-indigo-500/10 p-3 rounded-full border border-indigo-500/20">
            <Code2 className="h-10 w-10 text-indigo-400" />
          </div>
        </div>

        <h1 className="text-3xl font-bold tracking-tight text-white mb-2">
          CodeGuard
        </h1>

        <p className="text-slate-400 mb-8">
          AI-Powered GitHub Code Review Platform
        </p>

        {errorNotice && (
          <div className="mb-5 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-left" role="alert">
            <p className="text-sm leading-relaxed text-amber-100">{errorNotice.message}</p>
            <a
              href={apiUrl('/api/auth/github')}
              className="mt-2 inline-flex rounded text-sm font-semibold text-indigo-300 hover:text-indigo-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              {errorNotice.action}
            </a>
          </div>
        )}

        <a
          href={apiUrl('/api/auth/github')}
          className="flex items-center justify-center gap-3 w-full bg-white hover:bg-slate-200 text-slate-900 font-semibold py-3 px-4 rounded-lg transition"
        >
          <FaGithub className="h-5 w-5" />
          {errorNotice ? 'Reconnect with GitHub' : 'Continue with GitHub'}
        </a>

      </div>
    </div>
  );
}
