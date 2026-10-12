#!/usr/bin/env node
// Pure/mocked checks only. Never sends a notification or reads/writes TCC.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const compiled = ts.transpileModule(read('src/utils/nativeNotificationFeedback.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const controllerModule = { exports: {} };
new Function('exports', 'module', compiled)(controllerModule.exports, controllerModule);
const { createNotificationFeedbackController: create, parseNotificationSnapshot: parse } = controllerModule.exports;

const result = (revision, outcome = 'submission_failed', source = 'quota_alert') => ({ revision, outcome, source });
const snapshot = (revision, results = []) => ({ revision, authorization: 'unknown', delivery: 'unconfirmed', results });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function harness(options = {}) {
  let receive;
  let reads = 0;
  let listens = 0;
  let stops = 0;
  let view;
  const views = [];
  const controller = create({
    listen: async (callback) => {
      listens += 1;
      receive = callback;
      if (options.listen) return options.listen(() => { stops += 1; });
      return () => { stops += 1; };
    },
    read: () => { reads += 1; return options.read ? options.read() : Promise.resolve(snapshot(0)); },
  }, (next) => { view = next; views.push(next); });
  return { controller, emit: (value) => receive(value), views, get view() { return view; },
    get reads() { return reads; }, get listens() { return listens; }, get stops() { return stops; } };
}

test('parser accepts only truthful states and strips irrelevant/private payload fields', () => {
  const parsed = parse({ ...snapshot(1, [{ ...result(1), email: 'private@example.invalid', body: 'private' }]), rawError: 'private' });
  assert.deepEqual(parsed, snapshot(1, [result(1)]));
  assert.equal(parse({ ...snapshot(0), authorization: 'granted' }), null);
  assert.equal(parse({ ...snapshot(0), delivery: 'delivered' }), null);
});

test('parser rejects invalid revisions, outcomes and duplicate sources', () => {
  for (const value of [null, {}, snapshot(-1), snapshot(1.2), snapshot(1, [result(2)]),
    snapshot(1, [result(1, 'delivered')]), snapshot(1, [result(1), result(1)]), snapshot(1, [result(1, 'submitted', 'unknown')])]) {
    assert.equal(parse(value), null);
  }
});

test('startup and repeated start only read retained feedback; no prompt or send interface exists', async () => {
  const h = harness();
  await h.controller.start();
  await h.controller.start();
  assert.equal(h.listens, 1);
  assert.equal(h.reads, 1);
  assert.equal(h.view.visible, false);
  assert.deepEqual(h.view.snapshot, snapshot(0));
  h.controller.dispose();
});

test('successful submission stays quiet and never becomes permission/delivery success', async () => {
  const h = harness(); await h.controller.start();
  h.emit(snapshot(1, [result(1, 'submitted')]));
  assert.equal(h.view.visible, false);
  assert.equal(h.view.snapshot.authorization, 'unknown');
  assert.equal(h.view.snapshot.delivery, 'unconfirmed');
  await h.controller.refresh(true);
  assert.equal(h.view.visible, true);
  assert.equal(h.view.snapshot.revision, 1);
});

test('failure is visible; repeated outcome or unrelated source does not undo dismissal', async () => {
  const h = harness(); await h.controller.start();
  h.emit(snapshot(1, [result(1)])); assert.equal(h.view.visible, true);
  h.controller.dismiss();
  h.emit(snapshot(1, [result(1)])); assert.equal(h.view.visible, false);
  h.emit(snapshot(2, [result(1), result(2, 'submitted', 'floating_card_hidden')]));
  assert.equal(h.view.visible, false);
});

test('a new failure after recovery is meaningful and reopens feedback', async () => {
  const h = harness(); await h.controller.start();
  h.emit(snapshot(1, [result(1)])); h.controller.dismiss();
  h.emit(snapshot(2, [result(2, 'submitted')])); assert.equal(h.view.visible, false);
  h.emit(snapshot(3, [result(3)])); assert.equal(h.view.visible, true);
});

test('per-source feedback preserves both failures', async () => {
  const h = harness(); await h.controller.start();
  h.emit(snapshot(2, [result(1), result(2, 'identity_failed', 'floating_card_hidden')]));
  assert.equal(h.view.snapshot.results.length, 2);
  assert.equal(h.view.snapshot.results[1].outcome, 'identity_failed');
});

test('a late snapshot cannot replace a newer event', async () => {
  const read = deferred(); const h = harness({ read: () => read.promise });
  const started = h.controller.start(); await tick();
  h.emit(snapshot(2, [result(2)])); read.resolve(snapshot(1, [result(1, 'submitted')]));
  await started;
  assert.equal(h.view.snapshot.revision, 2);
  assert.equal(h.view.snapshot.results[0].outcome, 'submission_failed');
});

test('a late read failure cannot mask a newer valid event', async () => {
  const read = deferred(); const h = harness({ read: () => read.promise });
  const started = h.controller.start(); await tick();
  h.emit(snapshot(2, [result(2)])); read.reject(new Error('private path must not be shown'));
  await started;
  assert.equal(h.view.readFailed, false);
  assert.equal(h.view.snapshot.revision, 2);
});

test('synchronous read failure is recoverable and does not wedge refresh coalescing', async () => {
  let fail = true;
  const h = harness({ read: () => { if (fail) throw new Error('transient'); return Promise.resolve(snapshot(0)); } });
  await h.controller.start(); assert.equal(h.view.readFailed, true);
  fail = false; await h.controller.refresh(true);
  assert.equal(h.reads, 2); assert.equal(h.view.readFailed, false); assert.equal(h.view.visible, true);
});

