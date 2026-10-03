import {ApiError,fail} from './errors.mjs';
const encoder=new TextEncoder();
const bytes=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const base64url=value=>btoa(String.fromCharCode(...value)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const encoded=value=>base64url(encoder.encode(JSON.stringify(value)));
const validUid=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const oauthUrl='https://oauth2.googleapis.com/token';
const jwksUrl='https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const userOf=raw=>{
  let customClaims={};try{customClaims=JSON.parse(raw.customAttributes||'{}');}catch{fail('認証情報を確認できませんでした。',502,'invalid-auth-data');}
  const validSince=Number(raw.validSince||0);if(!validUid(raw.localId)||!Number.isFinite(validSince)||validSince<0||!customClaims||Array.isArray(customClaims)||typeof customClaims!=='object')fail('認証情報を確認できませんでした。',502,'invalid-auth-data');
  return {uid:raw.localId,email:raw.email||'',displayName:raw.displayName||'',emailVerified:raw.emailVerified===true,disabled:raw.disabled===true,validSince,customClaims};
};
export function createFirebaseIdentity({projectId,serviceAccount,fetcher=fetch,clock=Date.now}){
  if(!/^[a-z][a-z0-9-]{4,29}$/.test(projectId)||serviceAccount?.project_id!==projectId||!serviceAccount.client_email?.endsWith('.iam.gserviceaccount.com')||typeof serviceAccount.private_key!=='string')fail('Firebaseのサーバー設定が未完了です。',503,'setup-required');
  let signingKey,access,accessUntil=0,pendingAccess,keys=new Map(),keysUntil=0,lastKeysFetch=0,pendingKeys;
  async function accessToken(){
    if(access&&clock()<accessUntil)return access;
    if(pendingAccess)return pendingAccess;
    pendingAccess=(async()=>{
      if(!signingKey){const pem=serviceAccount.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,'');signingKey=await crypto.subtle.importKey('pkcs8',bytes(pem),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);}
      const now=Math.floor(clock()/1000),data=encoded({alg:'RS256',typ:'JWT'})+'.'+encoded({iss:serviceAccount.client_email,scope:'https://www.googleapis.com/auth/identitytoolkit',aud:oauthUrl,iat:now,exp:now+3600});
      const signature=base64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',signingKey,encoder.encode(data))));
      const response=await fetcher(oauthUrl,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:data+'.'+signature}),signal:AbortSignal.timeout(15000)});
      const result=await response.json();if(!response.ok||typeof result.access_token!=='string')fail('認証サービスに接続できませんでした。',502,'oauth-failed');
      access=result.access_token;accessUntil=clock()+(Math.min(3600,Number(result.expires_in)||3600)-90)*1000;return access;
    })();try{return await pendingAccess;}finally{pendingAccess=null;}
  }
  async function request(endpoint,body){
    const response=await fetcher('https://identitytoolkit.googleapis.com/v1/projects/'+projectId+'/accounts'+endpoint,{method:'POST',headers:{Authorization:'Bearer '+await accessToken(),'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    const result=await response.json();if(!response.ok){
      const message=result.error?.message||'';
      if(message.startsWith('USER_NOT_FOUND')||message.startsWith('EMAIL_NOT_FOUND'))return null;
      if(message.startsWith('EMAIL_EXISTS'))fail('このメールアドレスは登録済みです。',409,'email-exists');
      if(message.startsWith('INVALID_PASSWORD')||message.startsWith('INVALID_EMAIL'))fail('メールアドレス・パスワードを確認してください。');
      if(response.status===401)accessUntil=0;
      fail('認証サービスの処理を完了できませんでした。',502,'auth-service-failed');
    }return result;
  }
  async function loadKeys(){
    if(pendingKeys)return pendingKeys;
    pendingKeys=(async()=>{
      lastKeysFetch=clock();const response=await fetcher(jwksUrl,{signal:AbortSignal.timeout(10000)});if(!response.ok)fail('認証情報を確認できませんでした。',502,'keys-unavailable');
      const result=await response.json();if(!Array.isArray(result.keys)||result.keys.length>20)fail('認証情報を確認できませんでした。',502,'invalid-keys');
      const next=new Map();for(const key of result.keys){if(key.kty==='RSA'&&typeof key.kid==='string')next.set(key.kid,await crypto.subtle.importKey('jwk',key,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']));}
      if(!next.size)fail('認証情報を確認できませんでした。',502,'empty-keys');keys=next;
      const seconds=Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1]||300);keysUntil=clock()+Math.min(21600,Math.max(60,seconds))*1000;
    })();try{await pendingKeys;}finally{pendingKeys=null;}
  }
  async function getUsers(uids){
    const users=[];for(let i=0;i<uids.length;i+=100){const result=await request(':lookup',{localId:uids.slice(i,i+100)});for(const raw of result?.users||[])users.push(userOf(raw));}return users;
  }
  const getUser=async uid=>(await getUsers([uid])).find(user=>user.uid===uid)||null;
  return {
    getUser,getUsers,
    async authenticate(token){
      if(typeof token!=='string'||token.length>8192)fail('ログインしてください。',401,'unauthenticated');
      let header,payload,parts;try{parts=token.split('.');if(parts.length!==3)throw new Error();header=JSON.parse(new TextDecoder().decode(bytes(parts[0])));payload=JSON.parse(new TextDecoder().decode(bytes(parts[1])));}catch{fail('ログインしてください。',401,'unauthenticated');}
      if(!header||typeof header!=='object'||Array.isArray(header)||!payload||typeof payload!=='object'||Array.isArray(payload))fail('ログインしてください。',401,'unauthenticated');
      const now=clock()/1000;
      if(header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length>160||payload.aud!==projectId||payload.iss!=='https://securetoken.google.com/'+projectId||!validUid(payload.sub)||!Number.isFinite(payload.exp)||payload.exp<=now||!Number.isFinite(payload.iat)||payload.iat>now+30||!Number.isFinite(payload.auth_time)||payload.auth_time>now+30)fail('ログインの有効期限が切れました。',401,'unauthenticated');
      if(clock()>=keysUntil||(!keys.has(header.kid)&&clock()-lastKeysFetch>=60000))await loadKeys();
      const key=keys.get(header.kid);let verified=false;try{verified=key&&await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,bytes(parts[2]),encoder.encode(parts[0]+'.'+parts[1]));}catch{}
      if(!verified)fail('ログインしてください。',401,'unauthenticated');
      const user=await getUser(payload.sub);if(!user||user.disabled||payload.auth_time<user.validSince)fail('ログインの有効期限が切れました。再度ログインしてください。',401,'unauthenticated');
      return {uid:user.uid,auth_time:payload.auth_time,user};
    },
    async updateUser(uid,update){const body={localId:uid,...update};if(update.password||update.email)body.validSince=String(Math.floor(clock()/1000));const result=await request(':update',body);if(!result)fail('利用者が見つかりません。',404);return result;},
    async createUser(uid,update){const result=await request('',{localId:uid,...update});if(result?.localId!==uid)fail('利用者を作成できませんでした。',502);return result;},
    async deleteUser(uid){await request(':delete',{localId:uid});return {deleted:true};}
  };
}
