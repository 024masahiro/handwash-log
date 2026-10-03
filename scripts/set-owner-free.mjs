import {adminContext} from './firebase-admin-context.mjs';
const args=process.argv.slice(2),project=args[args.indexOf('--project')+1];if(!args.includes('--project'))throw new Error('--project を指定してください。');
const {auth}=adminContext(project),user=await auth.getUserByEmail('024masahiro@gmail.com');
if(user.disabled||!user.emailVerified)throw new Error('管理者の設定にはメールアドレスの確認が必要です。アカウント設定から確認メールを送信し、届いたリンクを開いてください。');
await auth.setCustomUserClaims(user.uid,{...user.customClaims,admin:true,owner:true});await auth.revokeRefreshTokens(user.uid);console.log('所有者に管理者権限を設定しました。ログインし直してください。');
