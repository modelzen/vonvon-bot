# Desktop update configuration

`desktop-update.json` is reviewed build input. An empty object disables delivery for preview builds. Release builds set `manifestURL` to the HTTPS update manifest and `teamIdentifier` to the Apple Developer Team ID. The build validates and embeds this file in `dist/update-config.json` inside the signed application.

The main process calls `desktopUpdateConfiguration` with Electron's application path and packaged state. On macOS it verifies the bundle with `codesign --verify --deep --strict`, requires a Developer ID Application signature, and matches the signature's TeamIdentifier to the embedded configuration. Development, ad-hoc, unsigned, invalid, and unconfigured builds cannot download updates. Windows signature eligibility is not implemented by this macOS-only gate.

The manifest contains `version` and `feedURL`. Both endpoints use HTTPS, and the native feed must have the same origin as the manifest. Download and installation are separate actions. A signed native feed and installation artifact still require end-to-end release verification.

Process ownership does not determine update ownership. An attached background service can execute the desktop's bundled Core. Core reports its distribution and CLI path through `/api/daemon`; only the actual global npm package can use npm updates. A bundled service updates with its desktop distribution.
