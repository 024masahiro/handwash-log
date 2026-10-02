import {initializeApp,applicationDefault} from '../firebase-functions/node_modules/firebase-admin/lib/esm/app/index.js';
import {getAuth} from '../firebase-functions/node_modules/firebase-admin/lib/esm/auth/index.js';
import {getFirestore} from '../firebase-functions/node_modules/firebase-admin/lib/esm/firestore/index.js';
const args=process.argv.slice(2),project=args[args.indexOf('--project')+1];
if(!args.includes('--project')||!/^[a-z][a-z0-9-]{4,29}$/.test(project))throw new Error('--project にプロジェクトIDを指定してください。');
// Only this repository owner's account is eligible; no role-setting endpoint is public.
const email='024masahiro@gmail.com',app=initializeApp({projectId:project,credential:applicationDefault()}),auth=getAuth(app),db=getFirestore(app);
const user=await auth.getUserByEmail(email);if(user.disabled)throw new Error('無効なアカウントには権限を付与できません。');
if(!user.emailVerified)throw new Error('管理者の設定にはメールアドレスの確認が必要です。アカウント設定から確認メールを送信し、届いたリンクを開いてください。');
const ref=db.doc('users/'+user.uid);if(!(await ref.get()).exists)throw new Error('利用者の名簿が未設定です。移行または利用者登録を先に完了してください。');
await auth.setCustomUserClaims(user.uid,{...user.customClaims,admin:true,owner:true});await ref.update({isAdmin:true,isOwner:true});await auth.revokeRefreshTokens(user.uid);console.log('所有者に管理者権限を設定しました。ログインし直してください。');
