import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { createAiCatalog } from '../server/ai-catalog.ts';

await mkdir('public/skills', { recursive: true });
const skillFiles = (await readdir('skills')).filter((name) => name.endsWith('.md'));
await Promise.all([
  ...skillFiles.map((name) => copyFile(`skills/${name}`, `public/skills/${name}`)),
  writeFile(
    'public/.well-known/ai-catalog.json',
    JSON.stringify(createAiCatalog('http://127.0.0.1:8787'), null, 2) + '\n',
  ),
]);
console.log(`Synced ${skillFiles.length} skills and regenerated the AI catalog.`);
