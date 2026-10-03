import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,pbkdf2Sync,generateKeyPairSync,createPrivateKey,sign} from 'node:crypto';
import vm from 'node:vm';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {createApi} from '../worker/api.mjs';
import {createWorker} from '../worker/index.mjs';
import {createFirebaseIdentity} from '../worker/firebase-identity.mjs';
import {DatabaseSync,sqliteD1} from './sqlite-d1.mjs';
import {importPlan} from './legacy-import-plan.mjs';
import {freeMigrationPlan,sameProfiles,sameWashes} from './free-migration-plan.mjs';
import {deploymentConfiguration} from './deploy-free-backend.mjs';
const html=await readFile('public/free.html','utf8');new vm.Script(html.match(/<script id="app-script">([\s\S]*?)<\/script>/)[1]);assert(!/chatgpt|resend\.com|staff-select|職員番号|<textarea|cloudfunctions/i.test(html));for(const id of ['register-name','register-email','register-password'])assert(html.includes('id="'+id+'"'));
const salt='0123456789abcdef0123456789abcdef',hash=pbkdf2Sync('legacy-password-123',salt,100000,32,'sha256').toString('hex');
const legacy={staff:[{id:'legacy-user',name:'旧利用者',login_email:'legacy@company.test',password_hash:salt+':'+hash,is_admin:0}],washes:[{id:randomUUID(),staff_id:'legacy-user',washed_at:Date.now()}]};
const plan=importPlan(legacy,'024masahiro@gmail.com');assert.deepEqual(plan.users[0].passwordSalt,Buffer.from(salt,'utf8'));assert.deepEqual(plan.users[0].passwordHash,pbkdf2Sync('legacy-password-123',plan.users[0].passwordSalt,100000,32,'sha256'));
const reserved=importPlan({...legacy,staff:[{...legacy.staff[0],login_email:'024masahiro@gmail.com'}]},'024masahiro@gmail.com');assert.equal(reserved.users[0].customClaims.admin,false);assert.equal(reserved.users[0].customClaims.owner,false);
assert.throws(()=>importPlan({...legacy,staff:[{...legacy.staff[0],password_hash:'truncated'}]},'024masahiro@gmail.com'));
// Migration SQL preserves all rows, quotes names as data, resumes safely and contains no password hashes.
const migration=freeMigrationPlan({...legacy,staff:[{...legacy.staff[0],name:"大西' ; DELETE FROM staff; -- $()"}],washes:[...legacy.washes,{id:randomUUID(),staff_id:null,washed_at:Date.now()}]},'demo-handwash');
const migrationSql=new DatabaseSync(':memory:');migrationSql.exec(await readFile('worker/migrations/0001_records.sql','utf8'));migrationSql.exec(migration.sql);migrationSql.exec(migration.sql);
assert(sameProfiles(migrationSql.prepare('SELECT * FROM staff').all(),migration));assert(sameWashes(migrationSql.prepare('SELECT * FROM washes').all(),migration));assert(!migration.sql.includes(hash));assert.equal(migrationSql.prepare("SELECT digest FROM migration_state WHERE key='legacy'").get().digest,migration.digest);
migrationSql.prepare('UPDATE washes SET washed_at=washed_at+1 WHERE id=?').run(legacy.washes[0].id);assert(!sameWashes(migrationSql.prepare('SELECT * FROM washes').all(),migration));migrationSql.close();
// Updating the live Worker must preserve its database and active migration state.
const template=JSON.parse(await readFile('worker/wrangler.jsonc','utf8')),connection=JSON.parse(await readFile('backend-public-config.json','utf8'));
const settings={bindings:[{name:'DB',type:'d1',id:connection.databaseId},{name:'FIREBASE_PROJECT_ID',type:'plain_text',text:'handwash-log'},{name:'FIREBASE_SERVICE_ACCOUNT',type:'secret_text'},{name:'HANDWASH_MIGRATION_LOCK',type:'plain_text',text:'0'}]};
const configuration=deploymentConfiguration(template,connection,settings,connection.accountId);assert.equal(configuration.d1_databases[0].database_id,connection.databaseId);assert.equal(configuration.vars.HANDWASH_MIGRATION_LOCK,'0');assert.equal(configuration.keep_vars,true);assert(!JSON.stringify(configuration).includes('secret_text'));
assert.throws(()=>deploymentConfiguration(template,connection,settings,'0'.repeat(32)));assert.throws(()=>deploymentConfiguration(template,{...connection,databaseId:'0'.repeat(36)},settings,connection.accountId));
assert.throws(()=>deploymentConfiguration(template,connection,{bindings:settings.bindings.map(row=>row.name==='HANDWASH_MIGRATION_LOCK'?{...row,text:'1'}:row)},connection.accountId));
assert.throws(()=>deploymentConfiguration(template,connection,{bindings:[...settings.bindings,{name:'OTHER_DATABASE',type:'d1',id:'other'}]},connection.accountId));
// Rankings are public to authenticated staff, contain only summary fields, and
// use competition ranks including every tie at tenth place. Days use Japan time.
{
  const rankingSql=new DatabaseSync(':memory:');rankingSql.exec(await readFile('worker/migrations/0001_records.sql','utf8'));
  const now=Date.parse('2026-10-03T14:59:59.999Z'),from=Date.parse('2026-10-02T15:00:00.000Z'),to=from+86400000;
  const counts=[12,12,9,8,7,6,5,4,3,2,2,1,0,99],users=new Map();
  for(const [index,count] of counts.entries()){
    const uid='rank-'+index,name='職員'+String(index).padStart(2,'0');users.set(uid,{uid,displayName:name,email:uid+'@company.test',customClaims:index===0?{admin:true}:{}});
    rankingSql.prepare('INSERT INTO staff(id,name,email,is_admin,is_owner,deleting,created_at) VALUES(?,?,?,0,0,?,?)').run(uid,name,uid+'@company.test',Number(index===13),from);
    for(let i=0;i<count;i++)rankingSql.prepare('INSERT INTO washes(id,staff_id,washed_at) VALUES(?,?,?)').run(randomUUID(),uid,from+i);
  }
  for(const time of [from-1,to])rankingSql.prepare('INSERT INTO washes(id,staff_id,washed_at) VALUES(?,?,?)').run(randomUUID(),'rank-0',time);
  const rankingApi=createApi({db:sqliteD1(rankingSql),identity:{getUsers:()=>{throw new Error('Ranking must not fetch private account metadata');}},clock:()=>now});
  const actor=uid=>({uid,user:users.get(uid)}),request={path:'/api/ranking',method:'GET'};
  const ranked=await rankingApi(actor('rank-11'),request);
  assert.equal(ranked.date,'2026-10-03');assert.equal(ranked.ranking.length,11);assert.deepEqual(ranked.ranking.map(row=>row.rank),[1,1,3,4,5,6,7,8,9,10,10]);assert.deepEqual(ranked.me,{rank:12,count:1});
  for(const row of ranked.ranking)assert.deepEqual(Object.keys(row).sort(),['count','isSelf','name','rank']);
  const own=await rankingApi(actor('rank-1'),request);assert.equal(own.ranking.filter(row=>row.isSelf).length,1);assert.equal(own.me.rank,1);assert.equal(own.me.count,12);
  assert.deepEqual((await rankingApi(actor('rank-12'),request)).me,{rank:null,count:0});assert.deepEqual((await rankingApi(actor('rank-0'),request)).ranking.map(({isSelf,...row})=>row),ranked.ranking.map(({isSelf,...row})=>row));
  await assert.rejects(()=>rankingApi(null,request),error=>error.status===401);await assert.rejects(()=>rankingApi(actor('rank-13'),request),error=>error.status===401);
  const tomorrow=createApi({db:sqliteD1(rankingSql),identity:{},clock:()=>to});const next=await tomorrow(actor('rank-0'),request);assert.equal(next.date,'2026-10-04');assert.deepEqual(next.me,{rank:1,count:1});assert.equal(next.ranking.length,1);
  const empty=createApi({db:sqliteD1(rankingSql),identity:{},clock:()=>to+86400000});assert.deepEqual((await empty(actor('rank-0'),request)).ranking,[]);
  rankingSql.close();
}
const sql=new DatabaseSync(':memory:');sql.exec(await readFile('worker/migrations/0001_records.sql','utf8'));const db=sqliteD1(sql),now=Date.now();
const users=new Map();for(const [uid,name,claims] of [['owner','所有者',{admin:true,owner:true}],['admin','管理者',{admin:true}],['a','山田',{}],['b','鈴木',{}]])users.set(uid,{uid,name,displayName:name,email:uid==='owner'?'024masahiro@gmail.com':uid+'@company.test',emailVerified:true,customClaims:claims});
const identity={getUser:async uid=>users.get(uid)||null,getUsers:async ids=>ids.map(id=>users.get(id)).filter(Boolean),deleteUser:async uid=>{users.delete(uid);},updateUser:async(uid,update)=>{Object.assign(users.get(uid),update);},createUser:async(uid,update)=>{users.set(uid,{uid,...update,customClaims:{}});}};
const actor=uid=>({uid,auth_time:now/1000,user:users.get(uid)}),api=createApi({db,identity,clock:()=>now}),call=(uid,path,method='GET',body={},extra={})=>api(actor(uid),{path,method,body,...extra}),rejected=(fn,status)=>assert.rejects(fn,e=>e.status===status);
for(const uid of users.keys())await call(uid,'/api/bootstrap');
const range='/api/records?from='+(now-86400000)+'&to='+(now+86400000),summary='/api/admin/summary?from='+(now-86400000)+'&to='+(now+86400000);
await rejected(()=>api(null,{path:range,method:'GET'}),401);await rejected(()=>call('a',summary),403);await rejected(()=>call('a',range+'&staff=b'),403);await rejected(()=>call('a','/api/profile','POST',{name:'山田',isAdmin:true}),400);
const aId=randomUUID(),bId=randomUUID();await call('a','/api/records','POST',{id:aId});const first=(await call('a',range)).records[0];await call('a','/api/records','POST',{id:aId});assert.equal((await call('a',range)).records.length,1);assert.equal((await call('a',range)).records[0].at,first.at);
await rejected(()=>call('a','/api/records','POST',{id:randomUUID(),staffId:'b'}),400);await rejected(()=>call('a','/api/records','POST',{id:randomUUID()},{expectedStaffId:'b'}),409);
await call('b','/api/records','POST',{id:bId});await call('a','/api/records/'+bId,'DELETE');assert.equal((await call('b',range)).records[0].id,bId);await rejected(()=>call('a','/api/records','POST',{id:bId}),409);
assert.equal((await call('owner',summary)).total,2);assert.equal((await call('owner',summary)).staff.find(row=>row.id==='a').count,1);
await rejected(()=>call('owner','/api/admin/staff/a/account','POST',{name:'山田',email:'a@company.test',isAdmin:true}),400);await rejected(()=>call('admin','/api/admin/staff/owner/account','POST',{name:'所有者',email:'024masahiro@gmail.com'}),403);await rejected(()=>call('owner','/api/admin/staff/owner','DELETE'),403);
await rejected(()=>api({...actor('a'),auth_time:now/1000-301},{path:'/api/account',method:'DELETE',body:{}}),401);
await call('owner','/api/admin/staff/a/account','POST',{name:'山田更新',email:'new-a@company.test',password:'new-password-123'});assert.equal(users.get('a').email,'new-a@company.test');assert.equal(sql.prepare('SELECT name FROM staff WHERE id=?').get('a').name,'山田更新');
await call('a','/api/account','DELETE');assert(!users.has('a'));assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM washes WHERE staff_id=?').get('a').n,0);
const originalDelete=identity.deleteUser;identity.deleteUser=async()=>{throw new Error('provider unavailable');};await assert.rejects(()=>call('owner','/api/admin/staff/b','DELETE'));assert.equal(sql.prepare('SELECT deleting FROM staff WHERE id=?').get('b').deleting,1);await rejected(()=>call('b',range),401);identity.deleteUser=originalDelete;await call('owner','/api/admin/staff/b','DELETE');assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM washes WHERE staff_id=?').get('b').n,0);
users.get('admin').customClaims={};await rejected(()=>call('admin',summary),403);
const http=createWorker({getIdentity:()=>({...identity,authenticate:async token=>{if(token!=='owner-token')throw Object.assign(new Error('ログインしてください。'),{status:401});return actor('owner');}}),clock:()=>now});
const environment={DB:db,FIREBASE_PROJECT_ID:'demo-handwash',FIREBASE_SERVICE_ACCOUNT:'configured',HANDWASH_MIGRATION_LOCK:'0'};
const req=(path,method='GET',body,origin='https://024masahiro.github.io',token='owner-token',extra={})=>new Request('https://handwash-api.example.workers.dev'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
assert.equal((await http.fetch(req('/api/bootstrap','GET',undefined,'https://evil.test'),environment)).status,403);assert.equal((await http.fetch(req('/api/bootstrap','GET',undefined,undefined,''),environment)).status,200);
assert.equal((await http.fetch(req('/api/bootstrap'),{...environment,HANDWASH_MIGRATION_LOCK:'1'})).status,503);
assert.equal((await http.fetch(req('/api/ranking','GET',undefined,undefined,''),environment)).status,401);assert.equal((await http.fetch(req('/api/ranking'),environment)).status,200);
const preflight=req('/api/records','OPTIONS',undefined,undefined,'',{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,x-handwash-profile'});assert.equal((await http.fetch(preflight,environment)).status,204);
assert.equal((await http.fetch(req('/api/profile','POST',{name:'x'.repeat(20000)}),environment)).status,413);
const extraIdentity=req('/api/bootstrap','GET',undefined,undefined,'',{Cookie:'owner-token','oai-authenticated-user-email':'024masahiro@gmail.com'});const anonymous=await (await http.fetch(extraIdentity,environment)).json();assert.equal(anonymous.authenticated,false);
const index=sql.prepare('EXPLAIN QUERY PLAN SELECT id,washed_at FROM washes WHERE staff_id=? AND washed_at>=? AND washed_at<?').all('owner',0,now+86400000);assert(index.some(row=>row.detail.includes('washes_staff_time')),'History must use a range index instead of scanning all history');
// Verify the production RS256/OAuth implementation against generated keys and Google API-shaped responses.
const pair=generateKeyPairSync('rsa',{modulusLength:2048}),privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicJwk=pair.publicKey.export({format:'jwk'}),kid='test-key',project='demo-handwash';
const rawUsers=new Map([['rsa-user',{localId:'rsa-user',email:'rsa@company.test',displayName:'署名テスト',validSince:'0',customAttributes:'{}',emailVerified:true}]]);let oauthCalls=0,jwksCalls=0;
const mockGoogle=async(url,options={})=>{if(url.includes('/service_accounts/')){jwksCalls++;return Response.json({keys:[{...publicJwk,kid}]},{headers:{'cache-control':'max-age=3600'}});}if(url==='https://oauth2.googleapis.com/token'){oauthCalls++;return Response.json({access_token:'server-token',expires_in:3600});}const body=JSON.parse(options.body);assert.equal(options.headers.Authorization,'Bearer server-token');if(url.endsWith(':lookup'))return Response.json({users:body.localId.map(uid=>rawUsers.get(uid)).filter(Boolean)});throw new Error('Unexpected auth operation');};
const firebase=createFirebaseIdentity({projectId:project,serviceAccount:{project_id:project,client_email:'worker@demo-handwash.iam.gserviceaccount.com',private_key:privateKey},fetcher:mockGoogle,clock:()=>now});
const token=(overrides={},headerOverrides={})=>{const enc=value=>Buffer.from(JSON.stringify(value)).toString('base64url');const value=enc({alg:'RS256',kid,...headerOverrides})+'.'+enc({sub:'rsa-user',aud:project,iss:'https://securetoken.google.com/'+project,iat:Math.floor(now/1000),auth_time:Math.floor(now/1000),exp:Math.floor(now/1000)+3600,...overrides});return value+'.'+sign('RSA-SHA256',Buffer.from(value),pair.privateKey).toString('base64url');};
assert.equal((await firebase.authenticate(token())).uid,'rsa-user');await firebase.authenticate(token());assert.equal(oauthCalls,1);assert.equal(jwksCalls,1);
for(const bad of [token({aud:'other-project'}),token({exp:Math.floor(now/1000)-1}),token({}, {alg:'none'}),token({}, {kid:'unknown'}),token().slice(0,-10)+'tampered'])await rejected(()=>firebase.authenticate(bad),401);
for(const value of [null,[],false]){const part=Buffer.from(JSON.stringify(value)).toString('base64url');await rejected(()=>firebase.authenticate(part+'.'+part+'.AA'),401);}
rawUsers.get('rsa-user').customAttributes='{"admin":true}';assert.equal((await firebase.authenticate(token())).user.customClaims.admin,true);rawUsers.get('rsa-user').customAttributes='{}';assert.equal((await firebase.authenticate(token())).user.customClaims.admin,undefined);
rawUsers.get('rsa-user').validSince=String(Math.floor(now/1000)+1);await rejected(()=>firebase.authenticate(token()),401);rawUsers.get('rsa-user').validSince='0';rawUsers.get('rsa-user').disabled=true;await rejected(()=>firebase.authenticate(token()),401);
// Run the same HTTP worker and schema inside workerd with a real Miniflare D1 binding.
rawUsers.get('rsa-user').disabled=false;
const outboundService=async request=>mockGoogle(request.url,{method:request.method,headers:{Authorization:request.headers.get('Authorization')},...(request.method==='POST'?{body:await request.text()}:{})});
const bundled=(await build({entryPoints:['worker/index.mjs'],bundle:true,format:'esm',platform:'browser',write:false})).outputFiles[0].text;
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundled,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{FIREBASE_PROJECT_ID:project,FIREBASE_SERVICE_ACCOUNT:JSON.stringify({project_id:project,client_email:'worker@demo-handwash.iam.gserviceaccount.com',private_key:privateKey}),HANDWASH_MIGRATION_LOCK:'0'},outboundService}));
try{const realDb=await mf.getD1Database('DB');for(const query of (await readFile('worker/migrations/0001_records.sql','utf8')).split(';').filter(text=>text.trim()))await realDb.prepare(query).run();
 const send=(path,method='GET',body)=>mf.dispatchFetch('https://handwash-api.example.workers.dev'+path,{method,headers:{Origin:'https://024masahiro.github.io',Authorization:'Bearer '+token(),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const bootstrap=await send('/api/bootstrap');assert.equal(bootstrap.status,200);assert.equal((await bootstrap.json()).myStaff.id,'rsa-user');
 const record=randomUUID();assert.equal((await send('/api/records','POST',{id:record})).status,200);assert.equal((await send('/api/records','POST',{id:record})).status,200);assert.equal((await (await send(range)).json()).records.length,1);const ranking=await send('/api/ranking');assert.equal(ranking.status,200);const ranked=await ranking.json();assert.equal(ranked.me.count,1);assert.equal(ranked.ranking[0].isSelf,true);assert.deepEqual(Object.keys(ranked.ranking[0]).sort(),['count','isSelf','name','rank']);
 assert.equal((await send('/api/admin/summary?from='+(now-1000)+'&to='+(now+1000))).status,403);
}catch(error){throw error;}finally{await mf.dispose();sql.close();}
console.log('Free-plan checks passed: authenticated top-ten ranking/ties/Japan-day boundary/minimal fields, preserved production bindings, real D1 transaction/index, identity isolation, protected admin roles, deletion/retry, CORS, RS256/project/expiry/revocation verification, OAuth/key cache and legacy password import.');
