import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,pbkdf2Sync} from 'node:crypto';
import {initializeApp as initializeAdmin} from 'firebase-admin/app';
import {getAuth as adminAuth} from 'firebase-admin/auth';
import {initializeApp,deleteApp} from 'firebase/app';
import {getAuth,connectAuthEmulator,createUserWithEmailAndPassword,updateProfile,signInWithEmailAndPassword,signOut,sendPasswordResetEmail,confirmPasswordReset,EmailAuthProvider,reauthenticateWithCredential,updatePassword} from 'firebase/auth';
import {createWorker} from '../worker/index.mjs';
import {ApiError} from '../worker/errors.mjs';
import {DatabaseSync,sqliteD1} from './sqlite-d1.mjs';
import {freeMigrationPlan} from './free-migration-plan.mjs';
import {hashOptions} from './legacy-import-plan.mjs';
if(!/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST||''))throw new Error('Only the local Firebase Auth emulator may be used.');
const project='demo-handwash',app=initializeAdmin({projectId:project}),auth=adminAuth(app),prefix=randomUUID(),password='user-password-123',email='staff-'+prefix+'@company.test';
const sql=new DatabaseSync(':memory:');sql.exec(await readFile('worker/migrations/0001_records.sql','utf8'));const db=sqliteD1(sql);
const identity={
 async authenticate(token){try{const actor=await auth.verifyIdToken(token,true);return {...actor,user:await auth.getUser(actor.uid)};}catch{throw new ApiError('ログインしてください。',401,'unauthenticated');}},
 async getUser(uid){try{return await auth.getUser(uid);}catch(error){if(error.code==='auth/user-not-found')return null;throw error;}},
 async getUsers(uids){const result=await auth.getUsers(uids.map(uid=>({uid})));return result.users;},
 async updateUser(uid,update){const result=await auth.updateUser(uid,update);if(update.email||update.password)await auth.revokeRefreshTokens(uid);return result;},
 async createUser(uid,update){return auth.createUser({uid,...update});},
 async deleteUser(uid){await auth.deleteUser(uid);}
};
const worker=createWorker({getIdentity:()=>identity}),env={DB:db,HANDWASH_MIGRATION_LOCK:'0'},web=initializeApp({apiKey:'demo-key',projectId:project,authDomain:project+'.firebaseapp.com'}),webAuth=getAuth(web);connectAuthEmulator(webAuth,'http://'+process.env.FIREBASE_AUTH_EMULATOR_HOST,{disableWarnings:true});
const request=(path,method='GET',body,token)=>new Request('https://api.example.workers.dev'+path,{method,headers:{Origin:'https://024masahiro.github.io',...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const call=async(path,method='GET',body)=>{const response=await worker.fetch(request(path,method,body,await webAuth.currentUser.getIdToken()),env);return {status:response.status,data:await response.json()};};
try{
 assert.equal((await worker.fetch(request('/api/records'),env)).status,401);
 const {user}=await createUserWithEmailAndPassword(webAuth,email,password);await updateProfile(user,{displayName:'利用者テスト'});assert.equal((await call('/api/profile','POST',{name:'利用者テスト'})).status,200);
 const uid=user.uid,now=Date.now(),range='/api/records?from='+(now-86400000)+'&to='+(now+86400000);assert.equal((await call('/api/bootstrap')).data.isAdmin,false);
 assert.equal((await call('/api/admin/summary?from='+(now-86400000)+'&to='+(now+86400000))).status,403);assert.equal((await call('/api/records','POST',{id:randomUUID()})).status,200);
 const oldToken=await user.getIdToken();await auth.updateUser(uid,{disabled:true});assert.equal((await worker.fetch(request(range,'GET',undefined,oldToken),env)).status,401);await auth.updateUser(uid,{disabled:false});
 await sendPasswordResetEmail(webAuth,email);const actions=await (await fetch('http://'+process.env.FIREBASE_AUTH_EMULATOR_HOST+'/emulator/v1/projects/'+project+'/oobCodes')).json();const reset=actions.oobCodes.find(row=>row.email===email&&row.requestType==='PASSWORD_RESET');assert(reset?.oobCode);
 await new Promise(resolve=>setTimeout(resolve,1100));await confirmPasswordReset(webAuth,reset.oobCode,'reset-password-123');await assert.rejects(()=>confirmPasswordReset(webAuth,reset.oobCode,'other-password-123'));assert.equal((await worker.fetch(request(range,'GET',undefined,oldToken),env)).status,401);
 await signOut(webAuth);await assert.rejects(()=>signInWithEmailAndPassword(webAuth,email,password));await signInWithEmailAndPassword(webAuth,email,'reset-password-123');
 await reauthenticateWithCredential(webAuth.currentUser,EmailAuthProvider.credential(email,'reset-password-123'));await updatePassword(webAuth.currentUser,'changed-password-123');await signOut(webAuth);await signInWithEmailAndPassword(webAuth,email,'changed-password-123');
 await reauthenticateWithCredential(webAuth.currentUser,EmailAuthProvider.credential(email,'changed-password-123'));await webAuth.currentUser.getIdToken(true);assert.equal((await call('/api/account','DELETE',{})).status,200);await assert.rejects(()=>auth.getUser(uid),e=>e.code==='auth/user-not-found');assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM washes WHERE staff_id=?').get(uid).n,0);
 const owner=await auth.createUser({email:'owner-'+prefix+'@company.test',password,displayName:'管理者'});await auth.setCustomUserClaims(owner.uid,{admin:true});await signInWithEmailAndPassword(webAuth,owner.email,password);const ownerToken=await webAuth.currentUser.getIdToken();assert.equal((await call('/api/bootstrap')).data.isAdmin,true);await auth.setCustomUserClaims(owner.uid,{admin:false});assert.equal((await worker.fetch(request('/api/admin/summary?from='+(now-86400000)+'&to='+(now+86400000),'GET',undefined,ownerToken),env)).status,403);
 const salt='0123456789abcdef0123456789abcdef',legacyUid='legacy-'+prefix,legacyPassword='legacy-password-123',legacyEmail='legacy-'+prefix+'@company.test',legacy=freeMigrationPlan({staff:[{id:legacyUid,name:'移行利用者',login_email:legacyEmail,password_hash:salt+':'+pbkdf2Sync(legacyPassword,salt,100000,32,'sha256').toString('hex'),is_admin:0}],washes:[{id:randomUUID(),staff_id:legacyUid,washed_at:now}]},project);
 const imported=await auth.importUsers(legacy.users,hashOptions);assert.equal(imported.failureCount,0);sql.exec(legacy.sql);
 const exported=(await auth.listUsers(1000)).users.find(user=>user.uid===legacyUid);assert.equal(exported.email,legacyEmail);assert.deepEqual(Buffer.from(exported.passwordHash,'base64'),legacy.users[0].passwordHash);assert.deepEqual(Buffer.from(exported.passwordSalt,'base64'),legacy.users[0].passwordSalt);
 // The Auth emulator uses fakeHash:salt=...:password=... and cannot verify imported PBKDF2.
 // Check its import bytes, then test the imported account's reset/login and preserved records.
 await signOut(webAuth);await sendPasswordResetEmail(webAuth,legacyEmail);const legacyActions=await (await fetch('http://'+process.env.FIREBASE_AUTH_EMULATOR_HOST+'/emulator/v1/projects/'+project+'/oobCodes')).json();const legacyReset=legacyActions.oobCodes.find(row=>row.email===legacyEmail&&row.requestType==='PASSWORD_RESET');assert(legacyReset?.oobCode);await confirmPasswordReset(webAuth,legacyReset.oobCode,'legacy-reset-password-123');await signInWithEmailAndPassword(webAuth,legacyEmail,'legacy-reset-password-123');assert.equal(webAuth.currentUser.uid,legacyUid);assert.equal((await call(range)).data.records.length,1);await auth.deleteUser(legacyUid);
 console.log('Auth integration passed: signup/profile, login, disabled/revoked token rejection, emailed reset code/single use, password changes, reauthenticated withdrawal and fresh admin claim revocation.');
}finally{await deleteApp(web);sql.close();}
