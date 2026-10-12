#!/usr/bin/env node

// Synthetic, cross-platform regression checks. Never runs osascript, opens an
// app, changes TCC, or accesses a user's IDE/terminal. Requires rustc, not Cargo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const config = JSON.parse(read('src-tauri/tauri.conf.json'));
assert.equal(config.bundle.macOS.infoPlist, 'Info.plist');
assert.equal(config.bundle.macOS.entitlements, 'Entitlements.plist');
assert.notEqual(config.bundle.macOS.hardenedRuntime, false);
assert.match(read('src-tauri/Info.plist'), /<key>NSAppleEventsUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
assert.deepEqual([...read('src-tauri/Entitlements.plist').matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]), [
  'com.apple.security.automation.apple-events',
]);
assert.match(read('src-tauri/Entitlements.plist'), /<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\s*\/>/);

const requiredKeys = ['accessibilityDenied', 'automationDenied', 'backgroundDeferred', 'failed', 'targetUnavailable'];
for (const file of fs.readdirSync(path.join(root, 'src/locales')).filter((name) => name.endsWith('.json'))) {
  const strings = JSON.parse(read(`src/locales/${file}`)).macosAutomation;
  assert.deepEqual(Object.keys(strings).sort(), requiredKeys, `${file}: permission messages`);
  for (const [key, text] of Object.entries(strings)) {
    if (key !== 'backgroundDeferred') assert.ok(text.includes('{{target}}'), `${file}: ${key} target`);
    const tokens = [...new Set(text.match(/\{\{[^}]+\}\}/g))].sort();
    assert.deepEqual(tokens, key === 'backgroundDeferred' ? [] : key === 'failed' ? ['{{detail}}', '{{target}}'] : ['{{target}}']);
  }
}

