const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validName=value=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=60&&!/[\u0000-\u001f]/.test(value);
const validEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(value);
export class ApiError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const fail=(message,status)=>{throw new ApiError(message,status);};
function range(params,now,maxDays){const from=Number(params.get('from')),to=Number(params.get('to'));if(!params.has('from')||!params.has('to')||!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<=from||to-from>maxDays*86400000||to>now+2*86400000)fail('日付の範囲を確認してください。');return {from,to};}
const fields=(body,allowed)=>{if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!allowed.includes(key)))fail('入力の形式を確認してください。');};
async function maybeUser(auth,uid){try{return await auth.getUser(uid);}catch(error){if(error.code==='auth/user-not-found')return null;throw error;}}
export function createApi({db,auth,clock=Date.now}){
  return async function api(actor,input){
    if(!actor?.uid)fail('メールアドレスとパスワードでログインしてください。',401);
    const user=await maybeUser(auth,actor.uid);if(!user||user.disabled)fail('このアカウントは利用できません。',401);
    const isAdmin=user.customClaims?.admin===true,isOwner=isAdmin&&user.customClaims?.owner===true;
    const uid=user.uid,ref=db.collection('users').doc(uid);
    if(!input||typeof input.path!=='string'||input.path.length>600||!['GET','POST','DELETE'].includes(input.method))fail('操作を確認してください。');
    const url=new URL(input.path,'https://handwash.invalid');if(!url.pathname.startsWith('/api/'))fail('操作を確認してください。');
    const method=input.method,body=input.body||{};
    if(url.pathname.startsWith('/api/admin/')&&!isAdmin)fail('この画面は管理者のみ利用できます。',403);
    let profile=await ref.get();
    if(profile.exists&&profile.data().deleting)fail('このアカウントは削除処理中です。',401);
    if(url.pathname==='/api/profile'&&method==='POST'){
      fields(body,['name']);if(!validName(body.name))fail('氏名を60文字以内で入力してください。');
      await db.runTransaction(async transaction=>{const current=await transaction.get(ref);if(current.exists){if(current.data().deleting)fail('このアカウントは削除処理中です。',401);return;}transaction.create(ref,{name:body.name.trim().normalize('NFC'),email:user.email||'',createdAt:clock(),isAdmin,isOwner,deleting:false});});
      return {registered:true};
    }
    if(!profile.exists&&validName(user.displayName)){
      await db.runTransaction(async transaction=>{const current=await transaction.get(ref);if(!current.exists)transaction.create(ref,{name:user.displayName.trim().normalize('NFC'),email:user.email||'',createdAt:clock(),isAdmin,isOwner,deleting:false});});profile=await ref.get();
    }
    if(!profile.exists)fail('氏名が未設定です。管理者に設定を依頼してください。',409);
    const data=profile.data();
    if(url.pathname==='/api/bootstrap'&&method==='GET'){
      if(data.isAdmin!==isAdmin||data.isOwner!==isOwner||data.email!==(user.email||''))await ref.update({isAdmin,isOwner,email:user.email||''});
      return {myStaff:{id:uid,name:data.name,email:user.email||''},isAdmin,isOwner,authenticated:true,loginEmail:user.email||'',emailVerified:user.emailVerified,mailConfigured:true};
    }
    if(url.pathname==='/api/admin/summary'&&method==='GET'){
      const {from,to}=range(url.searchParams,clock(),2);
      const [users,washes]=await Promise.all([db.collection('users').get(),db.collectionGroup('washes').where('at','>=',from).where('at','<',to).get()]);
      const counts=new Map();for(const doc of washes.docs){const staffId=doc.ref.parent.parent.id,row=counts.get(staffId)||{count:0,latest:null};row.count++;row.latest=Math.max(row.latest||0,doc.data().at);counts.set(staffId,row);}
      const staff=users.docs.map(doc=>({id:doc.id,name:doc.data().name,login_email:doc.data().email||'',is_admin:doc.data().isAdmin===true,deleting:doc.data().deleting===true,...(counts.get(doc.id)||{count:0,latest:null})}));
      staff.sort((a,b)=>new Intl.Collator('ja').compare(a.name,b.name));return {staff,total:staff.reduce((n,row)=>n+row.count,0),recorded:staff.filter(row=>row.count>0).length};
    }
    const accountPath=url.pathname.match(/^\/api\/admin\/staff\/([^/]+)\/account$/);
    if(accountPath&&method==='POST'){
      fields(body,['name','email','password']);const target=accountPath[1];if(target.length>128)fail('利用者を確認してください。');
      const targetUser=await maybeUser(auth,target),targetRef=db.collection('users').doc(target),targetProfile=await targetRef.get();
      if(!targetProfile.exists||targetProfile.data().deleting)fail('利用者が見つかりません。',404);
      if(targetUser?.customClaims?.admin===true&&!isOwner)fail('管理者の情報は所有者のみ変更できます。',403);
      const name=typeof body.name==='string'?body.name.trim().normalize('NFC'):'',email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
      if(!validName(name)||!validEmail(email)||(body.password&&(typeof body.password!=='string'||body.password.length<10||body.password.length>128)))fail('氏名・メールアドレス・パスワードを確認してください。');
      if(targetUser?.customClaims?.admin===true&&email!==targetUser.email)fail('管理者のメールアドレスは変更できません。',403);
      if(!targetUser&&!body.password)fail('初期パスワードを10文字以上で設定してください。');
      const update={displayName:name,email};if(body.password)update.password=body.password;
      try{if(targetUser)await auth.updateUser(target,update);else await auth.createUser({uid:target,...update});}catch(error){if(error.code==='auth/email-already-exists')fail('このメールアドレスは登録済みです。',409);throw error;}
      await targetRef.update({name,email});if(targetUser&&(body.password||email!==targetUser.email))await auth.revokeRefreshTokens(target);return {updated:target};
    }
    const deletePath=url.pathname.match(/^\/api\/admin\/staff\/([^/]+)$/);
    if(url.pathname==='/api/account'&&method==='DELETE'||deletePath&&method==='DELETE'){
      const self=url.pathname==='/api/account',target=self?uid:deletePath[1];if(target.length>128)fail('利用者を確認してください。');
      const targetUser=await maybeUser(auth,target),targetRef=db.collection('users').doc(target),targetDoc=await targetRef.get();
      if(!targetDoc.exists)fail('利用者が見つかりません。',404);
      if(targetUser?.customClaims?.admin===true||targetDoc.data().isAdmin===true)fail('管理者アカウントは削除できません。',403);
      if(self&&(!Number.isFinite(actor.auth_time)||clock()/1000-actor.auth_time>300))fail('退会にはパスワードでの再確認が必要です。',401);
      await targetRef.update({deleting:true});if(targetUser)await auth.deleteUser(target);await db.recursiveDelete(targetRef);return {deleted:true};
    }
    if(url.pathname==='/api/records'&&method==='GET'){
      const requested=url.searchParams.get('staff');if(requested&&requested!==uid)fail('他の利用者の記録は開けません。',403);
      const {from,to}=range(url.searchParams,clock(),9);const result=await ref.collection('washes').where('at','>=',from).where('at','<',to).orderBy('at','desc').get();return {records:result.docs.map(doc=>({id:doc.id,at:doc.data().at,canDelete:true})),staffId:uid,serverTime:clock()};
    }
    if(url.pathname==='/api/records'&&method==='POST'){
      fields(body,['id']);if(!uuid.test(body.id||''))fail('記録の形式を確認してください。');
      if(input.expectedStaffId&&input.expectedStaffId!==uid)fail('ログイン中の利用者が変更されました。再読み込みしてください。',409);
      const recordRef=ref.collection('washes').doc(body.id);
      const record=await db.runTransaction(async transaction=>{const current=await transaction.get(ref);const saved=await transaction.get(recordRef);if(!current.exists||current.data().deleting)fail('このアカウントは利用できません。',401);if(saved.exists)return {id:saved.id,at:saved.data().at,canDelete:true};const at=clock();transaction.create(recordRef,{at});return {id:body.id,at,canDelete:true};});return {record,staffId:uid};
    }
    const recordPath=url.pathname.match(/^\/api\/records\/([0-9a-f-]+)$/);
    if(recordPath&&method==='DELETE'){if(!uuid.test(recordPath[1]))fail('記録を確認してください。');await ref.collection('washes').doc(recordPath[1]).delete();return {deleted:recordPath[1]};}
    fail('この操作は利用できません。',405);
  };
}
