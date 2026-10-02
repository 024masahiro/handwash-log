const PAGE = '__HANDWASH_PAGE__';
const CSP = '__HANDWASH_CSP__';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

function database(env) {
  if (!env.DB?.prepare) throw new Error('Database binding is unavailable');
  return env.DB;
}

const validEmail = email => typeof email === 'string' && email.length <= 254 && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email);
const encoder = new TextEncoder();
const hex = data => [...new Uint8Array(data)].map(n=>n.toString(16).padStart(2,'0')).join('');
const digest = async text => hex(await crypto.subtle.digest('SHA-256',encoder.encode(text)));
async function passwordHash(password,salt=hex(crypto.getRandomValues(new Uint8Array(16)))) {
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encoder.encode(salt),iterations:100000},key,256);
  return salt+':'+hex(bits);
}
async function passwordMatches(password,stored) {
  const candidate=await passwordHash(password,stored?.split(':')[0] || 'invalid-password-salt');
  const expected=stored || '0'.repeat(candidate.length);let mismatch=candidate.length ^ expected.length;
  for(let i=0;i<candidate.length;i++)mismatch |= candidate.charCodeAt(i) ^ (expected.charCodeAt(i)||0);
  return mismatch===0;
}
const validPassword = value => typeof value==='string' && value.length>=10 && value.length<=128;
const cookie = (token,maxAge=28800) => '__Host-handwash='+token+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age='+maxAge;
function requestToken(request) {
  const authorization=request.headers.get('Authorization');
  if(authorization)return authorization.match(/^Bearer ([a-f0-9]{64})$/)?.[1] || null;
  return request.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-handwash=([a-f0-9]{64})(?:;|$)/)?.[1] || null;
}
async function sessionUser(db,request) {
  const token=requestToken(request);
  if(!token)return null;
  return db.prepare('SELECT s.id,s.name,s.code,s.login_email,s.is_admin FROM sessions t JOIN staff s ON s.id=t.staff_id WHERE t.token_hash=? AND t.expires_at>? AND s.password_hash IS NOT NULL').bind(await digest(token),Date.now()).first();
}
async function readBody(request) {
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new Error('Invalid body');
  const text=await request.text();if(text.length>3000)throw new Error('Invalid body');
  const value=JSON.parse(text);if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Invalid body');return value;
}

async function limited(db,request,purpose,identity,limit=10) {
  const now=Date.now(),window=Math.floor(now/900000),ip=request.headers.get('CF-Connecting-IP')||'unknown';
  const buckets=await Promise.all([purpose+':'+identity,purpose+':ip:'+ip].map(async key=>window+':'+await digest(key)));
  await db.batch([db.prepare('DELETE FROM login_attempts WHERE expires_at<=?').bind(now),...buckets.map(bucket=>db.prepare('INSERT INTO login_attempts (bucket,attempts,expires_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1').bind(bucket,now+900000))]);
  for(const [index,bucket] of buckets.entries()){const row=await db.prepare('SELECT attempts FROM login_attempts WHERE bucket=?').bind(bucket).first();if(row.attempts>(index===0?limit:200))return true;}return false;
}
const validName=value=>typeof value==='string' && value.trim().length>0 && value.trim().length<=60 && !/[\u0000-\u001f]/.test(value);
const bytes=text=>Uint8Array.from(text.match(/.{2}/g)||[],value=>parseInt(value,16));
async function secretKey(env) {
  if(!/^[a-f0-9]{64}$/.test(env.HANDWASH_SETTINGS_KEY||''))throw new Error('Mail settings encryption unavailable');
  return crypto.subtle.importKey('raw',bytes(env.HANDWASH_SETTINGS_KEY),'AES-GCM',false,['encrypt','decrypt']);
}
async function seal(value,env) {
  const iv=crypto.getRandomValues(new Uint8Array(12));const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},await secretKey(env),encoder.encode(JSON.stringify(value)));return hex(iv)+':'+hex(cipher);
}
async function mailSettings(db,env) {
  const row=await db.prepare("SELECT value FROM app_settings WHERE key='mail'").first();if(!row)return null;
  const [iv,cipher]=row.value.split(':');return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv)},await secretKey(env),bytes(cipher))));
}
async function sendMail(config,to,subject,html) {
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+config.apiKey,'Content-Type':'application/json'},body:JSON.stringify({from:config.from,to:[to],subject,html}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('Mail delivery failed');
}
async function removeAccount(db,id) {
  await db.batch([db.prepare('DELETE FROM sessions WHERE staff_id=?').bind(id),db.prepare('DELETE FROM password_resets WHERE staff_id=?').bind(id),db.prepare('DELETE FROM washes WHERE staff_id=?').bind(id),db.prepare('DELETE FROM staff WHERE id=?').bind(id)]);
}

