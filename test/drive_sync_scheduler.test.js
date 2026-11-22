import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createDriveSyncScheduler } from '../src/drive_sync_scheduler.js';

test('scheduler runs repeatedly without overlapping sync cycles', async () => {
  let activeRuns = 0;
  let maxActiveRuns = 0;
  let runs = 0;
  const scheduler = createDriveSyncScheduler({
    intervalMs: 5,
    run: async () => {
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      runs += 1;
      await delay(10);
      activeRuns -= 1;
    },
  });

  scheduler.start();
  await delay(45);
  scheduler.stop();

  assert.ok(runs >= 2);
  assert.equal(maxActiveRuns, 1);
});

test('scheduler reports failed cycles and continues running', async () => {
  const errors = [];
  let runs = 0;
  const scheduler = createDriveSyncScheduler({
    intervalMs: 5,
    logger: { error: (message) => errors.push(message) },
    run: async () => {
      runs += 1;
      if (runs === 1) throw Object.assign(new Error('failed'), { code: 'drive_error' });
    },
  });

  scheduler.start();
  await delay(25);
  scheduler.stop();

  assert.ok(runs >= 2);
  assert.deepEqual(errors, ['Automatic Drive sync failed (drive_error)']);
});
