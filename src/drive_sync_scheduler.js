export function createDriveSyncScheduler({
  run,
  intervalMs = 60_000,
  logger = console,
}) {
  let timer = null;
  let running = null;
  let stopped = true;

  function schedule(delay = intervalMs) {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void runOnce();
    }, delay);
    timer.unref?.();
  }

  function runOnce() {
    if (running) return running;
    running = Promise.resolve()
      .then(run)
      .catch((error) => {
        const code = error?.code || error?.name || 'sync_error';
        logger.error(`Automatic Drive sync failed (${code})`);
      })
      .finally(() => {
        running = null;
        schedule();
      });
    return running;
  }

  return {
    start() {
      if (stopped) {
        stopped = false;
        schedule(0);
      }
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    runNow: runOnce,
  };
}
