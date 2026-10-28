import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const shutdownGracePeriodMs = 10_000;
const childProcesses = [
  { name: 'API', entry: new URL('./server.js', import.meta.url) },
  { name: 'Worker', entry: new URL('./worker.js', import.meta.url) },
];

const children = new Map();
let shuttingDown = false;
let exitCode = 0;
let forceKillTimer;

const allChildrenClosed = () =>
  children.size === childProcesses.length && [...children.values()].every((child) => child.closed);

const finishIfClosed = () => {
  if (!shuttingDown || !allChildrenClosed()) return;
  clearTimeout(forceKillTimer);
  process.exitCode = exitCode;
};

const signalChildren = (signal) => {
  for (const child of children.values()) {
    if (!child.closed) child.process.kill(signal);
  }
};

const beginShutdown = (signal, code, reason) => {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;

  if (reason) console.error(reason);
  console.log(`Stopping API and worker with ${signal}.`);
  signalChildren(signal);

  forceKillTimer = setTimeout(() => signalChildren('SIGKILL'), shutdownGracePeriodMs);
  finishIfClosed();
};

for (const spec of childProcesses) {
  const child = spawn(process.execPath, [fileURLToPath(spec.entry)], { stdio: 'inherit' });
  const entry = { process: child, closed: false };
  children.set(spec.name, entry);

  child.once('error', (error) => {
    beginShutdown(
      'SIGTERM',
      1,
      `${spec.name} process could not start: ${error.message}`,
    );
  });

  child.once('close', (code, signal) => {
    entry.closed = true;
    if (!shuttingDown) {
      const result = signal ? `signal ${signal}` : `exit code ${code}`;
      beginShutdown('SIGTERM', 1, `${spec.name} process exited unexpectedly (${result}).`);
    }
    finishIfClosed();
  });
}

process.once('SIGTERM', () => beginShutdown('SIGTERM', 0));
process.once('SIGINT', () => beginShutdown('SIGINT', 0));