const app = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if(env.HANDWASH_MIGRATION_FREEZE==='1'&&url.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(request.method)&&!['/api/auth/login','/api/auth/logout'].includes(url.pathname))return json({error:'保存先を移行中です。記録・登録・変更・削除を一時停止しています。切り替え後に再度お試しください。'},503);
    if (['/','/login','/register','/forgot','/reset','/admin','/account'].includes(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(request.method === 'HEAD' ? null : PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
      });
    }
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    if (request.method !== 'GET') {
      const origin = request.headers.get('Origin');
      if ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
        return json({ error: 'このページから操作をやり直してください。' }, 403);
      }
    }
    try {
      const db = database(env);
      if(url.pathname==='/api/auth/login' && request.method==='POST') {
        let body;try{body=await readBody(request);}catch{return json({error:'メールアドレスとパスワードを入力してください。'},400);}
        const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
        if(!validEmail(email) || typeof body.password!=='string' || body.password.length>128)return json({error:'メールアドレスとパスワードを確認してください。'},400);
        const now=Date.now();if(await limited(db,request,'login',email))return json({error:'ログインの試行が多いため、15分後にお試しください。'},429);
        const person=await db.prepare('SELECT id,password_hash FROM staff WHERE login_email=?').bind(email).first();
        if(!await passwordMatches(body.password,person?.password_hash))return json({error:'メールアドレスまたはパスワードが違います。'},401);
        const token=hex(crypto.getRandomValues(new Uint8Array(32)));
        await db.batch([db.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now),db.prepare('DELETE FROM login_attempts WHERE expires_at<=?').bind(now),db.prepare('INSERT INTO sessions (token_hash,staff_id,expires_at) VALUES (?,?,?)').bind(await digest(token),person.id,now+28800000)]);
        const pagesLogin=request.headers.get('Origin')===env.HANDWASH_ALLOWED_ORIGIN;
        const response=json({loggedIn:true,...(pagesLogin?{token}:{})});response.headers.set('Set-Cookie',cookie(token));return response;
      }
      if(url.pathname==='/api/auth/logout' && request.method==='POST') {
        const token=requestToken(request);
        if(token)await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).run();
        const response=json({loggedOut:true});response.headers.set('Set-Cookie',cookie('',0));return response;
      }
      if(url.pathname==='/api/auth/register' && request.method==='POST') {
        let body;try{body=await readBody(request);}catch{return json({error:'入力内容を確認してください。'},400);}
        if(Object.keys(body).some(key=>!['name','email','password'].includes(key)) || !validName(body.name) || !validPassword(body.password))return json({error:'氏名と10〜128文字のパスワードを入力してください。'},400);
        const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';if(!validEmail(email))return json({error:'有効なメールアドレスを入力してください。'},400);
        if(await limited(db,request,'register',email,5))return json({error:'登録の試行が多いため、15分後にお試しください。'},429);
        if(await db.prepare('SELECT id FROM staff WHERE login_email=?').bind(email).first())return json({error:'登録済みのメールアドレスです。ログインまたはパスワード再設定をご利用ください。'},409);
        await db.prepare('INSERT INTO staff (id,name,login_email,password_hash,is_admin) VALUES (?,?,?,?,0)').bind(crypto.randomUUID(),body.name.trim().normalize('NFC'),email,await passwordHash(body.password)).run();return json({registered:true},201);
      }
      if(url.pathname==='/api/auth/forgot' && request.method==='POST') {
        let body;try{body=await readBody(request);}catch{return json({error:'メールアドレスを入力してください。'},400);}
        const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';if(!validEmail(email))return json({error:'有効なメールアドレスを入力してください。'},400);
        if(await limited(db,request,'forgot',email,3))return json({error:'再設定の依頼が多いため、15分後にお試しください。'},429);
        const config=await mailSettings(db,env);if(!config)return json({error:'メール送信の設定が完了していません。管理者にお問い合わせください。'},503);
        const person=await db.prepare('SELECT id FROM staff WHERE login_email=? AND password_hash IS NOT NULL').bind(email).first();
        if(person){
          const token=hex(crypto.getRandomValues(new Uint8Array(32)));const hash=await digest(token);
          await db.batch([db.prepare('DELETE FROM password_resets WHERE expires_at<=?').bind(Date.now()),db.prepare('INSERT INTO password_resets (token_hash,staff_id,expires_at) VALUES (?,?,?)').bind(hash,person.id,Date.now()+900000)]);
          const link=env.HANDWASH_FRONTEND_URL?env.HANDWASH_FRONTEND_URL.replace(/\/$/,'')+'/reset/#token='+token:(env.HANDWASH_SITE_ORIGIN||url.origin)+'/reset#token='+token;
          try{await sendMail(config,email,'手洗いログ：パスワード再設定','<p>パスワードを再設定するには、以下のリンクを開いてください。</p><p><a href="'+link+'">パスワードを再設定する</a></p><p>有効期限は15分です。心当たりがなければ、このメールを破棄してください。</p>');}
          catch{await db.prepare('DELETE FROM password_resets WHERE token_hash=?').bind(hash).run();console.error('Password reset email delivery failed');}
        }
        return json({message:'登録済みのメールアドレス宛に再設定リンクを送信します。メールが届かない場合は管理者にお問い合わせください。'});
      }
      if(url.pathname==='/api/auth/reset' && request.method==='POST') {
        let body;try{body=await readBody(request);}catch{return json({error:'再設定の内容を確認してください。'},400);}
        if(!/^[a-f0-9]{64}$/.test(body.token||'') || !validPassword(body.password))return json({error:'有効なリンクと10〜128文字のパスワードが必要です。'},400);
        const hash=await digest(body.token),reset=await db.prepare('SELECT staff_id FROM password_resets WHERE token_hash=? AND expires_at>?').bind(hash,Date.now()).first();if(!reset)return json({error:'リンクの有効期限が切れているか、すでに使用されています。再設定を再度依頼してください。'},400);
        const newHash=await passwordHash(body.password);
        const result=await db.batch([
          db.prepare('UPDATE staff SET password_hash=? WHERE id=? AND EXISTS (SELECT 1 FROM password_resets WHERE token_hash=? AND expires_at>?)').bind(newHash,reset.staff_id,hash,Date.now()),
          db.prepare('DELETE FROM sessions WHERE staff_id=?').bind(reset.staff_id),
          db.prepare('DELETE FROM password_resets WHERE staff_id=?').bind(reset.staff_id),
        ]);
        if(!result[0].meta?.changes)return json({error:'リンクはすでに使用されています。'},400);
        const response=json({reset:true});response.headers.set('Set-Cookie',cookie('',0));return response;
      }
      const ownStaff=await sessionUser(db,request);
      const ownerEmail=request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
      const owner=!!env.HANDWASH_ADMIN_EMAIL && ownerEmail===env.HANDWASH_ADMIN_EMAIL.toLowerCase();
      const isAdmin=!!ownStaff?.is_admin || owner;
      const userId=ownStaff?.id;
      if(url.pathname==='/api/bootstrap' && request.method==='GET')return json({myStaff:ownStaff?{id:ownStaff.id,name:ownStaff.name,email:ownStaff.login_email}:null,isAdmin,authenticated:!!ownStaff||isAdmin,loginEmail:ownStaff?.login_email || '',isOwner:owner,ownerEmail:owner?ownerEmail:null,mailConfigured:!!(await db.prepare("SELECT key FROM app_settings WHERE key='mail'").first())});
      if(!ownStaff && !isAdmin)return json({error:'メールアドレスとパスワードでログインしてください。'},401);
      if(url.pathname.startsWith('/api/admin/') && !isAdmin)return json({error:'この画面は管理者のみ利用できます。'},403);
      if(url.pathname==='/api/auth/password' && request.method==='POST') {
        if(!ownStaff)return json({error:'メールアドレスでログインしてください。'},403);
        let body;try{body=await readBody(request);}catch{return json({error:'パスワードを確認してください。'},400);}
        if(!validPassword(body.password) || typeof body.currentPassword!=='string' || body.currentPassword.length>128)return json({error:'新しいパスワードは10〜128文字で入力してください。'},400);
        const row=await db.prepare('SELECT password_hash FROM staff WHERE id=?').bind(userId).first();
        if(!await passwordMatches(body.currentPassword,row.password_hash))return json({error:'現在のパスワードが違います。'},403);
        await db.batch([db.prepare('UPDATE staff SET password_hash=? WHERE id=?').bind(await passwordHash(body.password),userId),db.prepare('DELETE FROM sessions WHERE staff_id=?').bind(userId),db.prepare('DELETE FROM password_resets WHERE staff_id=?').bind(userId)]);
        const response=json({updated:true});response.headers.set('Set-Cookie',cookie('',0));return response;
      }
      if(url.pathname==='/api/admin/owner-account' && request.method==='POST') {
        if(!owner)return json({error:'管理者の初期設定はサイト所有者のみ行えます。'},403);
        let body;try{body=await readBody(request);}catch{return json({error:'氏名とパスワードを確認してください。'},400);}
        if(!validName(body.name)||!validPassword(body.password))return json({error:'氏名と10〜128文字のパスワードを入力してください。'},400);
        const existing=await db.prepare('SELECT id FROM staff WHERE login_email=?').bind(ownerEmail).first();
        if(existing){await db.batch([db.prepare('UPDATE staff SET name=?,password_hash=?,is_admin=1 WHERE id=?').bind(body.name.trim(),await passwordHash(body.password),existing.id),db.prepare('DELETE FROM sessions WHERE staff_id=?').bind(existing.id),db.prepare('DELETE FROM password_resets WHERE staff_id=?').bind(existing.id)]);}
        else await db.prepare('INSERT INTO staff (id,name,login_email,password_hash,is_admin) VALUES (?,?,?,?,1)').bind(crypto.randomUUID(),body.name.trim(),ownerEmail,await passwordHash(body.password)).run();
        return json({configured:true,email:ownerEmail});
      }
      if(url.pathname==='/api/admin/mail' && request.method==='GET') {
        if(!owner)return json({error:'メール送信設定はサイト所有者のみ変更できます。'},403);
        const config=await mailSettings(db,env);return json({configured:!!config,from:config?.from || ''});
      }
      if(url.pathname==='/api/admin/mail' && request.method==='POST') {
        if(!owner)return json({error:'メール送信設定はサイト所有者のみ変更できます。'},403);
        let body;try{body=await readBody(request);}catch{return json({error:'メール送信設定を確認してください。'},400);}
        const from=typeof body.from==='string'?body.from.trim():'';
        if(!validEmail(from))return json({error:'送信元メールアドレスを入力してください。'},400);
        const existing=await mailSettings(db,env),apiKey=body.apiKey||existing?.apiKey;
        if(typeof apiKey!=='string'||!/^re_[A-Za-z0-9_-]{10,200}$/.test(apiKey))return json({error:'ResendのAPIキーを入力してください。'},400);
        try{await sendMail({from,apiKey},ownerEmail,'手洗いログ：メール送信の接続確認','<p>パスワード再設定メールを送信できることを確認しました。</p>');}catch{return json({error:'接続確認メールを送信できませんでした。APIキーと送信元ドメインの認証を確認してください。'},400);}
        const value=await seal({from,apiKey},env);await db.prepare("INSERT INTO app_settings (key,value) VALUES ('mail',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(value).run();return json({configured:true});
      }
      if(/^\/api\/admin\/staff\/[0-9a-f-]+\/account$/.test(url.pathname) && request.method==='POST') {
        const id=url.pathname.split('/')[4];if(!uuid.test(id))return json({error:'利用者を確認してください。'},400);
        let body;try{body=await readBody(request);}catch{return json({error:'入力内容を確認してください。'},400);}
        const old=await db.prepare('SELECT id,is_admin,login_email FROM staff WHERE id=?').bind(id).first();if(!old)return json({error:'利用者が見つかりません。'},404);
        if(Object.keys(body).some(key=>!['name','email','password'].includes(key)))return json({error:'管理者権限はこの画面から変更できません。'},403);
        if(old.is_admin && !owner)return json({error:'管理者の情報はサイト所有者のみ変更できます。'},403);
        const name=typeof body.name==='string'?body.name.trim().normalize('NFC'):'';
        const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
        if(!validName(name)||!validEmail(email)||(body.password&&!validPassword(body.password)))return json({error:'氏名・メールアドレス・パスワードを確認してください。'},400);
        if(old.is_admin && email!==old.login_email)return json({error:'管理者のメールアドレスは変更できません。'},403);
        if(await db.prepare('SELECT id FROM staff WHERE login_email=? AND id<>?').bind(email,id).first())return json({error:'このメールアドレスは登録済みです。'},409);
        const updates=[db.prepare('UPDATE staff SET name=?,login_email=? WHERE id=?').bind(name,email,id)];
        if(body.password)updates.push(db.prepare('UPDATE staff SET password_hash=? WHERE id=?').bind(await passwordHash(body.password),id));
        if(body.password || old.login_email!==email)updates.push(db.prepare('DELETE FROM sessions WHERE staff_id=?').bind(id),db.prepare('DELETE FROM password_resets WHERE staff_id=?').bind(id));
        await db.batch(updates);return json({updated:id});
      }
      if(url.pathname==='/api/account' && request.method==='DELETE' || /^\/api\/admin\/staff\/[0-9a-f-]+$/.test(url.pathname) && request.method==='DELETE') {
        const self=url.pathname==='/api/account';const id=self?ownStaff?.id:url.pathname.split('/')[4];if(!id||!uuid.test(id))return json({error:'利用者を確認してください。'},400);
        const person=await db.prepare('SELECT id,is_admin,password_hash FROM staff WHERE id=?').bind(id).first();if(!person)return json({error:'利用者が見つかりません。'},404);
        if(person.is_admin)return json({error:'管理者アカウントは削除できません。'},403);
        if(self){let body;try{body=await readBody(request);}catch{return json({error:'退会にはパスワードが必要です。'},400);}
          if(typeof body.password!=='string'||body.password.length>128||!await passwordMatches(body.password,person.password_hash))return json({error:'パスワードを確認してください。'},403);}
        await removeAccount(db,id);const response=json({deleted:true});if(self)response.headers.set('Set-Cookie',cookie('',0));return response;
      }
      if (url.pathname === '/api/admin/summary' && request.method === 'GET') {
        const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'));
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to - from > 2 * 86400000 || to > Date.now() + 2 * 86400000) return json({ error:'日付を確認してください。' }, 400);
        const { results } = await db.prepare('SELECT s.id, s.name, s.code, s.login_email, s.is_admin, COUNT(w.id) AS count, MAX(w.washed_at) AS latest FROM staff s LEFT JOIN washes w ON w.staff_id = s.id AND w.washed_at >= ? AND w.washed_at < ? GROUP BY s.id ORDER BY s.name, s.code').bind(from, to).all();
        return json({ staff:results, total:results.reduce((sum,row)=>sum+row.count,0), recorded:results.filter(row=>row.count>0).length });
      }
      if (url.pathname === '/api/records' && request.method === 'GET') {
        if(!ownStaff) return json({error:'このアカウントは職員名簿に登録されていません。管理者に登録を依頼してください。'},403);
        const requestedStaff=url.searchParams.get('staff');
        if(requestedStaff && requestedStaff !== ownStaff.id) return json({error:'他の職員の記録は開けません。'},403);
        const staffId=ownStaff.id;
        const from = Number(url.searchParams.get('from'));
        const to = Number(url.searchParams.get('to'));
        if (!url.searchParams.has('from') || !url.searchParams.has('to') || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to - from > 9 * 86400000 || to > Date.now() + 2 * 86400000) {
          return json({ error: '日付の範囲を確認してください。' }, 400);
        }
        const { results } = await db.prepare('SELECT id, washed_at AS at, user_id AS recorder FROM washes WHERE staff_id = ? AND washed_at >= ? AND washed_at < ? ORDER BY washed_at DESC, id DESC').bind(staffId, from, to).all();
        for(const row of results) { row.canDelete = true; delete row.recorder; }
        return json({ records: results, staffId, serverTime: Date.now() });
      }
      if (url.pathname === '/api/records' && request.method === 'POST') {
        if(!ownStaff) return json({error:'このアカウントは職員名簿に登録されていません。管理者に登録を依頼してください。'},403);
        const expectedStaff=request.headers.get('X-Handwash-Profile');
        if(expectedStaff && expectedStaff !== ownStaff.id) return json({error:'ログイン中の職員が変更されました。再読み込みしてから記録してください。'},409);
        if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: '記録の形式を確認してください。' }, 415);
        const bodyText = await request.text();
        if (bodyText.length > 200) return json({ error: '記録の形式を確認してください。' }, 400);
        let body;
        try { body = JSON.parse(bodyText); } catch { return json({ error: '記録の形式を確認してください。' }, 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !uuid.test(body.id ?? '')) return json({ error: '記録の形式を確認してください。' }, 400);
        const at = Date.now();
        await db.batch([
          db.prepare('INSERT INTO washes (id, user_id, staff_id, washed_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM staff WHERE id = ? AND password_hash IS NOT NULL) ON CONFLICT(id) DO NOTHING').bind(body.id,userId,ownStaff.id,at,ownStaff.id),
        ]);
        const record = await db.prepare('SELECT id, washed_at AS at FROM washes WHERE id = ? AND user_id = ? AND staff_id = ?').bind(body.id, userId, ownStaff.id).first();
        if (!record) return json({ error: '記録をもう一度やり直してください。' }, 409);
        return json({ record:{ ...record, canDelete:true }, staffId:ownStaff.id }, 201);
      }
      if (url.pathname.startsWith('/api/records/') && request.method === 'DELETE') {
        if(!ownStaff) return json({error:'本人の記録のみ取り消せます。'},403);
        const id = url.pathname.slice('/api/records/'.length);
        if (!uuid.test(id)) return json({ error: '記録を確認してください。' }, 400);
        const record = await db.prepare('SELECT staff_id FROM washes WHERE id = ?').bind(id).first();
        if (record && record.staff_id !== ownStaff.id) return json({ error:'他の職員の記録は取り消せません。' }, 403);
        const deleted=await db.prepare('DELETE FROM washes WHERE id = ? AND staff_id = ?').bind(id,ownStaff.id).run();
        if(record && deleted.meta?.changes === 0)return json({error:'ログインの設定が変更されました。再読み込みしてください。'},409);
        return json({ deleted: id });
      }
      return json({ error: 'この操作は利用できません。' }, 405);
    } catch (error) {
      console.error('Handwash storage operation failed', error instanceof Error ? error.message : 'Unknown error');
      return json({ error: '記録を保存するサービスに接続できません。少し待って再度お試しください。' }, 503);
    }
  },
};

