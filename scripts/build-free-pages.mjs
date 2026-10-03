import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
async function readConfig(){
 if(process.env.FIREBASE_WEB_CONFIG)return JSON.parse(process.env.FIREBASE_WEB_CONFIG);
 try{return JSON.parse(await readFile('firebase-web.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 return JSON.parse(await readFile('firebase-web.public.json','utf8'));
}
const config=await readConfig();
for(const key of ['apiKey','authDomain','projectId','appId'])if(typeof config[key]!=='string'||!config[key]||/YOUR_|REPLACE|PLACEHOLDER/.test(config[key]))throw new Error('Firebase設定が不足しています: '+key);
if(!/^[a-z][a-z0-9-]{4,29}$/.test(config.projectId))throw new Error('Invalid project ID');
if(config.authDomain!==config.projectId+'.firebaseapp.com')throw new Error('Use the project Firebase auth domain');
config.pagesOrigin='https://024masahiro.github.io';config.pagesBasePath='/handwash-log';
if(config.emulators&&process.env.HANDWASH_EMULATOR_BUILD!=='1')throw new Error('Emulators cannot be enabled in a production build');
config.apiOrigin=process.env.HANDWASH_API_ORIGIN||config.apiOrigin;
if(process.env.HANDWASH_EMULATOR_BUILD==='1'){config.emulators=true;config.pagesOrigin='http://127.0.0.1:4173';config.apiOrigin='http://127.0.0.1:4321';}
if(typeof config.apiOrigin!=='string')throw new Error('Cloudflare API設定が不足しています。');
const api=new URL(config.apiOrigin);if(config.emulators){if(api.origin!=='http://127.0.0.1:4321')throw new Error('Invalid test API origin');}else if(api.protocol!=='https:'||!api.hostname.endsWith('.workers.dev')||api.pathname!=='/'||api.search||api.hash||api.username||api.password)throw new Error('Cloudflare WorkersのHTTPS URLを指定してください。');
config.apiOrigin=api.origin;
const base=config.pagesBasePath;
let page=(await readFile('public/free.html','utf8')).replace("const APP_BASE = '';",'const APP_BASE = '+JSON.stringify(base)+';').replace('__FIREBASE_CLIENT_SRC__',base+'/firebase-client.js');
page=page.replace(/href="(\/(?:login|register|forgot|reset|admin|account|ranking)?)(?:\/)??"/g,(_,path)=>'href="'+base+(path==='/'?'/':path+'/')+'"');
const script=page.match(/<script id="app-script">([\s\S]*?)<\/script>/)?.[1];if(!script)throw new Error('Missing app script');
const hash=createHash('sha256').update(script).digest('base64');
const connections=['https://identitytoolkit.googleapis.com','https://securetoken.googleapis.com',config.apiOrigin];if(config.emulators)connections.push('http://127.0.0.1:9099');
const policy="default-src 'self'; script-src 'self' 'sha256-"+hash+"'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' "+connections.join(' ')+"; base-uri 'none'; object-src 'none'; form-action 'self'";
page=page.replace('<meta charset="utf-8">','<meta charset="utf-8">\n  <meta name="referrer" content="no-referrer">\n  <meta http-equiv="Content-Security-Policy" content="'+policy+'">');
if(/chatgpt|resend\.com|API_ORIGIN|bearerToken|document\.modelContext/i.test(page))throw new Error('Legacy service dependency in free page');
await rm('pages-dist',{recursive:true,force:true});await mkdir('pages-dist',{recursive:true});
await build({entryPoints:['src/free-client.mjs'],outfile:'pages-dist/firebase-client.js',bundle:true,minify:true,format:'iife',target:['es2022'],define:{__FIREBASE_CONFIG__:JSON.stringify(config)}});
for(const route of ['','login','register','forgot','reset','admin','account','ranking']){await mkdir('pages-dist/'+route,{recursive:true});await writeFile('pages-dist/'+(route?route+'/':'')+'index.html',page);}
await writeFile('pages-dist/.nojekyll','');console.log('Free-plan Pages build ready: '+config.projectId);
