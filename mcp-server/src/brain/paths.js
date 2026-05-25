import { join } from 'node:path';
import { readLayoutVersion } from './layout-sentinel.js';

export function resolveBrainPaths(repoRoot) {
  const layoutVersion = readLayoutVersion(repoRoot);
  const contentDir = layoutVersion >= 2 ? join(repoRoot, 'ijfw') : join(repoRoot, '.ijfw');
  return {
    layoutVersion,
    contentDir,
    memoryDir:     join(contentDir, 'memory'),
    sessionsDir:   join(contentDir, 'sessions'),
    dumpInbox:     join(contentDir, 'dump', 'inbox'),
    dumpProcessed: join(contentDir, 'dump', 'processed'),
    wikiDir:       join(contentDir, 'wiki'),
    wikiIndex:     join(contentDir, 'wiki', 'index.md'),
    wikiLog:       join(contentDir, 'wiki', 'log.md'),
    // internal always under .ijfw/
    indexDb:     join(repoRoot, '.ijfw', 'index', 'memory.db'),
    stateDir:    join(repoRoot, '.ijfw', 'state'),
    metricsDir:  join(repoRoot, '.ijfw', 'metrics'),
    receiptsDir: join(repoRoot, '.ijfw', 'receipts'),
    factsJsonl:  join(repoRoot, '.ijfw', 'facts.jsonl'),
  };
}

export const brainPaths = resolveBrainPaths;
