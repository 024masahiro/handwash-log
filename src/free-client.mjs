import {initializeApp} from 'firebase/app';
import {getAuth,setPersistence,browserSessionPersistence,signInWithEmailAndPassword,createUserWithEmailAndPassword,updateProfile,signOut,sendPasswordResetEmail,sendEmailVerification,confirmPasswordReset,EmailAuthProvider,reauthenticateWithCredential,updatePassword,connectAuthEmulator} from 'firebase/auth';
const config=__FIREBASE_CONFIG__;
const app=initializeApp(config),auth=getAuth(app);
if(config.emulators)connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
auth.languageCode='ja';
const ready=setPersistence(auth,browserSessionPersistence).then(()=>auth.authStateReady());
async function invoke(input,signal){
 if(!auth.currentUser){const error=new Error('ログインしてください。');error.status=401;error.code='api/unauthenticated';throw error;}
 const headers={'Content-Type':'application/json',Authorization:'Bearer '+await auth.currentUser.getIdToken()};if(input.expectedStaffId)headers['X-Handwash-Profile']=input.expectedStaffId;
 let response;try{response=await fetch(config.apiOrigin+input.path,{method:input.method||'GET',headers,credentials:'omit',cache:'no-store',signal,...(input.method&&input.method!=='GET'?{body:JSON.stringify(input.body||{})}:{})});}catch(error){if(error.name==='AbortError')throw error;throw new Error('接続できませんでした。通信環境を確認してください。');}
 let result;try{result=await response.json();}catch{throw new Error('処理を確認できませんでした。少し待ってから再度お試しください。');}
 if(!response.ok){const error=new Error(result.error||'処理を完了できませんでした。');error.status=response.status;error.code='api/'+(result.code||'error');throw error;}return {data:result};
}
const anonymous=()=>({myStaff:null,isAdmin:false,isOwner:false,authenticated:false,loginEmail:'',mailConfigured:true});
const messages={
 'auth/invalid-credential':'メールアドレスまたはパスワードが違います。',
 'auth/invalid-login-credentials':'メールアドレスまたはパスワードが違います。',
 'auth/wrong-password':'メールアドレスまたはパスワードが違います。',
 'auth/user-not-found':'メールアドレスまたはパスワードが違います。',
 'auth/email-already-in-use':'このメールアドレスは登録済みです。',
 'auth/invalid-email':'メールアドレスを確認してください。',
 'auth/weak-password':'パスワードは10文字以上で設定してください。',
 'auth/too-many-requests':'試行回数が多いため、少し待ってからお試しください。',
 'auth/network-request-failed':'接続できませんでした。通信環境を確認してください。',
 'auth/expired-action-code':'再設定リンクの有効期限が切れました。もう一度依頼してください。',
 'auth/invalid-action-code':'再設定リンクが無効か、すでに使用されています。もう一度依頼してください。',
 'auth/user-disabled':'このアカウントは利用できません。',
 'auth/requires-recent-login':'安全のため、ログインし直してからお試しください。',
 'auth/web-storage-unsupported':'ブラウザーの保存機能を有効にしてからお試しください。'
};
const expired=error=>['auth/user-token-expired','auth/invalid-user-token','api/unauthenticated'].includes(error.code)||error.status===401;
function readable(error){const result=new Error(messages[error.code]||(error.code?.startsWith('api/')?error.message:'処理を完了できませんでした。もう一度お試しください。'));result.status=error.status||(expired(error)?401:400);result.signIn=expired(error);return result;}
function password(value){if(typeof value!=='string'||value.length<10||value.length>128)throw new Error('パスワードは10〜128文字で設定してください。');}
async function reauthenticate(value){if(!auth.currentUser?.email)throw new Error('ログインしてください。');await reauthenticateWithCredential(auth.currentUser,EmailAuthProvider.credential(auth.currentUser.email,value));await auth.currentUser.getIdToken(true);}
window.handwashFirebase={async api(path,options={}){
 await ready;if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
 const body=typeof options.body==='string'?JSON.parse(options.body):options.body||{};
 try{
  if(path==='/api/auth/login'){await signOut(auth);await signInWithEmailAndPassword(auth,String(body.email||'').trim(),body.password);return {loggedIn:true};}
  if(path==='/api/auth/logout'){await signOut(auth);return {loggedOut:true};}
  if(path==='/api/auth/verify-email'){if(!auth.currentUser)throw new Error('ログインしてください。');await sendEmailVerification(auth.currentUser,{url:config.pagesOrigin+config.pagesBasePath+'/login/'});return {sent:true};}
  if(path==='/api/auth/register'){
   const name=String(body.name||'').trim().normalize('NFC');if(!name||name.length>60||/[\u0000-\u001f]/.test(name))throw new Error('氏名を60文字以内で入力してください。');password(body.password);
   if(Object.keys(body).some(key=>!['name','email','password'].includes(key)))throw new Error('登録の入力形式を確認してください。');
   const email=String(body.email||'').trim();let user;
   try{({user}=await createUserWithEmailAndPassword(auth,email,body.password));}
   catch(error){
    if(error.code!=='auth/email-already-in-use')throw error;
    // Recover an interrupted signup only after authenticating with its password.
    ({user}=await signInWithEmailAndPassword(auth,email,body.password));
    try{await invoke({path:'/api/bootstrap',method:'GET'});await signOut(auth);throw error;}
    catch(check){if(check.code!=='api/profile-required')throw check;}
   }
   await invoke({path:'/api/profile',method:'POST',body:{name}});
   // The D1 profile is already complete if the optional Auth display name update fails.
   try{await updateProfile(user,{displayName:name});}catch(error){if(error.code!=='auth/network-request-failed')throw error;}
   await signOut(auth);return {registered:true};
  }
  if(path==='/api/auth/forgot'){
   try{await sendPasswordResetEmail(auth,String(body.email||'').trim(),{url:config.pagesOrigin+config.pagesBasePath+'/login/',handleCodeInApp:false});}catch(error){if(error.code!=='auth/user-not-found')throw error;}
   return {message:'登録済みのメールアドレスの場合、再設定リンクを送信しました。受信箱と迷惑メールをご確認ください。'};
  }
  if(path==='/api/auth/reset'){password(body.password);await confirmPasswordReset(auth,body.token,body.password);await signOut(auth);return {reset:true};}
  if(path==='/api/auth/password'){password(body.password);await reauthenticate(body.currentPassword);await updatePassword(auth.currentUser,body.password);await signOut(auth);return {updated:true};}
  if(path==='/api/bootstrap'&&!auth.currentUser)return anonymous();
  if(!auth.currentUser){const error=new Error('ログインしてください。');error.status=401;error.signIn=true;throw error;}
  let data=body;
  if(path==='/api/account'&&options.method==='DELETE'){await reauthenticate(body.password);data={};}
  const result=(await invoke({path,method:options.method||'GET',body:data,expectedStaffId:new Headers(options.headers).get('X-Handwash-Profile')||undefined},options.signal)).data;
  if(path==='/api/account'&&options.method==='DELETE')await signOut(auth);
  if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');return result;
 }catch(error){
  if(error.name==='AbortError')throw error;
  if(expired(error)){await signOut(auth);if(path==='/api/bootstrap')return anonymous();}
  if(!error.code)throw error;
  throw readable(error);
 }
}};