export default {
  async fetch(request,env) {
    const url=new URL(request.url),origin=request.headers.get('Origin');
    const cross=!!origin && origin!==url.origin;
    if(!url.pathname.startsWith('/api/') || !cross)return app.fetch(request,env);
    if(!env.HANDWASH_ALLOWED_ORIGIN || origin!==env.HANDWASH_ALLOWED_ORIGIN)return json({error:'この接続元からは操作できません。'},403);
    const cors={'Access-Control-Allow-Origin':origin,'Vary':'Origin','Cache-Control':'no-store'};
    if(request.method==='OPTIONS') {
      const method=request.headers.get('Access-Control-Request-Method');
      const headers=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(value=>value.trim()).filter(Boolean);
      if(!['GET','POST','DELETE'].includes(method) || headers.some(value=>!['authorization','content-type','x-handwash-profile'].includes(value)))return new Response(null,{status:403,headers:cors});
      return new Response(null,{status:204,headers:{...cors,'Access-Control-Allow-Methods':'GET, POST, DELETE','Access-Control-Allow-Headers':'Authorization, Content-Type, X-Handwash-Profile','Access-Control-Max-Age':'600'}});
    }
    const headers=new Headers(request.headers);
    headers.delete('Cookie');headers.delete('oai-authenticated-user-id');headers.delete('oai-authenticated-user-email');
    // The validated Pages origin uses bearer sessions, independent of platform cookies.
    // The existing mutation check runs against the Worker origin after this boundary.
    headers.set('Origin',url.origin);headers.delete('Sec-Fetch-Site');
    const forwarded=new Request(request,{headers});
    // Login returns a bearer token only for this explicitly allowed Pages origin.
    const response=await app.fetch(forwarded,{...env,HANDWASH_ALLOWED_ORIGIN:url.origin});
    const result=new Response(response.body,response);result.headers.delete('Set-Cookie');for(const [key,value]of Object.entries(cors))result.headers.set(key,value);return result;
  },
};
