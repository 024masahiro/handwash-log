import {readFile} from 'node:fs/promises';
import {initializeApp,applicationDefault} from '../firebase-functions/node_modules/firebase-admin/lib/esm/app/index.js';
import {getAuth} from '../firebase-functions/node_modules/firebase-admin/lib/esm/auth/index.js';
import {getFirestore} from '../firebase-functions/node_modules/firebase-admin/lib/esm/firestore/index.js';
import {importPlan,hashOptions} from './legacy-import-plan.mjs';
const args=process.argv.slice(2),option=name=>args[args.indexOf(name)+1];
for(const flag of ['--backup','--project','--owner'])if(!args.includes(flag)||!option(flag)||option(flag).startsWith('--'))throw new Error(flag+' を指定してください。');
const project=option('--project');if(!/^[a-z][a-z0-9-]{4,29}$/.test(project))throw new Error('プロジェクトIDを確認してください。');
const plan=importPlan(JSON.parse(await readFile(option('--backup'),'utf8')),option('--owner'));console.log('移行対象（秘密値は表示しません）',plan.summary);
if(!args.includes('--apply')){console.log('確認のみ。実行には --apply が必要です。');process.exit(0);}
const app=initializeApp({projectId:project,credential:applicationDefault()}),auth=getAuth(app),db=getFirestore(app),marker=db.doc('migration/legacy');
const saved=await marker.get();if(saved.exists&&saved.data().digest!==plan.digest)throw new Error('別のバックアップが移行済みです。');
if(saved.exists&&saved.data().state==='complete'){console.log('このバックアップの移行は完了済みです。');process.exit(0);}
const existingUsers=[];let token;do{const page=await auth.listUsers(1000,token);existingUsers.push(...page.users);token=page.pageToken;}while(token);
if(!saved.exists){if(existingUsers.length||(await db.collection('users').limit(1).get()).size)throw new Error('初回の移行先は空である必要があります。');await marker.set({digest:plan.digest,state:'importing',startedAt:Date.now(),...plan.summary});}
else{for(const user of existingUsers){const expected=plan.users.find(row=>row.uid===user.uid);if(!expected||expected.email!==user.email)throw new Error('移行先に想定外のアカウントがあります。');}}
const existingIds=new Set(existingUsers.map(user=>user.uid)),missing=plan.users.filter(user=>!existingIds.has(user.uid));
for(let i=0;i<missing.length;i+=1000){const result=await auth.importUsers(missing.slice(i,i+1000),hashOptions);if(result.failureCount)throw new Error('認証情報の移行に失敗しました。Firebaseの権限とバックアップを確認してください。');}
for(const user of plan.users)await auth.setCustomUserClaims(user.uid,user.customClaims);
let batch=db.batch(),count=0;const flush=async()=>{if(count){await batch.commit();batch=db.batch();count=0;}};
for(const row of plan.profiles){batch.set(db.doc('users/'+row.uid),row.data);count++;if(count===400)await flush();}
for(const row of plan.washes){batch.set(db.doc('users/'+row.uid+'/washes/'+row.id),{at:row.at});count++;if(count===400)await flush();}await flush();
const [profiles,records]=await Promise.all([db.collection('users').count().get(),db.collectionGroup('washes').count().get()]);
if(profiles.data().count!==plan.profiles.length||records.data().count!==plan.washes.length)throw new Error('移行後の件数が一致しません。公開を切り替えないでください。');
await marker.update({state:'complete',finishedAt:Date.now()});console.log('移行完了。名簿と記録の件数が一致しました。',plan.summary);
