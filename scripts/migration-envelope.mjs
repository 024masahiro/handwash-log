import {createCipheriv,createDecipheriv,createHash,createPublicKey,publicEncrypt,privateDecrypt,randomBytes,constants} from 'node:crypto';

const purpose='handwash-log-legacy-migration-v1';
const limit=32*1024*1024;
const aad=Buffer.from(purpose);
export const sha256=value=>createHash('sha256').update(value).digest('hex');
const invalid=()=>{throw new Error('暗号化した移行データの照合に失敗しました。');};
const encoded=(value,length)=>{
 if(typeof value!=='string'||value.length>limit*2||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))invalid();
 const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value||(length&&bytes.length!==length))invalid();return bytes;
};
export function encryptBackup(backup,publicKey){
 const plain=Buffer.from(JSON.stringify(backup));if(plain.length>limit)invalid();
 const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
 const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
 const canonical=createPublicKey(publicKey).export({type:'spki',format:'pem'}).toString();
 const wrapped=publicEncrypt({key:canonical,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);
 key.fill(0);
 return {version:1,projectId:'handwash-log',purpose,keyFingerprint:sha256(canonical),wrappedKey:wrapped.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
}
export function decryptBackup(envelope,privateKey){
 let key;
 try{
  if(!envelope||envelope.version!==1||envelope.projectId!=='handwash-log'||envelope.purpose!==purpose||Object.keys(envelope).sort().join(',')!==['version','projectId','purpose','keyFingerprint','wrappedKey','iv','tag','ciphertext'].sort().join(','))invalid();
  const canonical=createPublicKey(privateKey).export({type:'spki',format:'pem'}).toString();if(envelope.keyFingerprint!==sha256(canonical))invalid();
  key=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},encoded(envelope.wrappedKey));if(key.length!==32)invalid();
  const decipher=createDecipheriv('aes-256-gcm',key,encoded(envelope.iv,12));decipher.setAAD(aad);decipher.setAuthTag(encoded(envelope.tag,16));
  const ciphertext=encoded(envelope.ciphertext);if(ciphertext.length>limit)invalid();
  return JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8'));
 }catch{invalid();}finally{key?.fill(0);}
}
