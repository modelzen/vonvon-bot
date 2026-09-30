# Desktop development

The production application uses Electron 44.4.5, React 19.1.0, and the approved Agent and group interface. Main owns an observed projection of the independent Bridge Host. The sandboxed renderer uses only the typed `watch` and `run` preload API. Existing bindings show directory, execution tool, and conversation kind as read-only. Response and permission changes go through the core HTTP API.

## Build and test

```sh
npm ci
npm run typecheck
npm test
npm run build
```

A runnable application also needs the pinned Node/npm runtime and a reviewed core artifact. `runtime-lock.json` supports macOS arm64 and Windows x64. The official Node distribution remains intact outside asar. Core production dependencies are installed with its exact source lock using `npm ci --omit=dev --ignore-scripts`. No global Node, npm, or Codex installation is required by the packaged application.

## Reviewed core pin

The core is independently developed and released. Its distribution is vendored as a tarball with the reviewed commit, repository, artifact digest, source lock digest, and pack command. Update that pin from reviewed inputs.

```sh
node scripts/pin-core.mjs /path/to/core.tgz /path/to/package-lock.json /path/to/provenance.json
npm run prepare:runtime -- darwin-arm64
npm run package:mac
```

Use `win32-x64` and `package:win` on native Windows. The package hook rejects development overrides and unsupported architectures. CI runs on `macos-15` arm64 and `windows-2025` x64. `vendor/core/provenance.json` records the reviewed companion-core artifact and its exact source commit.

## Development preview

A reviewed Host baseline can be staged before its companion routes are available. This is explicitly marked as development provenance. Unsupported routes display the core refusal. They are never replaced by successful local simulations.

```sh
VONVON_NODE_ARCHIVE=/path/to/official-node-archive.tar.gz \
VONVON_CORE_DEV_ARTIFACT=/path/to/core.tgz \
VONVON_CORE_DEV_LOCK=/path/to/package-lock.json \
VONVON_CORE_DEV_PROVENANCE=/path/to/provenance.json \
npm run prepare:runtime -- darwin-arm64
npm run package:preview:mac
```

The preview is `release/mac-arm64/Vonvon Bot Preview.app`. It is unsigned and not notarized. Preview packaging must be requested explicitly and labels the application Preview. Normal release packaging rejects this runtime.

## Isolated native verification

```sh
npm run build
npm run test:native
```

The runner generates and tests both fresh and existing-user homes without external fixture files. Each run isolates HOME, USERPROFILE, CODEX_HOME, XDG directories and Electron userData. Existing fixtures start in the legacy data directory and contain two inactive Agents, shared group memberships, and an unsupported saved backend. They contain no credentials. The runner checks exact configuration preservation, IPC rejection, hide-to-tray behavior, and owned Host shutdown. It never modifies login items or sends Feishu messages.

CI queries the real OS service state. A developer Mac with a registered service can explicitly use `npm run test:native -- --os-service-fixture=absent`. That flag creates test-only `launchctl list` and broad `ps -axo` fixtures. Other process queries use the OS, and every service mutation is refused. It is rejected in CI and on other platforms. Evidence records the fixture declaration. Production Host admission is unchanged.

The additional macOS arm64 parity runner exercises offline data migration, conflicting stores and retry, local Agent deletion guards, stopped settings, and owned Host restart:

```sh
npm run build
node scripts/test-parity-native.mjs --os-service-fixture=absent
```

It uses hidden Electron windows, the real preload and bundled Core, isolated homes, and synthetic encrypted secrets. Results are written under `.audit/macos-round2/`. These probes establish local lifecycle behavior; connected-bot recovery, deletion confirmation, attached system services, and external Feishu behavior still need separate acceptance evidence. The [parity cases](docs/parity/README.md) define those complete requirements. Partial checks must remain distinct from complete case passes.

## Lifecycle and limitations

Window close hides to the menu bar or tray. Explicit quit cancels application-owned operations and awaits Host cleanup. Attached services only detach. A failed cleanup keeps the app visible. Agent enable changes and completed QR registration restart only an owned Host. Attached services show restart required.

The app never sends an invisible sample task. First collaboration requires a real task sent by the user in Feishu and a real reply from the selected workspace. Native Windows install, cancellation, and shutdown validation, signed releases, and that live Feishu acceptance remain open. Authentication status is shown only from the core probe; Claude authorization remains unknown until a real task establishes it.
