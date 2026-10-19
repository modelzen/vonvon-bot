// Imported first by the CLI entry (s23f2), so the connection defaults are set before any other module of the daemon
// runs, whatever is imported later. Packages left out of the bundle still load before it, as the bundle's own
// `import`s; none of them connects as it loads.
import { tuneNetworkDefaults } from '../core/net-tuning';

tuneNetworkDefaults();
