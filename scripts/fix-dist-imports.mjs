import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const roots = process.argv.slice(2);
const importExportRe = /((?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"])(\.{1,2}\/[^'"?#]+)(['"])/g;
const dynamicRe = /(import\(['"])(\.{1,2}\/[^'"?#]+)(['"]\))/g;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && path.endsWith('.js')) await fix(path);
  }
}

function needsExtension(spec) {
  return !spec.endsWith('.js') && !spec.endsWith('.json') && !spec.endsWith('.node');
}

async function fix(path) {
  let source = await readFile(path, 'utf8');
  source = source.replace(importExportRe, (_, prefix, spec, suffix) => `${prefix}${needsExtension(spec) ? `${spec}.js` : spec}${suffix}`);
  source = source.replace(dynamicRe, (_, prefix, spec, suffix) => `${prefix}${needsExtension(spec) ? `${spec}.js` : spec}${suffix}`);
  await writeFile(path, source);
}

for (const root of roots) await walk(root);
