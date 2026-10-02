import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
const archive = resolve(process.argv[2] || '/tmp/handwash-log-site.tar.gz');
const manifest = JSON.parse(await readFile('.openai/hosting.json','utf8'));
if(!manifest.project_id || manifest.d1 !== 'DB') throw new Error('Missing Site identity or database declaration');
// Sites requires the Worker at dist/server/index.js and Drizzle migrations at
// the project root. Include the generated build directory alongside the SQL.
const result = spawnSync('tar',['-czf',archive,'.openai','dist/server','dist/drizzle','drizzle'],{encoding:'utf8'});
if(result.status !== 0) throw new Error(result.stderr || 'Packaging failed');
console.log(JSON.stringify({ archive }));
