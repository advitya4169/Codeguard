import React from "react";
import { FaGithub } from "react-icons/fa";
import { Code2 } from "lucide-react";

export default function Login() {
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

        <a
          href="http://localhost:5000/api/auth/github"
          className="flex items-center justify-center gap-3 w-full bg-white hover:bg-slate-200 text-slate-900 font-semibold py-3 px-4 rounded-lg transition"
        >
          <FaGithub className="h-5 w-5" />
          Continue with GitHub
        </a>

      </div>
    </div>
  );
}