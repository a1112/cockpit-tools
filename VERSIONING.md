# cockpit-tools version management

## Current authority

The existing source/package values below are preserved. They are not a claim that a product is stable or that these source commits were released. Independent applications, libraries, build tools and protocol/schema numbers are not reset to one repository-wide version.

- `crate-cockpit-cli`: `0.1.0` from `crates/cockpit-cli/Cargo.toml` (package.version); explicit local bump supported. Independent Rust package; no repository-wide release version is inferred.
- `crate-cockpit-core`: `0.1.0` from `crates/cockpit-core/Cargo.toml` (package.version); explicit local bump supported. Independent Rust package; no repository-wide release version is inferred.
- `crate-cockpit-tools`: `0.23.4` from `src-tauri/Cargo.toml` (package.version); explicit local bump supported. Independent Rust package; no repository-wide release version is inferred Tauri application packaging version is synchronized with its own Cargo package.

The machine-readable inventory is `versioning.json`. Cargo workspace inheritance and local lock entries are bound explicitly. Node lock root fields are distinct from registry dependency versions. Tauri versions are bound to their own package; different frontend numbers remain independent.

## Check and change

Python 3.11 or newer; standard library only. Run from the repository root.

```sh
python3 scripts/version_manager.py show
python3 scripts/version_manager.py check
python3 scripts/test_versioning.py -v
```

Choose a single unit. Preview is non-mutating; apply is explicit and should always include the observed current value:

```sh
python3 scripts/version_manager.py bump patch --unit crate-cockpit-cli
python3 scripts/version_manager.py bump patch --unit crate-cockpit-cli --expect 0.1.0 --apply
python3 scripts/version_manager.py check
```

`set NEW --unit NAME` also previews; add `--expect CURRENT --apply` only after review. For prereleases use `bump prerelease`; stable promotion requires explicit `--allow-stable`. The helper does not run Git, tags, package managers, release hooks, signing, installers or network requests. All source edits are validated before any write.

Check-only units intentionally refuse bump/set because native dependency resolution, existing tooling or historical/test-only ownership must be respected. Incoming local Cargo version requirements and Python workspace locks are not approximated by search-and-replace. Use the project’s native packaging process, update constraints/locks together, then rerun these checks.

## Release history and channels

- No release entry was returned in the repository release inventory reviewed on 2026-10-12. Absence here does not prove the project was never distributed.

This change creates no tag, release, publication, deployment or release date. Record future changes under Unreleased first; use the existing release process and tag namespace only after platform validation and explicit release approval.

## Scope and validation

The added CI checks metadata consistency and dependency-free version-manager safety only, with `contents: read`. Apply/idempotency/stale-source/mismatch checks use temporary fixtures. They do not establish that a native app builds, signs, installs or works on macOS/Windows/Linux. No native packaging or device acceptance was run for this adoption.

Generated Apple projects, vendored/upstream material, historical evidence, protocol/schema/database numbers and dependency versions remain outside product bumps. Existing runtime version mechanisms are retained; there is no UI redesign.

The local `cockpit-tools` package entry in `src-tauri/Cargo.lock` was corrected from `0.21.5` to authoritative Cargo/Node/Tauri `0.23.4`; all registry dependency records are retained.

## Adoption base

Source snapshot: [fix/macos-permission-recovery-2026-10-12 @ 6b23c9536b61](https://github.com/a1112/cockpit-tools/commit/6b23c9536b614f20b558a322d981b0d8ed17ab0b). Default branch `main` and all existing repair/tag refs are retained.

