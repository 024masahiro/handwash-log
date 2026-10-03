import {createHash} from 'node:crypto';
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const emailValid=value=>typeof value==='string'&&value.length<=254&&/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(value);
export const hashOptions={hash:{algorithm:'PBKDF2_SHA256',rounds:100000}};
export function importPlan(backup,ownerEmail){
 if(!Array.isArray(backup.staff)||!Array.isArray(backup.washes))throw new Error('バックアップにはstaffとwashesの全行が必要です。');
 if(!emailValid(ownerEmail))throw new Error('所有者のメールアドレスを確認してください。');
 const users=[],profiles=[],washes=[],ids=new Set(),emails=new Set();
 for(const row of backup.staff){
  if(!safeId(row.id)||ids.has(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>60)throw new Error('名簿のID・氏名を確認してください。');ids.add(row.id);
  const email=String(row.login_email||'').trim().toLowerCase(),admin=row.is_admin===1||row.is_admin===true,owner=admin&&email===ownerEmail.toLowerCase();
  if(email&&!emailValid(email))throw new Error('名簿のメールアドレスを確認してください。');if(email&&emails.has(email))throw new Error('名簿に重複メールアドレスがあります。');emails.add(email);
  const claims={admin,owner};
  profiles.push({uid:row.id,data:{name:row.name,email,isAdmin:admin,isOwner:owner,createdAt:0,deleting:false}});
  if(!email)continue;
  const user={uid:row.id,email,displayName:row.name,emailVerified:owner,customClaims:claims};
  if(row.password_hash){
   const match=/^([0-9a-f]{32}):([0-9a-f]{64})$/.exec(row.password_hash);if(!match)throw new Error('パスワードのバックアップが完全ではありません。');
   // Legacy WebCrypto used the ASCII hex string as the PBKDF2 salt, not decoded bytes.
   user.passwordHash=Buffer.from(match[2],'hex');user.passwordSalt=Buffer.from(match[1],'utf8');
  }
  users.push(user);
 }
 const recordIds=new Set();let unassigned=0;
 for(const row of backup.washes){
  if(!safeId(row.id)||recordIds.has(row.id)||!Number.isSafeInteger(row.washed_at)||row.washed_at<0)throw new Error('記録のID・日時を確認してください。');recordIds.add(row.id);
  let uid=row.staff_id;if(!uid){uid='legacy-unassigned';unassigned++;}else if(!ids.has(uid))throw new Error('名簿に存在しない職員の記録があります。');
  washes.push({uid,id:row.id,at:row.washed_at});
 }
 if(unassigned){if(ids.has('legacy-unassigned'))throw new Error('旧記録用のIDが重複しています。');profiles.push({uid:'legacy-unassigned',data:{name:'所属未設定の旧記録',email:'',isAdmin:false,isOwner:false,createdAt:0,deleting:false}});}
 const digest=createHash('sha256').update(JSON.stringify({backup,ownerEmail:ownerEmail.toLowerCase()})).digest('hex');
 return {users,profiles,washes,digest,summary:{accounts:users.length,profiles:profiles.length,records:washes.length,unassigned}};
}
