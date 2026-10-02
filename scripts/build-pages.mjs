import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const config=JSON.parse(await readFile('github-pages.json','utf8'));
const origin=new URL(config.api_origin).origin;
if(!origin.startsWith('https://'))throw new Error('The API must use HTTPS');
const base=config.base_path.replace(/\/$/,'');
if(!/^\/[a-zA-Z0-9_-]+$/.test(base)&&base!=='')throw new Error('Invalid Pages base path');
let page=(await readFile('public/index.html','utf8')).replace("const APP_BASE = '';",'const APP_BASE = '+JSON.stringify(base)+';').replace("const API_ORIGIN = '';",'const API_ORIGIN = '+JSON.stringify(origin)+';');
page=page.replace(/href="(\/signin-with-chatgpt\?[^" ]*)"/g,(_,path)=>'href="'+origin+path+'"').replace(/href="(\/(?:login|register|forgot|reset|admin|account)?)(?:\/)??"/g,(_,path)=>'href="'+base+(path==='/'?'/':path+'/')+'"');
const script=page.match(/<script id="app-script">([\s\S]*?)<\/script>/)?.[1];if(!script)throw new Error('Missing app script');
const hash=createHash('sha256').update(script).digest('base64');
const policy="default-src 'self'; script-src 'self' 'sha256-"+hash+"'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' "+origin+"; base-uri 'none'; object-src 'none'; form-action 'self'";
page=page.replace('<meta charset="utf-8">','<meta charset="utf-8">\n  <meta name="referrer" content="no-referrer">\n  <meta http-equiv="Content-Security-Policy" content="'+policy+'">');
await rm('pages-dist',{recursive:true,force:true});
await mkdir('pages-dist',{recursive:true});
for(const route of ['','login','register','forgot','reset','admin','account']){await mkdir('pages-dist/'+route,{recursive:true});await writeFile('pages-dist/'+(route?route+'/':'')+'index.html',page);}
await writeFile('pages-dist/.nojekyll','');
console.log('Built GitHub Pages frontend with '+origin+' and base path '+(base||'/'));
