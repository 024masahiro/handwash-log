import {fail} from './errors.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uidValid=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const validName=value=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=60&&!/[\u0000-\u001f]/.test(value);
const validEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(value);
const fields=(body,allowed)=>{if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!allowed.includes(key)))fail('入力の形式を確認してください。');};
function range(params,now,maxDays){const from=Number(params.get('from')),to=Number(params.get('to'));if(!params.has('from')||!params.has('to')||!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<=from||to-from>maxDays*86400000||to>now+2*86400000)fail('日付の範囲を確認してください。');return {from,to};}
const admin=user=>user?.customClaims?.admin===true;
export function createApi({db,identity,clock=Date.now}){
  const statement=(sql,...values)=>db.prepare(sql).bind(...values);
  const staff=uid=>statement('SELECT * FROM staff WHERE id = ?',uid).first();
  const createProfile=async(user,name)=>{await statement('INSERT INTO staff (id,name,email,is_admin,is_owner,deleting,created_at) VALUES (?,?,?,?,?,0,?) ON CONFLICT(id) DO NOTHING',user.uid,name.trim().normalize('NFC'),user.email||'',Number(admin(user)),Number(admin(user)&&user.customClaims?.owner===true),clock()).run();};
  return async function api(actor,input){
    if(!actor?.user||!uidValid(actor.uid)||actor.user.uid!==actor.uid||actor.user.disabled)fail('ログインしてください。',401,'unauthenticated');
    const user=actor.user,uid=actor.uid,isAdmin=admin(user),isOwner=isAdmin&&user.customClaims?.owner===true&&user.email==='024masahiro@gmail.com'&&user.emailVerified===true;
    if(!input||typeof input.path!=='string'||input.path.length>600||!['GET','POST','DELETE'].includes(input.method))fail('操作を確認してください。');
    const url=new URL(input.path,'https://handwash.invalid'),method=input.method,body=input.body??{};
    if(!url.pathname.startsWith('/api/'))fail('操作を確認してください。');
    if(url.pathname.startsWith('/api/admin/')&&!isAdmin)fail('この画面は管理者のみ利用できます。',403);
    let profile=await staff(uid);if(profile?.deleting)fail('このアカウントは削除処理中です。',401,'unauthenticated');
    if(url.pathname==='/api/profile'&&method==='POST'){
      fields(body,['name']);if(!validName(body.name))fail('氏名を60文字以内で入力してください。');
      await createProfile(user,body.name);return {registered:true};
    }
    if(!profile&&validName(user.displayName)){await createProfile(user,user.displayName);profile=await staff(uid);}
    if(!profile)fail('氏名が未設定です。新規登録画面で登録を完了してください。',409,'profile-required');
    if(url.pathname==='/api/bootstrap'&&method==='GET'){
      if(profile.is_admin!==Number(isAdmin)||profile.is_owner!==Number(isOwner)||profile.email!==(user.email||''))await statement('UPDATE staff SET is_admin=?,is_owner=?,email=? WHERE id=? AND deleting=0',Number(isAdmin),Number(isOwner),user.email||'',uid).run();
      return {myStaff:{id:uid,name:profile.name,email:user.email||''},isAdmin,isOwner,authenticated:true,loginEmail:user.email||'',emailVerified:user.emailVerified,mailConfigured:true};
    }
    if(url.pathname==='/api/ranking'&&method==='GET'){
      const offset=9*3600000,from=Math.floor((clock()+offset)/86400000)*86400000-offset,to=from+86400000;
      const result=await statement('SELECT s.id,s.name,COUNT(w.id) AS count FROM staff s JOIN washes w ON w.staff_id=s.id AND w.washed_at>=? AND w.washed_at<? WHERE s.deleting=0 GROUP BY s.id LIMIT 501',from,to).all();
      if(result.results.length>500)fail('利用者が多いため、ランキングの対応が必要です。',409);
      const collator=new Intl.Collator('ja'),rows=result.results.sort((a,b)=>b.count-a.count||collator.compare(a.name,b.name)||a.id.localeCompare(b.id));
      let rank=0,previousCount=null;
      const ranked=rows.map((row,index)=>{if(row.count!==previousCount)rank=index+1;previousCount=row.count;return {...row,rank};});
      const me=ranked.find(row=>row.id===uid);
      return {date:new Date(from+offset).toISOString().slice(0,10),ranking:ranked.filter(row=>row.rank<=10).map(row=>({rank:row.rank,name:row.name,count:row.count,isSelf:row.id===uid})),me:{rank:me?.rank??null,count:me?.count??0}};
    }
    if(url.pathname==='/api/admin/summary'&&method==='GET'){
      const {from,to}=range(url.searchParams,clock(),2);
      const result=await statement('SELECT s.id,s.name,s.email AS login_email,s.is_admin,s.deleting,COUNT(w.id) AS count,MAX(w.washed_at) AS latest FROM staff s LEFT JOIN washes w ON w.staff_id=s.id AND w.washed_at>=? AND w.washed_at<? GROUP BY s.id LIMIT 501',from,to).all();
      if(result.results.length>500)fail('利用者が多いため、管理画面の対応が必要です。',409);
      const users=await identity.getUsers(result.results.map(row=>row.id)),current=new Map(users.map(account=>[account.uid,account]));
      const rows=result.results.map(row=>({...row,is_admin:current.has(row.id)?admin(current.get(row.id)):row.is_admin===1,deleting:row.deleting===1}));
      const collator=new Intl.Collator('ja');rows.sort((a,b)=>collator.compare(a.name,b.name));return {staff:rows,total:rows.reduce((sum,row)=>sum+row.count,0),recorded:rows.filter(row=>row.count>0).length};
    }
    const accountPath=url.pathname.match(/^\/api\/admin\/staff\/([^/]+)\/account$/);
    if(accountPath&&method==='POST'){
      fields(body,['name','email','password']);const target=accountPath[1];if(!uidValid(target))fail('利用者を確認してください。');
      const targetProfile=await staff(target);if(!targetProfile||targetProfile.deleting)fail('利用者が見つかりません。',404);
      const targetUser=await identity.getUser(target),protectedAdmin=admin(targetUser)||targetProfile.is_admin===1;
      if(protectedAdmin&&!isOwner)fail('管理者の情報は所有者のみ変更できます。',403);
      const name=typeof body.name==='string'?body.name.trim().normalize('NFC'):'',email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
      if(!validName(name)||!validEmail(email)||(body.password&&(typeof body.password!=='string'||body.password.length<10||body.password.length>128)))fail('氏名・メールアドレス・パスワードを確認してください。');
      if(protectedAdmin&&email!==(targetUser?.email||targetProfile.email))fail('管理者のメールアドレスは変更できません。',403);
      if(!targetUser&&!body.password)fail('初期パスワードを10文字以上で設定してください。');
      const duplicate=await statement('SELECT id FROM staff WHERE email=? AND id<>?',email,target).first();if(duplicate)fail('このメールアドレスは登録済みです。',409);
      const update={displayName:name};if(!targetUser||email!==targetUser.email){update.email=email;update.emailVerified=false;}if(body.password)update.password=body.password;
      if(targetUser)await identity.updateUser(target,update);else await identity.createUser(target,update);
      await statement('UPDATE staff SET name=?,email=? WHERE id=? AND deleting=0',name,email,target).run();return {updated:target};
    }
    const deletePath=url.pathname.match(/^\/api\/admin\/staff\/([^/]+)$/);
    if(url.pathname==='/api/account'&&method==='DELETE'||deletePath&&method==='DELETE'){
      fields(body,[]);const self=url.pathname==='/api/account',target=self?uid:deletePath[1];if(!uidValid(target))fail('利用者を確認してください。');
      const targetProfile=await staff(target);if(!targetProfile)fail('利用者が見つかりません。',404);
      const targetUser=await identity.getUser(target);
      if(admin(targetUser)||targetProfile.is_admin===1)fail('管理者アカウントは削除できません。',403);
      if(self&&(!Number.isFinite(actor.auth_time)||clock()/1000-actor.auth_time>300||actor.auth_time>clock()/1000+30))fail('退会にはパスワードでの再確認が必要です。',401,'recent-login-required');
      await statement('UPDATE staff SET deleting=1 WHERE id=?',target).run();if(targetUser)await identity.deleteUser(target);
      // Both deletes are in one D1 transaction. ON DELETE CASCADE also protects the relationship.
      await db.batch([statement('DELETE FROM washes WHERE staff_id=?',target),statement('DELETE FROM staff WHERE id=?',target)]);return {deleted:true};
    }
    if(url.pathname==='/api/records'&&method==='GET'){
      const requested=url.searchParams.get('staff');if(requested&&requested!==uid)fail('他の利用者の記録は開けません。',403);
      const {from,to}=range(url.searchParams,clock(),9),result=await statement('SELECT id,washed_at AS at FROM washes WHERE staff_id=? AND washed_at>=? AND washed_at<? ORDER BY washed_at DESC,id DESC',uid,from,to).all();
      return {records:result.results.map(record=>({...record,canDelete:true})),staffId:uid,serverTime:clock()};
    }
    if(url.pathname==='/api/records'&&method==='POST'){
      fields(body,['id']);if(!uuid.test(body.id||''))fail('記録の形式を確認してください。');
      if(input.expectedStaffId&&input.expectedStaffId!==uid)fail('ログイン中の利用者が変更されました。再読み込みしてください。',409);
      const [,result]=await db.batch([
        statement('INSERT INTO washes (id,staff_id,washed_at) SELECT ?,id,? FROM staff WHERE id=? AND deleting=0 ON CONFLICT(id) DO NOTHING',body.id,clock(),uid),
        statement('SELECT id,washed_at AS at FROM washes WHERE id=? AND staff_id=?',body.id,uid)
      ]);
      const record=result.results[0];if(!record)fail('この記録を保存できませんでした。再読み込みしてください。',409);
      return {record:{...record,canDelete:true},staffId:uid};
    }
    const recordPath=url.pathname.match(/^\/api\/records\/([0-9a-f-]+)$/);
    if(recordPath&&method==='DELETE'){if(!uuid.test(recordPath[1]))fail('記録を確認してください。');await statement('DELETE FROM washes WHERE id=? AND staff_id=?',recordPath[1],uid).run();return {deleted:recordPath[1]};}
    fail('この操作は利用できません。',405);
  };
}
