import assert from 'node:assert/strict';
import test from 'node:test';
import lifecycle from '../app/launch-lifecycle.cjs';

test('a normal open request activates the existing app without scheduling a relaunch', async () => {
  const events = [];
  const requests = lifecycle.createLaunchRequests({
    isShuttingDown: () => false,
    openWindow: () => events.push('open'),
    relaunch: () => events.push('relaunch'),
  });
  await requests.open();
  assert.deepEqual(events, ['open']);
});

test('an open request received during shutdown schedules a single relaunch', async () => {
  const events = [];
  let shuttingDown = false;
  const requests = lifecycle.createLaunchRequests({
    isShuttingDown: () => shuttingDown,
    openWindow: () => events.push('open'),
    relaunch: () => events.push('relaunch'),
  });
  shuttingDown = true;
  assert.deepEqual(events, []);
  await requests.open();
  await requests.open();
  requests.relaunch();
  assert.deepEqual(events, ['relaunch']);
});

test('explicit restart and incoming opens share the same relaunch reservation', async () => {
  let relaunches = 0;
  const requests = lifecycle.createLaunchRequests({
    isShuttingDown: () => true,
    openWindow: () => assert.fail('The app is quitting'),
    relaunch: () => relaunches++,
  });
  requests.relaunch();
  await requests.open();
  assert.equal(relaunches, 1);
});