// Guard the callers as well as the typed helper: denial must propagate BEFORE
// existing force-close code. These source checks are not native Mac acceptance.
const processSource = read('src-tauri/src/modules/process.rs');
assert.match(processSource, /graceful_close: Option<fn\(u32\) -> Result<\(\), String>>/);
assert.match(processSource, /graceful_close_fn\(\*pid\)\?;/);
assert.equal((processSource.match(/macos_automation::run_graceful_close\(/g) || []).length, 2);
assert.match(read('src-tauri/src/modules/windsurf_instance.rs'), /request_windsurf_graceful_close\(\*pid\)\?;/);
assert.equal((read('src-tauri/src/modules/zed_instance.rs').match(/quit_zed_app\(\)\?;/g) || []).length, 2);

for (const file of ['process', 'cursor_instance', 'kiro_instance', 'windsurf_instance', 'zed_instance']) {
  const source = read(`src-tauri/src/modules/${file}.rs`);
  assert.match(source, /macos_automation::run\(/, `${file}: focus handling`);
  assert.doesNotMatch(source, /Command::new\("(?:\/usr\/bin\/)?osascript"\)/, `${file}: no bypass`);
}
for (const file of ['codex_instance', 'gemini_instance']) {
  const source = read(`src-tauri/src/commands/${file}.rs`);
  assert.match(source, /macos_automation::run\(&script, target\)\?;/);
  assert.doesNotMatch(source, /Command::new\("osascript"\)/);
}

// Source-order guards tie the synthetic denied-close state test to the real
// transaction entry points, including code not runnable on this Linux harness.
const switchCommand = read('src-tauri/src/commands/account.rs').split('pub async fn switch_account(')[1].split('\n#[tauri::command]')[0];
const internalSwitch = read('src-tauri/src/modules/account.rs').split('pub async fn switch_account_internal(')[1].split('\nfn persist_switch_history')[0];
for (const source of [switchCommand, internalSwitch]) {
  const close = source.indexOf('close_antigravity_instances(');
  assert.ok(close >= 0);
  for (const operation of ['set_current_account_id(', 'update_default_settings(', 'write_profile(', 'write_service_machine_id(']) {
    assert.ok(source.indexOf(operation) > close, `Denied close must precede ${operation}`);
  }
}
const autoSwitch = read('src-tauri/src/modules/account.rs').split('async fn run_auto_switch_if_needed_inner()')[1].split('pub async fn run_auto_switch_if_needed()')[0];
const backgroundGuard = autoSwitch.indexOf('should_defer_background_restart(');
assert.ok(backgroundGuard >= 0 && backgroundGuard < autoSwitch.indexOf('switch_account_internal('));
const deferredBlock = autoSwitch.slice(backgroundGuard, autoSwitch.indexOf('let switched ='));
assert.match(deferredBlock, /macos:automation-deferred/);
assert.match(deferredBlock, /return Ok\(None\);/);
assert.doesNotMatch(deferredBlock, /osascript|set_current_account_id|write_profile|update_default_settings/);
const zedCommands = read('src-tauri/src/commands/zed.rs');
for (const [functionName, mutation] of [['inject_zed_account', 'inject_account('], ['zed_logout_current_account', 'clear_current_runtime_account(']]) {
  const source = zedCommands.split(`pub async fn ${functionName}(`)[1].split('\n#[tauri::command]')[0];
  assert.ok(source.indexOf('stop_default_session()?') >= 0);
  assert.ok(source.indexOf('stop_default_session()?') < source.indexOf(mutation));
  assert.match(source, /#\[cfg\(target_os = "macos"\)\][\s\S]*start_default_session\(\)/);
}
const app = read('src/App.tsx');
assert.match(app, /listen\('macos:automation-deferred'/);
assert.match(app, /if \(disposed\) return;/);
assert.match(app, /if \(disposed\) fn\(\);/);
assert.match(app, /setPage\('overview'\);[\s\S]*reduceMacosAutomationNotice\(state, 'dismiss'\)/);
assert.match(app, /page === 'overview'[\s\S]*<AccountsPage/);

// Compile the actual frontend reducer, then exercise repeated/late/dismissed
// events and a fresh frontend session. No browser or Tauri bridge is invoked.
const ts = require('typescript');
const compiled = ts.transpileModule(read('src/utils/macosAutomationNotice.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const reducerModule = { exports: {} };
new Function('exports', 'module', compiled)(reducerModule.exports, reducerModule);
const { reduceMacosAutomationNotice: reduceNotice } = reducerModule.exports;
assert.equal(reduceNotice('unseen', 'deferred'), 'visible');
assert.equal(reduceNotice('visible', 'deferred'), 'visible');
assert.equal(reduceNotice('visible', 'dismiss'), 'dismissed');
assert.equal(reduceNotice('dismissed', 'deferred'), 'dismissed');
assert.equal(reduceNotice('dismissed', 'dismiss'), 'dismissed');
assert.equal(reduceNotice('unseen', 'deferred'), 'visible');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-macos-permissions-'));
try {
  const modulePath = path.join(root, 'src-tauri/src/modules/macos_automation.rs').replace(/\\/g, '/');
  const harness = `
// Only unrelated application services are stubbed. The complete production
// classifier, output handling, and close policy are compiled without changes.
mod modules {
    pub mod config {
        pub struct Config { pub language: String }
        pub fn get_user_config() -> Config { Config { language: "en".into() } }
    }
    pub mod i18n {
        pub fn translate(_: &str, key: &str, _: &[(&str, &str)]) -> String { key.into() }
    }
    pub mod logger { pub fn log_warn(_: &str) {} }
}
#[path = ${JSON.stringify(modulePath)}]
mod macos_automation;
`;
  const harnessPath = path.join(temp, 'harness.rs');
  const binaryPath = path.join(temp, process.platform === 'win32' ? 'tests.exe' : 'tests');
  fs.writeFileSync(harnessPath, harness);
  const compiler = process.env.RUSTC || 'rustc';
  for (const [command, args] of [
    [compiler, ['--edition=2021', '--test', harnessPath, '-o', binaryPath]],
    [binaryPath, []],
  ]) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${command} failed`);
  }
  console.log('Permission declarations, 18 locales, caller contracts, and exact-source Rust fixtures passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
