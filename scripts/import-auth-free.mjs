import {readFile,writeFile,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
import {adminContext} from './firebase-admin-context.mjs';
import {freeMigrationPlan} from './free-migration-plan.mjs';
import {hashOptions} from './legacy-import-plan.mjs';
const args=process.argv.slice(2),option=name=>args[args.indexOf(name)+1];
for(const flag of ['--backup','--project','--out'])if(!args.includes(flag)||!option(flag)||option(flag).startsWith('--'))throw new Error(flag+' を指定してください。');
const plan=freeMigrationPlan(JSON.parse(await readFile(option('--backup'),'utf8')),option('--project')),out=resolve(option('--out'));
const manifest=JSON.parse(await readFile(resolve(out,'manifest.json'),'utf8'));
if(manifest.project!==option('--project')||manifest.digest!==plan.digest||manifest.sqlDigest!==plan.manifest.sqlDigest)throw new Error('準備した移行データと一致しません。');
console.log('Firebase Authenticationの移行対象',plan.summary);
if(!args.includes('--apply')){console.log('確認のみ。実行には --apply が必要です。');process.exit(0);}
const {auth}=adminContext(option('--project')),statePath=resolve(out,'auth-state.json');
let state;try{state=JSON.parse(await readFile(statePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(state&&(state.project!==manifest.project||state.digest!==plan.digest))throw new Error('別の移行が記録されています。');
async function allUsers(){const users=[];let token;do{const page=await auth.listUsers(1000,token);users.push(...page.users);token=page.pageToken;}while(token);return users;}
const existing=await allUsers(),expected=new Map(plan.users.map(user=>[user.uid,user]));
if(!state&&existing.length)throw new Error('初回の移行先は空である必要があります。');
for(const user of existing)if(expected.get(user.uid)?.email!==user.email)throw new Error('移行先に想定外のアカウントがあります。');
if(state?.state==='complete'){if(existing.length!==plan.users.length||existing.some(user=>{const target=expected.get(user.uid);return user.displayName!==target.displayName||user.customClaims?.admin!==target.customClaims.admin||user.customClaims?.owner!==target.customClaims.owner;}))throw new Error('移行完了後に認証情報が変更されています。再取り込みは行いません。');console.log('このバックアップの認証移行は完了済みです。変更は行いません。');process.exit(0);}
const save=async status=>{await writeFile(statePath,JSON.stringify({project:manifest.project,digest:plan.digest,state:status})+'\n',{mode:0o600});await chmod(statePath,0o600);};
await save('importing');const ids=new Set(existing.map(user=>user.uid)),missing=plan.users.filter(user=>!ids.has(user.uid));
for(let i=0;i<missing.length;i+=1000){const result=await auth.importUsers(missing.slice(i,i+1000),hashOptions);if(result.failureCount)throw new Error('認証情報の移行に失敗しました。権限とバックアップを確認し、同じデータで再実行してください。');}
for(const user of plan.users)await auth.setCustomUserClaims(user.uid,user.customClaims);
const actual=await allUsers();
if(actual.length!==plan.users.length||actual.some(user=>{const target=expected.get(user.uid);return !target||target.email!==user.email||user.displayName!==target.displayName||user.customClaims?.admin!==target.customClaims.admin||user.customClaims?.owner!==target.customClaims.owner;}))throw new Error('移行後の認証情報が一致しません。公開を切り替えないでください。');
await save('complete');console.log('認証情報の移行とアカウント・権限の照合が完了しました。',plan.summary);
