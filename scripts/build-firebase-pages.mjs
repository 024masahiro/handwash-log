import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const config=JSON.parse(process.env.FIREBASE_WEB_CONFIG||await readFile('firebase-web.json','utf8'));
for(const key of ['apiKey','authDomain','projectId','appId'])if(typeof config[key]!=='string'||!config[key]||/YOUR_|REPLACE|PLACEHOLDER/.test(config[key]))throw new Error('Firebase設定が不足しています: '+key);
if(!/^[a-z][a-z0-9-]{4,29}$/.test(config.projectId))throw new Error('Invalid project ID');
if(config.authDomain!==config.projectId+'.firebaseapp.com')throw new Error('Use the project Firebase auth domain');
config.functionsRegion='asia-northeast1';config.pagesOrigin='https://024masahiro.github.io';config.pagesBasePath='/handwash-log';
if(config.emulators&&process.env.HANDWASH_EMULATOR_BUILD!=='1')throw new Error('Emulators cannot be enabled in a production build');
if(process.env.HANDWASH_EMULATOR_BUILD==='1'){config.emulators=true;config.pagesOrigin='http://127.0.0.1:4173';}
const base=config.pagesBasePath;
let page=(await readFile('public/firebase.html','utf8')).replace("const APP_BASE = '';",'const APP_BASE = '+JSON.stringify(base)+';').replace('__FIREBASE_CLIENT_SRC__',base+'/firebase-client.js');
page=page.replace(/href="(\/(?:login|register|forgot|reset|admin|account)?)(?:\/)??"/g,(_,path)=>'href="'+base+(path==='/'?'/':path+'/')+'"');
const script=page.match(/<script id="app-script">([\s\S]*?)<\/script>/)?.[1];if(!script)throw new Error('Missing app script');
const hash=createHash('sha256').update(script).digest('base64');
const connections=['https://identitytoolkit.googleapis.com','https://securetoken.googleapis.com','https://asia-northeast1-'+config.projectId+'.cloudfunctions.net'];
if(config.emulators)connections.push('http://127.0.0.1:9099','http://127.0.0.1:5001');
const policy="default-src 'self'; script-src 'self' 'sha256-"+hash+"'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' "+connections.join(' ')+"; base-uri 'none'; object-src 'none'; form-action 'self'";
page=page.replace('<meta charset="utf-8">','<meta charset="utf-8">\n  <meta name="referrer" content="no-referrer">\n  <meta http-equiv="Content-Security-Policy" content="'+policy+'">');
if(/chatgpt|resend\.com|API_ORIGIN|bearerToken|document\.modelContext/i.test(page))throw new Error('Legacy service dependency in Firebase page');
await rm('pages-dist',{recursive:true,force:true});await mkdir('pages-dist',{recursive:true});
await build({entryPoints:['src/firebase-client.mjs'],outfile:'pages-dist/firebase-client.js',bundle:true,minify:true,format:'iife',target:['es2022'],define:{__FIREBASE_CONFIG__:JSON.stringify(config)}});
for(const route of ['','login','register','forgot','reset','admin','account']){await mkdir('pages-dist/'+route,{recursive:true});await writeFile('pages-dist/'+(route?route+'/':'')+'index.html',page);}
await writeFile('pages-dist/.nojekyll','');console.log('Firebase Pages build ready: '+config.projectId);
