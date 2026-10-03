import assert from 'node:assert/strict';
import {generateKeyPairSync,createPublicKey} from 'node:crypto';
import {credentials,prepareBackend,workerConfiguration} from './setup-free-backend.mjs';
const pair=generateKeyPairSync('rsa',{modulusLength:2048}),privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString();
const accountId='a'.repeat(32),databaseId='12345678-1234-1234-1234-123456789abc',token='test-cloudflare-token',serviceAccount={project_id:'handwash-log',client_email:'fixture@handwash-log.iam.gserviceaccount.com',private_key:privateKey};
const input={accountId,token,serviceAccountJson:JSON.stringify(serviceAccount)};
const errors=[];for(const value of [{...input,token:''},{...input,accountId:'invalid'},{...input,serviceAccountJson:'invalid'},{...input,serviceAccountJson:JSON.stringify({...serviceAccount,project_id:'wrong-project'})}]){try{credentials(value);}catch(error){errors.push(error.message);}}
assert.equal(errors.length,4);assert(errors.every(error=>!error.includes(privateKey)&&!error.includes(token)));
const calls=[],reply=(result,status=200)=>Response.json({success:status===200,result},{status});
const fetcher=async(url,options={})=>{calls.push({url,options});if(url.startsWith('https://api.cloudflare.com/'))assert.equal(options.headers.Authorization,'Bearer '+token);
 if(url.endsWith('/workers/scripts/handwash-api/settings'))return reply(null,404);
 if(url.endsWith('/workers/subdomain'))return options.method==='PUT'?reply({subdomain:JSON.parse(options.body).subdomain}):reply(null,404);
 if(url.includes('/d1/database?'))return reply([]);
 if(url.endsWith('/d1/database')){assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{name:'handwash-log'});return reply({uuid:databaseId,name:'handwash-log'});}
 throw new Error('Unexpected API request');};
const prepared=await prepareBackend(input,{fetcher});assert.equal(prepared.apiOrigin,'https://handwash-api.handwash-024masahiro-aaaaaaaa.workers.dev');assert.equal(prepared.databaseId,databaseId);assert.equal(createPublicKey(prepared.publicKey).asymmetricKeyType,'rsa');assert(!prepared.publicKey.includes('PRIVATE KEY'));
const template={name:'handwash-api',main:'index.mjs',vars:{},d1_databases:[{binding:'DB',migrations_dir:'migrations',database_id:'placeholder'}]};
const config=workerConfiguration(template,prepared);assert.equal(config.vars.HANDWASH_MIGRATION_LOCK,'1');assert.equal(config.vars.FIREBASE_PROJECT_ID,'handwash-log');assert.equal(config.d1_databases[0].database_id,databaseId);assert(!JSON.stringify(config).includes(privateKey));assert(!JSON.stringify(config).includes(token));
const bindings=[{type:'plain_text',name:'FIREBASE_PROJECT_ID',text:'handwash-log'},{type:'d1',name:'DB',id:databaseId}],existingFetch=async(url,options={})=>{if(url.endsWith('/settings'))return reply({bindings});if(url.endsWith('/workers/subdomain'))return reply({subdomain:'existing'});if(url.startsWith('https://handwash-api.'))return Response.json({service:'handwash-free',ready:false});if(url.includes('/d1/database?'))return reply([{uuid:databaseId,name:'handwash-log'}]);throw new Error('Must not create a duplicate DB');};
const existing=await prepareBackend(input,{fetcher:existingFetch});assert.equal(existing.databaseId,databaseId);
await assert.rejects(()=>prepareBackend(input,{fetcher:async(url,options)=>url.startsWith('https://handwash-api.')?Response.json({service:'handwash-free',ready:true}):existingFetch(url,options)}),/運用中/);
await assert.rejects(()=>prepareBackend(input,{fetcher:async(url,options)=>url.endsWith('/settings')?reply({bindings:[]}):existingFetch(url,options)}),/同名のWorker/);
await assert.rejects(()=>prepareBackend(input,{fetcher:async()=>Response.json({success:false,errors:[{code:10000}]},{status:403})}),/編集権限/);
console.log('Backend setup checks passed: credential/project validation, least data in public output, free subdomain and D1 creation, DB reuse, forced migration lock, foreign Worker protection and refusal to relock a live Worker.');
