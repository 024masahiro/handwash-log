import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {freeMigrationPlan,sameProfiles,sameWashes,quote} from './free-migration-plan.mjs';
const args=process.argv.slice(2),option=name=>args[args.indexOf(name)+1];
for(const flag of ['--backup','--project','--out','--config'])if(!args.includes(flag)||!option(flag)||option(flag).startsWith('--'))throw new Error(flag+' を指定してください。');
const plan=freeMigrationPlan(JSON.parse(await readFile(option('--backup'),'utf8')),option('--project')),out=resolve(option('--out'));
const manifest=JSON.parse(await readFile(resolve(out,'manifest.json'),'utf8')),sqlPath=resolve(out,'records.sql');
if(manifest.project!==option('--project')||manifest.digest!==plan.digest||manifest.sqlDigest!==createHash('sha256').update(await readFile(sqlPath)).digest('hex'))throw new Error('移行用SQL・元データ・プロジェクトが一致しません。');
console.log('D1の移行対象',plan.summary);
if(!args.includes('--apply')){console.log('確認のみ。実行には --apply が必要です。');process.exit(0);}
const config=JSON.parse(await readFile(option('--config'),'utf8'));
if(config.vars?.FIREBASE_PROJECT_ID!==option('--project')||config.vars?.HANDWASH_MIGRATION_LOCK!=='1'||!config.d1_databases?.some(db=>db.binding==='DB'&&/^[a-f0-9-]{36}$/.test(db.database_id)))throw new Error('移行先DB・Firebase ID・移行中のロックを確認してください。設定はJSON形式で保存してください。');
const authState=JSON.parse(await readFile(resolve(out,'auth-state.json'),'utf8'));
if(authState.project!==manifest.project||authState.digest!==plan.digest||authState.state!=='complete')throw new Error('先に認証情報の移行を完了してください。');
const wrangler=resolve('node_modules/wrangler/bin/wrangler.js'),exec=promisify(execFile);
async function command(flags){
 try{const {stdout}=await exec(process.execPath,[wrangler,'d1','execute','DB','--config',resolve(option('--config')),'--remote','--yes','--json',...flags],{maxBuffer:32*1024*1024});const result=JSON.parse(stdout);if(!Array.isArray(result)||result.some(row=>row.success===false))throw new Error();return result;}catch{throw new Error('D1の処理を完了できませんでした。Cloudflareのログイン・DB設定・無料枠を確認してください。');}
}
const query=async sql=>(await command(['--command',sql])).flatMap(row=>row.results||[]);
const markers=await query("SELECT digest,state FROM migration_state WHERE key='legacy'");
if(markers.length&&markers[0].digest!==plan.digest)throw new Error('別のバックアップが移行済みです。');
if(!markers.length){const counts=await query('SELECT (SELECT COUNT(*) FROM staff) AS profiles,(SELECT COUNT(*) FROM washes) AS records');if(counts[0]?.profiles!==0||counts[0]?.records!==0)throw new Error('初回の移行先は空である必要があります。');}
if(markers[0]?.state!=='complete')await command(['--file',sqlPath]);
async function rows(table){const all=[];let after='';do{const page=await query(`SELECT * FROM ${table} WHERE id>${quote(after)} ORDER BY id LIMIT 1000`);all.push(...page);if(page.length<1000)return all;after=page.at(-1).id;}while(true);}
const profiles=await rows('staff'),records=await rows('washes');
if(!sameProfiles(profiles,plan)||!sameWashes(records,plan))throw new Error('移行した名簿・記録が元データと一致しません。公開を切り替えないでください。');
await query(`UPDATE migration_state SET state='complete',completed_at=${Date.now()} WHERE key='legacy' AND digest=${quote(plan.digest)}`);
console.log('名簿・手洗い記録を全行照合し、移行完了を記録しました。',plan.summary);
