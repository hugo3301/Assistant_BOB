import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {BACKUP_LIMIT} from '../src/backup.mjs';

const base='https://assistant-bob-alpha.assistant-bob.workers.dev',directory=resolve('work/backups');
const [command,...args]=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const validOwner=owner=>/^[1-9]\d{0,19}$/.test(owner??'');
function key(){if(!/^[a-f0-9]{64}$/.test(process.env.BACKUP_ENCRYPTION_KEY??''))throw Error('Set local BACKUP_ENCRYPTION_KEY first (init-key).');return Buffer.from(process.env.BACKUP_ENCRYPTION_KEY,'hex');}
export function encryptBackup(backup,secret){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,iv);cipher.setAAD(Buffer.from('BOB personal backup v1'));const body=Buffer.concat([cipher.update(JSON.stringify(backup)),cipher.final()]);return JSON.stringify({format:'bob-encrypted-backup',version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),body:body.toString('base64')});}
export function decryptBackup(text,secret){if(Buffer.byteLength(text)>BACKUP_LIMIT*2)throw Error('Backup too large');const box=JSON.parse(text);if(box.format!=='bob-encrypted-backup'||box.version!==1)throw Error('Unsupported backup');const decipher=createDecipheriv('aes-256-gcm',secret,Buffer.from(box.iv,'base64'));decipher.setAAD(Buffer.from('BOB personal backup v1'));decipher.setAuthTag(Buffer.from(box.tag,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.body,'base64')),decipher.final()]).toString());}
async function api(path,body){if(!process.env.ADMIN_SECRET)throw Error('ADMIN_SECRET missing');const r=await fetch(base+path,{redirect:'error',signal:AbortSignal.timeout(60000),headers:{Authorization:'Bearer '+process.env.ADMIN_SECRET,'Content-Type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});const reader=r.body.getReader(),parts=[];let size=0;while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>BACKUP_LIMIT){await reader.cancel();throw Error('Response too large');}parts.push(value);}if(!r.ok)throw Error('Server rejected operation (HTTP '+r.status+'); no response contents logged');return JSON.parse(Buffer.concat(parts).toString());}
async function main(){
 if(command==='init-key'){if(process.env.BACKUP_ENCRYPTION_KEY)throw Error('Backup key already configured; do not replace it');const env=await readFile('.env','utf8');if(/^BACKUP_ENCRYPTION_KEY=.+/m.test(env))throw Error('Backup key already exists');const line='BACKUP_ENCRYPTION_KEY='+randomBytes(32).toString('hex');if(/^BACKUP_ENCRYPTION_KEY=$/m.test(env))await writeFile('.env',env.replace(/^BACKUP_ENCRYPTION_KEY=$/m,line));else await appendFile('.env','\n'+line+'\n');console.log('Local encryption key created in excluded .env; value hidden.');return;}
 if(command==='create'){
  const secret=key(),owner=option('--owner');if(!args.includes('--all')&&!validOwner(owner))throw Error('Supply --all or --owner ID');
  const owners=args.includes('--all')?(await api('/admin/registry')).members.filter(m=>m.active).map(m=>String(m.id)):[owner];
  await mkdir(directory,{recursive:true});let count=0;
  for(const id of owners){if(!validOwner(id))throw Error('Invalid registry owner');const backup=await api('/admin/backups/snapshot?owner='+id);if(backup.owner!==id||backup.format!=='bob-personal-backup')throw Error('Snapshot owner mismatch');const encrypted=encryptBackup(backup,secret);if(JSON.stringify(decryptBackup(encrypted,secret))!==JSON.stringify(backup))throw Error('Encryption verification failed');await writeFile(resolve(directory,Date.now()+'-'+id+'.bobbackup'),encrypted,{flag:'wx',mode:0o600});count++;}
  console.log(JSON.stringify({encryptedCopies:count,directory,automatic:false}));return;
 }
 if(['inspect','restore'].includes(command)){
  const file=option('--file');if(!file)throw Error('Supply --file');const backup=decryptBackup(await readFile(resolve(file),'utf8'),key());
  if(command==='inspect'){console.log(JSON.stringify({format:backup.format,version:backup.version,createdAt:backup.createdAt,items:backup.data?.items?.length,projects:backup.data?.projects?.length,series:backup.data?.weekly_series?.length}));return;}
  const owner=option('--owner');if(!validOwner(owner)||backup.owner!==owner||option('--confirm')!=='restore-empty:'+owner)throw Error('Supply matching --owner and --confirm restore-empty:ID');
  console.log(JSON.stringify(await api('/admin/backups/restore?owner='+owner,{backup,confirm:'restore-empty:'+owner})));return;
 }
 if(command==='resume'){const owner=option('--owner');if(!validOwner(owner)||option('--confirm')!=='resume:'+owner)throw Error('Supply --owner and --confirm resume:ID');console.log(JSON.stringify(await api('/admin/backups/resume?owner='+owner,{confirm:'resume:'+owner})));return;}
 throw Error('Commands: init-key, create --all|--owner ID, inspect --file PATH, restore --file PATH --owner ID --confirm restore-empty:ID, resume --owner ID --confirm resume:ID');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Backup operation failed. Check configuration, command and recovery instructions. No contents or credentials logged.');process.exitCode=1;});
