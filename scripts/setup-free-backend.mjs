import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPrivateKey,createPublicKey,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

export const projectId='handwash-log';
export const workerName='handwash-api';
const databaseName='handwash-log';
const failure=message=>{throw new Error(message);};

export function credentials({accountId,token,serviceAccountJson}){
 if(!/^[a-f0-9]{32}$/.test(accountId||''))failure('GitHub SecretのCLOUDFLARE_ACCOUNT_IDに32文字のアカウントIDを登録してください。');
 if(typeof token!=='string'||!token.trim())failure('GitHub SecretのCLOUDFLARE_API_TOKENを登録してください。');
 let account,key;
 try{account=JSON.parse(serviceAccountJson||'');}catch{failure('GitHub SecretのFIREBASE_SERVICE_ACCOUNTにサービスアカウントのJSONを登録してください。');}
 if(account?.project_id!==projectId||typeof account.client_email!=='string'||!account.client_email.endsWith('@'+projectId+'.iam.gserviceaccount.com')||typeof account.private_key!=='string')failure('Firebaseのサービスアカウントがhandwash-log用か確認してください。');
 try{key=createPrivateKey(account.private_key);}catch{failure('Firebaseの秘密鍵を読み込めません。JSONファイル全体を登録してください。');}
 if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<2048)failure('FirebaseのRSA秘密鍵を確認してください。');
 const publicKey=createPublicKey(key).export({type:'spki',format:'pem'}).toString();
 return {accountId,token,account,publicKey};
}

export async function prepareBackend(input,{fetcher=fetch}={}){
 const checked=credentials(input),{accountId,token}=checked;
 const base='https://api.cloudflare.com/client/v4/accounts/'+accountId;
 async function cf(path,method='GET',body,allowMissing=false){
  let response,data;try{response=await fetcher(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});data=await response.json();}catch{failure('Cloudflareに接続できません。しばらく待ってから再実行してください。');}
  if(allowMissing&&response.status===404)return null;
  if(!response.ok||data.success!==true)failure('Cloudflareの処理に失敗しました。APIトークンのWorkers Scripts・D1の編集権限を確認してください。'+(data.errors?.[0]?.code?' エラー番号: '+Number(data.errors[0].code):''));
  return data.result;
 }
 const current=await cf('/workers/scripts/'+workerName+'/settings','GET',undefined,true);
 let subdomain=await cf('/workers/subdomain','GET',undefined,true);
 if(!subdomain?.subdomain){subdomain=await cf('/workers/subdomain','PUT',{subdomain:'handwash-024masahiro-'+accountId.slice(0,8)});}
 if(typeof subdomain?.subdomain!=='string'||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain.subdomain))failure('Cloudflareのworkers.devサブドメインを確認してください。');
 const apiOrigin='https://'+workerName+'.'+subdomain.subdomain+'.workers.dev';
 if(current){
  if(!current.bindings?.some(binding=>binding.type==='plain_text'&&binding.name==='FIREBASE_PROJECT_ID'&&binding.text===projectId))failure('同名のWorkerがあるため変更を中止しました。保存先を確認してください。');
  let health;try{const response=await fetcher(apiOrigin+'/',{signal:AbortSignal.timeout(15000)});if(response.ok)health=await response.json();}catch{}
  if(!health||health.service!=='handwash-free')failure('既存のWorkerの状態を確認できません。初期設定を中止しました。');
  if(health.ready)failure('このWorkerは運用中です。初期設定を再実行して書き込みを停止することはできません。');
 }
 const databases=await cf('/d1/database?name='+databaseName+'&per_page=100');
 if(!Array.isArray(databases))failure('D1データベースの一覧を確認できません。');
 const matching=databases.filter(database=>database.name===databaseName);if(matching.length>1)failure('同名のD1データベースが複数あります。保存先を確認してください。');
 const database=matching[0]||await cf('/d1/database','POST',{name:databaseName});
 if(!/^[a-f0-9-]{36}$/.test(database?.uuid||''))failure('D1データベースのIDを確認できません。');
 if(current&&!current.bindings.some(binding=>binding.type==='d1'&&binding.name==='DB'&&binding.id===database.uuid))failure('既存WorkerのD1接続先が一致しません。変更を中止しました。');
 return {...checked,databaseId:database.uuid,apiOrigin};
}

export function workerConfiguration(template,prepared){
 return {...template,account_id:prepared.accountId,vars:{...template.vars,FIREBASE_PROJECT_ID:projectId,HANDWASH_MIGRATION_LOCK:'1'},d1_databases:[{...template.d1_databases[0],database_name:databaseName,database_id:prepared.databaseId}]};
}

async function runWrangler(directory,args,input,stage){
 await new Promise((done,reject)=>{
  const child=spawn(process.execPath,[resolve(directory,'node_modules/wrangler/bin/wrangler.js'),...args],{cwd:directory,env:{...process.env,CI:'1',WRANGLER_LOG:'error'},stdio:['pipe','ignore','ignore']});
  child.on('error',()=>reject(new Error(stage+'を開始できませんでした。')));
  child.on('close',code=>code===0?done():reject(new Error(stage+'に失敗しました。APIトークンの権限とGitHubの設定を確認してください。')));
  child.stdin.on('error',()=>{});child.stdin.end(input||'');
 });
}

async function main(){
 const directory=process.cwd(),prepared=await prepareBackend({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,serviceAccountJson:process.env.FIREBASE_SERVICE_ACCOUNT});
 const template=JSON.parse(await readFile(resolve(directory,'worker/wrangler.jsonc'),'utf8'));
 if(template.name!==workerName||template.main!=='index.mjs'||template.d1_databases?.[0]?.binding!=='DB')failure('検証済みのWorkerソースを使用してください。');
 const config=resolve(directory,'worker/wrangler.generated.json');
 await writeFile(config,JSON.stringify(workerConfiguration(template,prepared),null,2)+'\n',{mode:0o600});
 await runWrangler(directory,['d1','migrations','apply','DB','--remote','--config',config],undefined,'D1の初期設定');
 await runWrangler(directory,['deploy','--config',config],undefined,'Workerの公開');
 await runWrangler(directory,['secret','put','FIREBASE_SERVICE_ACCOUNT','--config',config],JSON.stringify(prepared.account)+'\n','Firebaseの管理用Secretの設定');
 let health;try{const response=await fetch(prepared.apiOrigin+'/',{signal:AbortSignal.timeout(15000)});health=await response.json();if(!response.ok)failure('新しいWorkerの状態を確認できません。');}catch{failure('新しいWorkerの状態を確認できません。');}
 if(health.service!=='handwash-free'||health.ready!==false)failure('移行ロックの確認に失敗しました。公開版を切り替えないでください。');
 const publicConfig={projectId,workerName,accountId:prepared.accountId,databaseId:prepared.databaseId,apiOrigin:prepared.apiOrigin,migrationLocked:true,migrationPublicKey:prepared.publicKey,migrationPublicKeySha256:createHash('sha256').update(prepared.publicKey).digest('hex')};
 await writeFile(resolve(directory,'backend-public-config.json'),JSON.stringify(publicConfig,null,2)+'\n');
 const summary='Cloudflare Freeの保存先を準備しました。\n\nAPI: '+prepared.apiOrigin+'\n\n移行ロックは有効です。既存データを移行してからGitHub Pagesを切り替えます。\n';
 if(process.env.GITHUB_STEP_SUMMARY)await writeFile(process.env.GITHUB_STEP_SUMMARY,summary,{flag:'a'});
 console.log(summary);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){main().catch(error=>{console.error(error.message);process.exitCode=1;});}
