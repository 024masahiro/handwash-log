import {initializeApp} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore} from 'firebase-admin/firestore';
import {onCall,HttpsError} from 'firebase-functions/v2/https';
import {createApi,ApiError} from './api.mjs';
initializeApp();
const auth=getAuth(),api=createApi({db:getFirestore(),auth});
const codes={400:'invalid-argument',401:'unauthenticated',403:'permission-denied',404:'not-found',405:'invalid-argument',409:'failed-precondition'};
export const handwashApi=onCall({region:'asia-northeast1',timeoutSeconds:120,maxInstances:5,cors:['https://024masahiro.github.io',...(process.env.FUNCTIONS_EMULATOR==='true'?[/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/]:[])]},async request=>{
  const token=request.rawRequest.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if(!token||!request.auth)throw new HttpsError('unauthenticated','ログインしてください。');
  let actor;try{actor=await auth.verifyIdToken(token,true);}catch{throw new HttpsError('unauthenticated','ログインの有効期限が切れました。再度ログインしてください。');}
  try{return await api(actor,request.data);}catch(error){if(error instanceof ApiError)throw new HttpsError(codes[error.status]||'internal',error.message,{status:error.status});console.error('Handwash operation failed',{code:error.code||'unknown'});throw new HttpsError('internal','処理を完了できませんでした。少し待って再度お試しください。');}
});
