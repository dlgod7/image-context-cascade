import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('packages/cli/dist', { recursive: true });
const source = await readFile('packages/cli/src/main.js', 'utf8');
await writeFile('packages/cli/dist/main.js', source.replace(/^#!.*\n/, '#!/usr/bin/env node\n'));
