/**
 * PM2 settings for the DavoChain API on the live server (Reports/PM2_VPS_GUIDE.md).
 *
 *   pm2 startOrReload ecosystem.config.js --update-env
 *
 * Runs the built API (`npm run build` → dist/main.js). Settings come from
 * api/.env, as in development; NODE_ENV is forced to production here.
 *
 * One copy ("fork"). The API is safe to run as several (background jobs take a
 * shared lock in Redis), so `instances` can go up later if one CPU is not enough.
 */
module.exports = {
  apps: [
    {
      name: 'davochain-api',
      cwd: __dirname,
      script: 'dist/main.js',
      // Error lines point at the TypeScript files, not the compiled ones.
      node_args: '--enable-source-maps',
      exec_mode: 'fork',
      instances: 1,
      env: { NODE_ENV: 'production' },
      // Give queued jobs and open requests time to finish on a restart (the API
      // listens for the stop signal: enableShutdownHooks in main.ts).
      kill_timeout: 20_000,
      // A crash loop waits a little longer each time instead of spinning.
      exp_backoff_restart_delay: 200,
      // A memory leak restarts it rather than slowing the whole server down.
      max_memory_restart: '1G',
      time: true,
    },
  ],
};
