import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomUUID,randomBytes,pbkdf2Sync} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {credentials,workerConfiguration,projectId,workerName} from './setup-free-backend.mjs';
import {decryptBackup,sha256} from './migration-envelope.mjs';

class OperationError extends Error{}
const fail=message=>{throw new OperationError(message);};
export function resumeStage(marker,digest){
 if(!marker)return 'new';
 if(marker.digest!==digest)fail('別のバックアップの移行が記録されています。');
 if(!['auth-importing','records-importing','importing','complete'].includes(marker.state))fail('移行状態を確認してください。');
 return marker.state;
}

async function main(){
 const operation=process.env.HANDWASH_OPERATION;
 if(!['preflight','migrate','activate','verify'].includes(operation))fail('実行する移行段階を指定してください。');
 const checked=credentials({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,serviceAccountJson:process.env.FIREBASE_SERVICE_ACCOUNT});
 const publicConfig=JSON.parse(await readFile(resolve('../backend-public-config.json'),'utf8'));
 if(publicConfig.projectId!==projectId||publicConfig.workerName!==workerName||publicConfig.accountId!==checked.accountId||publicConfig.migrationPublicKeySha256!==sha256(checked.publicKey)||!/^https:\/\/handwash-api\.[a-z0-9-]+\.workers\.dev$/.test(publicConfig.apiOrigin)||!/^[a-f0-9-]{36}$/.test(publicConfig.databaseId))fail('初期設定で確認した保存先と一致しません。');
 async function cf(path,method='GET',body){
  let response,data;try{response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+checked.accountId+path,{method,headers:{Authorization:'Bearer '+checked.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});data=await response.json();}catch{fail('Cloudflareに接続できません。');}
  if(!response.ok||data.success!==true)fail('Cloudflareの操作権限または無料枠を確認してください。'+(data.errors?.[0]?.code?' エラー番号: '+Number(data.errors[0].code):''));return data.result;
 }
 const settings=await cf('/workers/scripts/'+workerName+'/settings');
 const binding=name=>settings.bindings?.find(row=>row.name===name);
 if(binding('FIREBASE_PROJECT_ID')?.text!==projectId||binding('DB')?.id!==publicConfig.databaseId||binding('FIREBASE_SERVICE_ACCOUNT')?.type!=='secret_text')fail('Workerの接続先が一致しません。');
 const locked=binding('HANDWASH_MIGRATION_LOCK')?.text==='1';
 if(['preflight','migrate'].includes(operation)&&!locked)fail('運用中の保存先には移行できません。');
 async function query(sql,params=[]){const data=await cf('/d1/database/'+publicConfig.databaseId+'/query','POST',{sql,params});if(!Array.isArray(data)||data.some(row=>row.success===false))fail('データベースの操作に失敗しました。');return data.flatMap(row=>row.results||[]);}
 const {adminContext}=await import(pathToFileURL(resolve('scripts/firebase-admin-context.mjs')));
 const {auth}=adminContext(projectId);
 const web=JSON.parse(await readFile(resolve('firebase-web.public.json'),'utf8'));
 async function accounts(path,body){
  const response=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:'+path+'?key='+web.apiKey,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const result=await response.json();if(!response.ok)fail('Firebaseの本番認証テストに失敗しました。'+(/^[A-Z_]+$/.test(result.error?.message||'')?' '+result.error.message:''));return result;
 }
 async function allUsers(){const users=[];let token;do{const page=await auth.listUsers(1000,token);users.push(...page.users);token=page.pageToken;}while(token);return users;}
 const counts=async()=>{const rows=await query('SELECT (SELECT COUNT(*) FROM staff) AS profiles,(SELECT COUNT(*) FROM washes) AS records');return rows[0];};
 async function checkImportedPassword(){
  const uid='migration-check-'+randomUUID(),email=uid+'@example.invalid',password='Migration-'+randomBytes(24).toString('hex'),salt=randomBytes(16).toString('hex');
  try{
   const result=await auth.importUsers([{uid,email,displayName:'移行検証',passwordHash:pbkdf2Sync(password,Buffer.from(salt,'utf8'),100000,32,'sha256'),passwordSalt:Buffer.from(salt,'utf8'),customClaims:{admin:false,owner:false}}],{hash:{algorithm:'PBKDF2_SHA256',rounds:100000}});
   if(result.failureCount)fail('従来のパスワード形式を本番Firebaseに取り込めません。'+(/^auth\/[a-z-]+$/.test(result.errors?.[0]?.error?.code||'')?' '+result.errors[0].error.code:''));
   const login=await accounts('signInWithPassword',{email,password,returnSecureToken:true});if(login.localId!==uid)fail('取り込んだパスワードでログインできません。');
  }finally{try{await auth.deleteUser(uid);}catch(error){if(error.code!=='auth/user-not-found')throw error;}}
 }
 const report={projectId,apiOrigin:publicConfig.apiOrigin,operation};
 if(operation==='preflight'){
  const before=await allUsers();await checkImportedPassword();const after=await allUsers();
  if(before.length!==after.length||before.some(user=>!after.some(row=>row.uid===user.uid)))fail('検証用アカウントの後片付けを確認してください。');
  Object.assign(report,{authenticationUsable:true,importedPasswordVerified:true,existingAuthAccounts:after.length,migrationLocked:locked,...await counts()});
 }else{
  const encrypted=await readFile(resolve('../data/legacy-backup.encrypted.json'));
  const integrity=JSON.parse(await readFile(resolve('../data/legacy-backup.integrity.json'),'utf8'));
  if(integrity.projectId!==projectId||integrity.cipherSha256!==sha256(encrypted))fail('確定した暗号化バックアップと一致しません。');
  const backup=decryptBackup(JSON.parse(encrypted),checked.account.private_key);
  const {freeMigrationPlan,sameProfiles,sameWashes}=await import(pathToFileURL(resolve('scripts/free-migration-plan.mjs')));
  const plan=freeMigrationPlan(backup,projectId);if(plan.digest!==integrity.backupDigest)fail('元のバックアップの照合に失敗しました。');
  async function rows(table){const all=[];let after='';while(true){const page=await query(`SELECT * FROM ${table} WHERE id>? ORDER BY id LIMIT 1000`,[after]);all.push(...page);if(page.length<1000)return all;after=page.at(-1).id;}}
  async function exact(){if(!sameProfiles(await rows('staff'),plan)||!sameWashes(await rows('washes'),plan))fail('移行先の名簿・記録が元データと一致しません。');}
  const marker=(await query("SELECT digest,state FROM migration_state WHERE key='legacy'"))[0];
  const state=resumeStage(marker,plan.digest);
  const template=JSON.parse(await readFile(resolve('worker/wrangler.jsonc'),'utf8'));
  const config=resolve('worker/wrangler.generated.json');
  await writeFile(config,JSON.stringify(workerConfiguration(template,{accountId:checked.accountId,databaseId:publicConfig.databaseId})),{mode:0o600});
  const exec=promisify(execFile),wrangler=resolve('node_modules/wrangler/bin/wrangler.js');
  async function command(file,args,stage){try{await exec(process.execPath,[file,...args],{env:{...process.env,CI:'1',WRANGLER_LOG:'error'},maxBuffer:32*1024*1024});}catch{fail(stage+'に失敗しました。公開版を切り替えないでください。');}}
  if(operation==='migrate'){
   const existing=await allUsers();
   if(state==='new'){
    const n=await counts();if(existing.length||n.profiles||n.records)fail('初回の移行先は空である必要があります。');
    await query("INSERT INTO migration_state(key,digest,state) VALUES('legacy',?,'auth-importing')",[plan.digest]);
   }
   const dir=await mkdtemp(join(tmpdir(),'handwash-private-migration-'));
   try{
    const backupPath=join(dir,'backup.json');await writeFile(backupPath,JSON.stringify(backup),{mode:0o600});
    await command(resolve('scripts/prepare-legacy-free.mjs'),['--backup',backupPath,'--project',projectId,'--out',dir],'移行データの準備');
    await writeFile(join(dir,'auth-state.json'),JSON.stringify({project:projectId,digest:plan.digest,state:['records-importing','importing','complete'].includes(state)?'complete':'importing'}),{mode:0o600});
    await command(resolve('scripts/import-auth-free.mjs'),['--backup',backupPath,'--project',projectId,'--out',dir,'--apply'],'認証情報の移行');
    if(state!=='complete')await query("UPDATE migration_state SET state='records-importing' WHERE key='legacy' AND digest=?",[plan.digest]);
    await command(resolve('scripts/import-d1-free.mjs'),['--backup',backupPath,'--project',projectId,'--out',dir,'--config',config,'--apply'],'記録の移行');
    await exact();Object.assign(report,{migrationLocked:true,fullDataMatched:true,...plan.summary});
   }finally{await rm(dir,{recursive:true,force:true});}
  }else{
   if(state!=='complete')fail('データ移行を全件照合してから実行してください。');await exact();
   const users=await allUsers(),expected=new Map(plan.users.map(user=>[user.uid,user]));
   if(users.length!==plan.users.length||users.some(user=>{const row=expected.get(user.uid);return !row||row.email!==user.email||row.displayName!==user.displayName||row.customClaims?.admin!==user.customClaims?.admin||row.customClaims?.owner!==user.customClaims?.owner;}))fail('移行した認証情報・権限が一致しません。');
   if(operation==='activate'){
    if(locked){const configuration=workerConfiguration(template,{accountId:checked.accountId,databaseId:publicConfig.databaseId});configuration.vars.HANDWASH_MIGRATION_LOCK='0';await writeFile(config,JSON.stringify(configuration),{mode:0o600});await command(wrangler,['deploy','--config',config],'保存先の有効化');}
    const health=await (await fetch(publicConfig.apiOrigin+'/')).json();if(health.ready!==true||health.service!=='handwash-free')fail('保存先の有効化を確認できません。');
    Object.assign(report,{migrationLocked:false,fullDataMatched:true,...plan.summary});
   }else{
    if(locked)fail('本番テストの前に保存先を有効にしてください。');
    const fixtures=[];
    const call=async(token,path,method='GET',body,expected=200)=>{const response=await fetch(publicConfig.apiOrigin+path,{method,headers:{Authorization:'Bearer '+token,Origin:'https://024masahiro.github.io','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});if(response.status!==expected)fail('本番APIの権限・記録テストに失敗しました。');return response.json();};
    async function fixture(admin=false){const uid='production-check-'+randomUUID(),email=uid+'@example.invalid',password='Test-'+randomBytes(24).toString('hex');await auth.createUser({uid,email,password,displayName:admin?'本番検証管理者':'本番検証職員'});fixtures.push(uid);if(admin)await auth.setCustomUserClaims(uid,{admin:true,owner:false});const login=await accounts('signInWithPassword',{email,password,returnSecureToken:true});return {uid,token:login.idToken};}
    try{
     const a=await fixture(),b=await fixture(),admin=await fixture(true),now=Date.now(),from=now-86400000,to=now+86400000;
     for(const user of [a,b,admin])await call(user.token,'/api/bootstrap');
     await call(a.token,`/api/admin/summary?from=${from}&to=${to}`,'GET',undefined,403);
     await call(a.token,`/api/records?staff=${b.uid}&from=${from}&to=${to}`,'GET',undefined,403);
     const id=randomUUID(),first=await call(a.token,'/api/records','POST',{id}),repeat=await call(a.token,'/api/records','POST',{id});if(first.record.id!==id||repeat.record.at!==first.record.at)fail('記録の重複防止を確認できません。');
     await call(b.token,'/api/records/'+id,'DELETE');
     const records=await call(a.token,`/api/records?from=${from}&to=${to}`);if(records.records.length!==1||records.records[0].id!==id)fail('本人の記録保存・他職員との分離を確認できません。');
     const dashboard=await call(admin.token,`/api/admin/summary?from=${from}&to=${to}`);if(dashboard.staff.find(row=>row.id===a.uid)?.count!==1||dashboard.staff.find(row=>row.id===b.uid)?.count!==0)fail('利用者別ダッシュボードの確認に失敗しました。');
     await call(admin.token,'/api/admin/staff/'+admin.uid,'DELETE',undefined,403);
     await call(admin.token,'/api/admin/staff/'+b.uid,'DELETE');
     await call(a.token,'/api/account','DELETE');
     await auth.setCustomUserClaims(admin.uid,{admin:false,owner:false});await call(admin.token,`/api/admin/summary?from=${from}&to=${to}`,'GET',undefined,403);
    }finally{for(const uid of fixtures){await query('DELETE FROM washes WHERE staff_id=?',[uid]);await query('DELETE FROM staff WHERE id=?',[uid]);try{await auth.deleteUser(uid);}catch(error){if(error.code!=='auth/user-not-found')throw error;}}}
    await exact();Object.assign(report,{migrationLocked:false,fullDataMatched:true,productionApiVerified:true,ownRecordsVerified:true,adminDashboardVerified:true,selfAndAdminDeletionVerified:true,freshAdminPermissionsVerified:true,...plan.summary});
   }
  }
 }
 await writeFile(resolve('backend-verification.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));if(process.env.GITHUB_STEP_SUMMARY)await writeFile(process.env.GITHUB_STEP_SUMMARY,'手洗いログの本番確認が完了しました。\n\n```json\n'+JSON.stringify(report,null,2)+'\n```\n',{flag:'a'});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){main().catch(error=>{console.error(error instanceof OperationError?error.message:'移行段階を完了できませんでした。接続先・移行状態・認証権限を確認してください。'+(/^auth\/[a-z-]+$/.test(error.code||'')?' '+error.code:''));process.exitCode=1;});}
