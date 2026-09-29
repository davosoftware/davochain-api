#!/usr/bin/env node
/**
 * Free the dev port before starting.
 *
 * Ctrl+C in a VS Code terminal does not reliably kill node on Windows, so a
 * previous run keeps holding :3000 and the next start dies with a raw
 * EADDRINUSE stack trace that says nothing about the cause.
 *
 * This kills the stale listener and says exactly what it killed — never
 * silently, so it can't mask something you meant to keep running.
 *
 *   node scripts/free-port.mjs [port]
 */
import { execSync } from 'node:child_process';

const port = Number(process.argv[2] ?? process.env.PORT ?? 3000);
const isWindows = process.platform === 'win32';

const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return ''; // no match — the tools exit non-zero when nothing is found
  }
};

function listeners() {
  const pids = new Set();

  if (isWindows) {
    for (const line of sh(`netstat -ano -p tcp`).split('\n')) {
      // e.g.  TCP    0.0.0.0:3000   0.0.0.0:0   LISTENING   26628
      if (!line.includes('LISTENING')) continue;
      const cols = line.trim().split(/\s+/);
      const local = cols[1] ?? '';
      const pid = cols[cols.length - 1];
      if (local.endsWith(`:${port}`) && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
    }
  } else {
    for (const pid of sh(`lsof -ti tcp:${port} -sTCP:LISTEN`).split('\n')) {
      if (pid.trim()) pids.add(pid.trim());
    }
  }

  return [...pids];
}

function describe(pid) {
  if (isWindows) {
    const out = sh(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
    const name = out.split(',')[0]?.replace(/"/g, '').trim();
    return name || 'unknown';
  }
  return sh(`ps -p ${pid} -o comm=`).trim() || 'unknown';
}

const found = listeners();

if (found.length === 0) {
  process.exit(0); // nothing to do — stay quiet on the happy path
}

for (const pid of found) {
  const name = describe(pid);
  // Refuse to touch anything that is not a node process. If something else is
  // on this port that is a configuration problem, not a stale dev server.
  if (!/node/i.test(name)) {
    console.error(
      `\n  Port ${port} is held by PID ${pid} (${name}), which is not a node process.\n` +
        `  Refusing to kill it. Stop it yourself, or set PORT to something else.\n`,
    );
    process.exit(1);
  }

  sh(isWindows ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`);
  console.log(`  freed port ${port} — killed stale ${name} (PID ${pid})`);
}
