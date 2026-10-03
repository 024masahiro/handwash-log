import {createHash} from 'node:crypto';
import {importPlan} from './legacy-import-plan.mjs';
export const ownerEmail='024masahiro@gmail.com';
export const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
export function freeMigrationPlan(backup,project){
 if(!/^[a-z][a-z0-9-]{4,29}$/.test(project))throw new Error('FirebaseのプロジェクトIDを確認してください。');
 const plan=importPlan(backup,ownerEmail);
 const lines=[`INSERT INTO migration_state(key,digest,state) VALUES('legacy',${quote(plan.digest)},'importing') ON CONFLICT(key) DO NOTHING;`];
 for(const row of plan.profiles){const d=row.data;lines.push(`INSERT INTO staff(id,name,email,is_admin,is_owner,deleting,created_at) VALUES(${quote(row.uid)},${quote(d.name)},${quote(d.email)},${Number(d.isAdmin)},${Number(d.isOwner)},0,${d.createdAt}) ON CONFLICT(id) DO NOTHING;`);}
 for(const row of plan.washes)lines.push(`INSERT INTO washes(id,staff_id,washed_at) VALUES(${quote(row.id)},${quote(row.uid)},${row.at}) ON CONFLICT(id) DO NOTHING;`);
 const sql=lines.join('\n')+'\n',sqlDigest=createHash('sha256').update(sql).digest('hex');
 return {...plan,sql,manifest:{version:1,project,digest:plan.digest,sqlDigest,summary:plan.summary}};
}
export function sameProfiles(actual,plan){
 const expected=plan.profiles.map(({uid,data:d})=>({id:uid,name:d.name,email:d.email,is_admin:Number(d.isAdmin),is_owner:Number(d.isOwner),deleting:0,created_at:d.createdAt}));
 return sameRows(actual,expected,'id');
}
export const sameWashes=(actual,plan)=>sameRows(actual,plan.washes.map(row=>({id:row.id,staff_id:row.uid,washed_at:row.at})),'id');
function sameRows(actual,expected,key){
 if(actual.length!==expected.length)return false;
 const rows=new Map(actual.map(row=>[row[key],row]));
 return rows.size===expected.length&&expected.every(row=>{const found=rows.get(row[key]);return found&&Object.entries(row).every(([k,v])=>found[k]===v);});
}
