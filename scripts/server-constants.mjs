// What the standalone server's packages, manifest and install scripts agree on (docs/plans/server-3-update-engine.md C1,
// C2; docs/plans/server-5-release.md 4.1). install.sh keeps its own copy of the address, and packages/daemon/server-update.json
// its own; scripts/server-update-signing.test.mjs checks that both equal these.

/** Only Linux has a script-installed server (owner 2026-11-01); standalone-manifest.ts SERVER_TARGETS lists the same two. */
export const PUBLISHED_TARGETS = ['linux-x64', 'linux-arm64'];
export const archiveName = (version, target) => `vonvon-server-${version}-${target}.tar.gz`;
/** The public address of everything under the COS prefix below, without a trailing slash. */
export const SERVER_BASE_URL = 'https://dl.vonvon.cc/bot/server';
export const SERVER_PREFIX = 'bot/server/';
/** The two scripts that live at the top of the prefix, next to stable/. */
export const SERVER_SCRIPTS = ['install.sh', 'uninstall.sh'];
export const installCommand = `sh -c "$(curl -fsSL ${SERVER_BASE_URL}/install.sh)"`;
export const uninstallCommand = `sh -c "$(curl -fsSL ${SERVER_BASE_URL}/uninstall.sh)"`;
