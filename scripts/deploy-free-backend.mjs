import {readFile,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {workerConfiguration,projectId,workerName} from './setup-free-backend.mjs';

export function deploymentConfiguration(template,connection,settings,accountId){
  const binding=name=>settings.bindings?.find(row=>row.name===name);
  if(!/^[a-f0-9]{32}$/.test(accountId||'')||connection.accountId!==accountId||connection.projectId!==projectId||connection.workerName!==workerName||connection.apiOrigin!=='https://handwash-api.024masahiro.workers.dev'||!/^[a-f0-9-]{36}$/.test(connection.databaseId||''))throw new Error('運用中の保存先と一致しません。');
  if(template.name!==workerName||template.main!=='index.mjs'||template.d1_databases?.[0]?.binding!=='DB')throw new Error('Workerの公開設定を確認してください。');
  if(binding('DB')?.type!=='d1'||binding('DB')?.id!==connection.databaseId||binding('FIREBASE_PROJECT_ID')?.text!==projectId||binding('FIREBASE_SERVICE_ACCOUNT')?.type!=='secret_text'||binding('HANDWASH_MIGRATION_LOCK')?.text!=='0')throw new Error('接続先または運用状態が一致しないため、更新を中止しました。');
  if(settings.bindings.some(row=>!['DB','FIREBASE_PROJECT_ID','FIREBASE_SERVICE_ACCOUNT','HANDWASH_MIGRATION_LOCK'].includes(row.name)))throw new Error('想定外の接続設定があるため、更新を中止しました。');
  const config=workerConfiguration(template,{accountId,databaseId:connection.databaseId});
  config.vars.HANDWASH_MIGRATION_LOCK='0';config.keep_vars=true;
  return config;
}

async function main(){
  if(process.env.GITHUB_REPOSITORY!=='024masahiro/handwash-log'||process.env.GITHUB_REF!=='refs/heads/main'||process.env.GITHUB_ACTOR!=='024masahiro')throw new Error('所有者によるmainブランチの公開処理から実行してください。');
  const accountId=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
  if(!/^[a-f0-9]{32}$/.test(accountId||'')||!token?.trim())throw new Error('CloudflareのGitHub Secretsを確認してください。');
  const connection=JSON.parse(await readFile('backend-public-config.json','utf8'));
  if(connection.accountId!==accountId)throw new Error('保存先のアカウントが一致しません。');
  let settings;
  try{
    const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+accountId+'/workers/scripts/'+workerName+'/settings',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)});
    const data=await response.json();if(!response.ok||data.success!==true)throw new Error();settings=data.result;
  }catch{throw new Error('Cloudflareの運用設定を確認できません。');}
  const template=JSON.parse(await readFile('worker/wrangler.jsonc','utf8'));
  const config=deploymentConfiguration(template,connection,settings,accountId);
  const health=async()=>{const response=await fetch(connection.apiOrigin+'/',{cache:'no-store',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('保存先の稼働状態を確認できません。');return response.json();};
  const before=await health();if(before.service!=='handwash-free'||before.ready!==true)throw new Error('運用中の保存先を確認できないため、更新を中止しました。');
  const path=resolve('worker/wrangler.generated.json');
  try{
    await writeFile(path,JSON.stringify(config),{mode:0o600});
    try{await promisify(execFile)(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'deploy','--keep-vars','--config',path],{env:{...process.env,CI:'1',WRANGLER_LOG:'log',WRANGLER_WRITE_LOGS:'false'},maxBuffer:8*1024*1024});}
    catch{throw new Error('Workerの更新に失敗しました。公開画面は切り替えていません。');}
    const after=await health();if(after.service!=='handwash-free'||after.ready!==true||after.features?.dailyRanking!==true)throw new Error('更新したランキングAPIの稼働を確認できません。');
    const response=await fetch(connection.apiOrigin+'/api/ranking',{headers:{Origin:'https://024masahiro.github.io'},signal:AbortSignal.timeout(30000)});
    if(response.status!==401)throw new Error('ランキングのログイン制限を確認できません。');
    console.log('既存の保存先を保持してランキングAPIを更新しました。ログイン制限も確認済みです。');
  }finally{await rm(path,{force:true});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){main().catch(error=>{console.error(error.message);process.exitCode=1;});}
