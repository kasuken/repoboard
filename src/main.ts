import '@vscode/codicons/dist/codicon.css';
import './ui/theme.css';
import './ui/dashboard.css';
import './ui/app.css';
import { loadHost } from './host';
import { startCore } from './core/app';

// The core registers its message handler before the UI sends `ready` (bridge buffers either way).
const host = await loadHost();
await startCore(host);
await import('./ui/main');
