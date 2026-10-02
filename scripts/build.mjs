import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const page = await readFile('public/index.html', 'utf8');
const script = page.match(/<script id="app-script">([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('App script missing');
const hash = createHash('sha256').update(script).digest('base64');
const csp = "default-src 'self'; script-src 'self' 'sha256-" + hash + "'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'";
const worker = (await readFile('src/worker.mjs', 'utf8')).replace("'__HANDWASH_PAGE__'", JSON.stringify(page)).replace("'__HANDWASH_CSP__'", JSON.stringify(csp));
await rm('dist', { recursive: true, force: true });
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await writeFile('dist/server/index.js', worker);
await cp('.openai/hosting.json', 'dist/.openai/hosting.json');
await cp('drizzle', 'dist/drizzle', { recursive: true });
await writeFile('dist/server/wrangler.json', JSON.stringify({
  name: 'handwash-log', main: 'index.js', compatibility_date: '2026-05-15',
  d1_databases: [{ binding: 'DB', database_name: 'handwash-log', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: '../drizzle' }],
}, null, 2));
console.log('Built Worker with private records and D1 migrations');
