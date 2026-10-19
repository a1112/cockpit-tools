const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the actual scheduler without importing account stores or native services.
const source = fs.readFileSync(path.join(__dirname, '../src/utils/autoRefreshScheduler.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture(tasks, options = {}) {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    Date: { now: () => now },
    Promise,
    window: {
      setInterval(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
      clearInterval(id) { timers.delete(id); },
    },
  }, { filename: 'autoRefreshScheduler.cjs' });
  const scheduler = exports.createAutoRefreshScheduler(tasks, { tickMs: 1000, ...options });
  return {
    scheduler,
    timers,
    time(value) { now = value; },
    tick(value) { now = value; for (const callback of [...timers.values()]) callback(); },
  };
}

function task(key, run, extra = {}) {
  return { key, label: key, intervalMs: 5000, initialDelayMs: 1000, run, ...extra };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

test('stop prevents a due timer task from starting in a queued microtask', async () => {
  let calls = 0;
  const f = fixture([task('refresh', async () => { calls += 1; })]);
  f.scheduler.start();
  f.tick(1000);
  f.scheduler.stop();
  await flush();
  assert.equal(calls, 0);
  assert.equal(f.timers.size, 0);
});

test('stop also cancels an overdue task queued by start', async () => {
  let calls = 0;
  const f = fixture([task('refresh', async () => { calls += 1; })]);
  f.time(1000);
  f.scheduler.start();
  f.scheduler.stop();
  await flush();
  assert.equal(calls, 0);
  assert.equal(f.timers.size, 0);
});

test('stop cancels the next queued task after an in-flight refresh releases its slot', async () => {
  const first = deferred();
  const calls = [];
  let nextSelected = false;
  const f = fixture([
    task('a', async () => { calls.push('a'); await first.promise; }),
    task('b', async () => { calls.push('b'); }, {
      shouldSkip: () => { nextSelected = true; return false; },
    }),
  ]);
  f.scheduler.start();
  f.tick(1000);
  await flush();
  assert.deepEqual(calls, ['a']);
  first.resolve();
  // Interleave teardown at the real microtask boundary before the selected task runs.
  for (let i = 0; !nextSelected && i < 20; i += 1) await Promise.resolve();
  assert.equal(nextSelected, true);
  f.scheduler.stop();
  await flush();
  assert.deepEqual(calls, ['a']);
});

test('replacing a scheduler cannot start a refresh from the stopped instance', async () => {
  const calls = [];
  const old = fixture([task('old', async () => { calls.push('old'); })]);
  old.scheduler.start();
  old.tick(1000);
  old.scheduler.stop();
  const current = fixture([task('current', async () => { calls.push('current'); })]);
  current.scheduler.start();
  current.tick(1000);
  await flush();
  current.scheduler.stop();
  assert.deepEqual(calls, ['current']);
});

test('an already-started refresh may settle without starting waiting work after stop', async () => {
  const first = deferred();
  const calls = [];
  const f = fixture([
    task('a', async () => { calls.push('a'); await first.promise; }),
    task('b', async () => { calls.push('b'); }),
  ]);
  f.scheduler.start();
  f.tick(1000);
  await flush();
  assert.deepEqual(calls, ['a']);
  f.scheduler.stop();
  first.resolve();
  await flush();
  assert.deepEqual(calls, ['a']);
  assert.equal(f.timers.size, 0);
});

test('normal scheduling preserves its concurrency budget and releases the next due task', async () => {
  const first = deferred();
  const calls = [];
  const f = fixture([
    task('a', async () => { calls.push('a'); await first.promise; }),
    task('b', async () => { calls.push('b'); }),
  ]);
  f.scheduler.start();
  f.tick(1000);
  await flush();
  f.tick(2000);
  await flush();
  assert.deepEqual(calls, ['a']);
  first.resolve();
  await flush();
  assert.deepEqual(calls, ['a', 'b']);
  f.scheduler.stop();
});

test('start and stop remain idempotent and a stopped timer callback is inert', async () => {
  let calls = 0;
  const f = fixture([task('refresh', async () => { calls += 1; })]);
  f.scheduler.start();
  f.scheduler.start();
  assert.equal(f.timers.size, 1);
  const staleTick = [...f.timers.values()][0];
  f.scheduler.stop();
  f.scheduler.stop();
  f.scheduler.start();
  f.time(1000);
  staleTick();
  await flush();
  assert.equal(calls, 0);
  assert.equal(f.timers.size, 0);
});
