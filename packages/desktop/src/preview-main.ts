import { homedir } from 'node:os';
import { applyPreviewEnvironment } from './preview-environment.js';

applyPreviewEnvironment(process.env, homedir(), process.platform);
// Import only after isolation is set: main resolves account stores and daemon roots during startup.
void import('./main.js');
