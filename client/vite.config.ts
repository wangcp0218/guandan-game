import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function resolveGitVersion() {
  if (process.env.VITE_GIT_VERSION) return process.env.VITE_GIT_VERSION.slice(0, 6);
  try {
    return execFileSync('git', ['rev-parse', '--short=6', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    try {
      return readFileSync(`${repositoryRoot}/.build-version`, 'utf8').trim().slice(0, 6);
    } catch {
      return '------';
    }
  }
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, repositoryRoot, '');
  const base = process.env.VITE_BASE_PATH || env.VITE_BASE_PATH
    || (command === 'build' ? process.env.PUBLIC_BASE_PATH || env.PUBLIC_BASE_PATH : '') || '/';
  return {
    base: base.endsWith('/') ? base : base + '/',
    plugins: [react()],
    define: {
      __GIT_VERSION__: JSON.stringify(resolveGitVersion()),
    },
    server: {
      port: 5173,
      proxy: {
        '/socket.io': {
          target: 'http://localhost:3000',
          ws: true,
        },
      },
    },
    build: {
      outDir: 'dist',
    },
  };
});
