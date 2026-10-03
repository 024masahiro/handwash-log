import {createFirebaseIdentity} from './firebase-identity.mjs';
import {createApi} from './api.mjs';
import {ApiError,fail} from './errors.mjs';
const allowedOrigin='https://024masahiro.github.io';
const corsHeaders=origin=>origin===allowedOrigin?{'Access-Control-Allow-Origin':origin,Vary:'Origin'}:{};
const json=(value,status,origin)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...corsHeaders(origin)}});
let cachedSecret,cachedProject,cachedIdentity;
function identityFor(env){
  if(cachedSecret!==env.FIREBASE_SERVICE_ACCOUNT||cachedProject!==env.FIREBASE_PROJECT_ID||!cachedIdentity){
    let credentials;try{credentials=JSON.parse(env.FIREBASE_SERVICE_ACCOUNT||'null');}catch{fail('Firebaseのサーバー設定が未完了です。',503,'setup-required');}
    cachedIdentity=createFirebaseIdentity({projectId:env.FIREBASE_PROJECT_ID,serviceAccount:credentials});cachedSecret=env.FIREBASE_SERVICE_ACCOUNT;cachedProject=env.FIREBASE_PROJECT_ID;
  }return cachedIdentity;
}
async function readBody(request){
  if(!request.body)return {};const reader=request.body.getReader();let size=0;const chunks=[];
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();fail('入力が長すぎます。',413);}chunks.push(value);}}finally{reader.releaseLock();}
  if(!size)return {};const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder().decode(data));}catch{fail('入力の形式を確認してください。');}
}
export function createWorker({getIdentity=identityFor,clock=Date.now}={}){
 return {async fetch(request,env){
  const origin=request.headers.get('Origin'),url=new URL(request.url);
  try{
    if(origin&&origin!==allowedOrigin)fail('この接続元からは操作できません。',403);
    if(request.method==='OPTIONS'){
      const headers=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(value=>value.trim()).filter(Boolean);
      if(origin!==allowedOrigin||!['GET','POST','DELETE'].includes(request.headers.get('Access-Control-Request-Method'))||headers.some(value=>!['authorization','content-type','x-handwash-profile'].includes(value)))fail('この接続元からは操作できません。',403);
      return new Response(null,{status:204,headers:{...corsHeaders(origin),'Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type,X-Handwash-Profile','Access-Control-Max-Age':'600'}});
    }
    if(url.pathname==='/'&&request.method==='GET')return json({ready:!!env.DB&&!!env.FIREBASE_SERVICE_ACCOUNT&&/^[a-z][a-z0-9-]{4,29}$/.test(env.FIREBASE_PROJECT_ID||'')&&env.HANDWASH_MIGRATION_LOCK!=='1',service:'handwash-free'},200,origin);
    if(!url.pathname.startsWith('/api/'))fail('ページが見つかりません。',404);
    if(!env.DB)fail('保存先の設定が未完了です。',503,'setup-required');
    if(env.HANDWASH_MIGRATION_LOCK==='1')fail('保存先を準備中です。公開切り替え後にお試しください。',503,'migration-locked');
    if(!['GET','POST','DELETE'].includes(request.method))fail('この操作は利用できません。',405);
    const token=request.headers.get('Authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if(url.pathname==='/api/bootstrap'&&request.method==='GET'&&!token)return json({myStaff:null,isAdmin:false,isOwner:false,authenticated:false,mailConfigured:true},200,origin);
    if(!token)fail('ログインしてください。',401,'unauthenticated');
    const identity=getIdentity(env),actor=await identity.authenticate(token);
    const body=request.method==='GET'?{}:await readBody(request);
    const result=await createApi({db:env.DB,identity,clock})(actor,{path:url.pathname+url.search,method:request.method,body,expectedStaffId:request.headers.get('X-Handwash-Profile')||undefined});
    return json(result,200,origin);
  }catch(error){
    if(error instanceof ApiError)return json({error:error.message,code:error.code},error.status,origin);
    // D1 free-plan limits and provider errors stop operations; they do not enable a paid plan.
    console.error('Handwash operation failed',{code:error.code||'unavailable'});return json({error:'処理を完了できませんでした。少し待って再度お試しください。'},503,origin);
  }
 }};
}
export default createWorker();