test('concurrent refreshes share a read and an explicit action reopens feedback', async () => {
  const pending = deferred(); const h = harness({ read: () => pending.promise });
  const started = h.controller.start(); await tick();
  const first = h.controller.refresh(); const second = h.controller.refresh(true);
  assert.equal(h.reads, 1); assert.equal(h.view.visible, true);
  pending.resolve(snapshot(0)); await Promise.all([started, first, second]);
  assert.equal(h.view.reading, false);
});

test('unmount while registering listener releases late listener and never reads', async () => {
  const listening = deferred(); let stop;
  const h = harness({ listen: (callback) => { stop = callback; return listening.promise; } });
  const started = h.controller.start(); h.controller.dispose();
  listening.resolve(stop); await started;
  assert.equal(h.stops, 1); assert.equal(h.reads, 0); assert.equal(h.views.length, 0);
  h.emit(snapshot(1, [result(1)])); assert.equal(h.views.length, 0);
});

test('unmount during read prevents late state changes and duplicate cleanup', async () => {
  const pending = deferred(); const h = harness({ read: () => pending.promise });
  const started = h.controller.start(); await tick(); h.controller.dispose(); h.controller.dispose();
  const count = h.views.length;
  pending.resolve(snapshot(1, [result(1)])); await started;
  assert.equal(h.views.length, count); assert.equal(h.stops, 1);
});

test('listener failure still recovers retained feedback through read', async () => {
  const h = harness({ listen: async () => { throw new Error('unavailable'); }, read: async () => snapshot(1, [result(1)]) });
  await h.controller.start(); assert.equal(h.view.visible, true); assert.equal(h.view.snapshot.revision, 1);
});

test('focus refresh stays read-only and preserves dismissal until explicit user review', async () => {
  const h = harness({ read: async () => snapshot(1, [result(1)]) });
  await h.controller.start(); h.controller.dismiss();
  await h.controller.refresh(); assert.equal(h.view.visible, false);
  await h.controller.refresh(true); assert.equal(h.view.visible, true);
  assert.equal(h.reads, 3);
});

test('macOS callers, retained getter, UI and all locales are wired without preference mutations', () => {
  const account = read('src-tauri/src/modules/account.rs').split('#[cfg(target_os = "macos")]\npub fn send_quota_alert_native_notification')[1].split('\npub fn dispatch_quota_alert')[0];
  const floating = read('src-tauri/src/modules/floating_card_window.rs').split('#[cfg(target_os = "macos")]\nfn send_hidden_notification')[1];
  assert.match(account, /macos_notifications::submit/); assert.match(account, /Source::QuotaAlert/);
  assert.match(floating, /macos_notifications::submit/); assert.match(floating, /Source::FloatingCardHidden/);
  for (const source of [account, floating]) assert.doesNotMatch(source, /mac_notification_sys|save_user_config|request_permission/);
  const native = read('src-tauri/src/modules/macos_notifications.rs');
  assert.equal((native.match(/set_application\(/g) || []).length, 1);
  assert.equal((native.match(/notification\.send\(/g) || []).length, 1);
  assert.match(native, /wait_for_click\(false\)[\s\S]*asynchronous\(true\)/);
  assert.match(native, /static STATE: Mutex<NotificationState>/);
  assert.match(native, /"authorization": "unknown"/); assert.match(native, /"delivery": "unconfirmed"/);
  assert.match(native, /drop\(state\);[\s\S]*app\.emit/);
  const getter = read('src-tauri/src/commands/system.rs').split('pub fn get_macos_notification_feedback()')[1].split('\n#[tauri::command]')[0];
  assert.match(getter, /macos_notifications::snapshot/);
  assert.doesNotMatch(getter, /submit|send|set_application|request_permission/);
  assert.match(read('src-tauri/src/lib.rs'), /commands::system::get_macos_notification_feedback/);
  const ui = read('src/components/NativeNotificationFeedback.tsx');
  assert.match(ui, /current\.dispose\(\)/); assert.match(ui, /removeEventListener\('focus'/);
  assert.match(ui, /floatingInFlight\.current/); assert.match(ui, /mounted\.current/);
  assert.doesNotMatch(ui, /requestPermission|sendNotification|request_permission/);
  assert.match(read('src/App.tsx'), /<NativeNotificationFeedback onViewQuotas=\{\(\) => setPage\('dashboard'\)\}/);
  const english = JSON.parse(read('src/locales/en.json')).macosNotifications;
  for (const file of fs.readdirSync(path.join(root, 'src/locales')).filter((file) => file.endsWith('.json'))) {
    const strings = JSON.parse(read(`src/locales/${file}`)).macosNotifications;
    assert.deepEqual(Object.keys(strings).sort(), Object.keys(english).sort(), file);
    for (const value of Object.values(strings)) assert.ok(typeof value === 'string' && value.length > 0 && !value.includes('{{'));
  }
});

test('exact production Rust policy compiles and passes synthetic state tests', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-notifications-'));
  try {
    const binary = path.join(temp, process.platform === 'win32' ? 'tests.exe' : 'tests');
    for (const [command, args] of [
      [process.env.RUSTC || 'rustc', ['--edition=2021', '--test', path.join(root, 'src-tauri/src/modules/notification_feedback.rs'), '-o', binary]],
      [binary, []],
    ]) {
      const outcome = spawnSync(command, args, { stdio: 'inherit' });
      if (outcome.error) throw outcome.error;
      assert.equal(outcome.status, 0);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
