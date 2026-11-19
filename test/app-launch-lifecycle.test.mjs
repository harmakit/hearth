import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
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

test('the main process completes one shutdown and exits only after the service closes', async () => {
  const events = [];
  const closed = Promise.withResolvers();
  const app = Object.assign(new EventEmitter(), {
    setName() {},
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    quit: () => events.push('quit'),
    exit: code => events.push(['exit', code]),
  });
  const require = createRequire(new URL('../app/main.cjs', import.meta.url));
  const context = vm.createContext({
    require: module => module === 'electron'
      ? { app, protocol: { registerSchemesAsPrivileged() {} } }
      : require(module),
    process: { env: {}, platform: 'darwin', once() {} },
    __dirname: '/qa/app',
    console,
    clearInterval,
    setImmediate,
    testService: { close: () => { events.push('close'); return closed.promise; } },
  });
  vm.runInContext(readFileSync(new URL('../app/main.cjs', import.meta.url), 'utf8'), context);
  vm.runInContext('service = testService', context);

  const beforeQuit = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    app.emit('before-quit', event);
    return event.prevented;
  };
  assert.equal(beforeQuit(), true);
  assert.equal(beforeQuit(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['close']);
  closed.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['close', ['exit', 0]]);
});
