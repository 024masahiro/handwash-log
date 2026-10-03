import {initializeApp,applicationDefault,cert} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
export function adminContext(project){
 if(!/^[a-z][a-z0-9-]{4,29}$/.test(project))throw new Error('プロジェクトIDを確認してください。');
 let credential;
 if(process.env.FIREBASE_SERVICE_ACCOUNT){const account=JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);if(account.project_id!==project)throw new Error('認証情報のプロジェクトIDが一致しません。');credential=cert(account);}
 else credential=applicationDefault();
 const app=initializeApp({projectId:project,credential});return {app,auth:getAuth(app)};
}
