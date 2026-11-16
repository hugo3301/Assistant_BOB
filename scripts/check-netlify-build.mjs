import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

export function verifyNetlifyRuntime(manifest){
 assert.equal(manifest.functions?.length,1,'Expected only the GigaChat bridge');
 const fn=manifest.functions[0];
 assert.equal(fn.name,'gigachat');assert.equal(fn.runtime,'js');
 assert.equal(fn.buildData?.runtimeAPIVersion,2,'Legacy Lambda runtime must not be published');
 assert.equal(fn.runtimeVersion,'nodejs24.x');assert.equal(fn.routes?.length,1);
 assert.equal(fn.routes[0].pattern,'/api/gigachat');assert.equal(fn.routes[0].literal,'/api/gigachat');
 return {runtimeAPIVersion:2,node:'24',nativeRoute:'/api/gigachat'};
}
async function main(){
 const [releaseDir,manifestPath]=process.argv.slice(2);if(!releaseDir||!manifestPath)throw Error('Supply release directory and Netlify build manifest');
 const release=JSON.parse(await readFile(resolve(releaseDir,'release.json'),'utf8'));
 assert.equal(release.platform,'netlify');assert.equal(release.runtimeAPIVersion,2);assert.equal(release.files.length,12);
 for(const entry of release.files){assert.ok(/^(?:src\/[a-z-]+\.mjs|functions\/gigachat\.mjs|public\/index\.html|package\.json|netlify\.toml)$/.test(entry.path));const bytes=await readFile(resolve(releaseDir,entry.path));assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);}
 const result=verifyNetlifyRuntime(JSON.parse(await readFile(resolve(manifestPath),'utf8')));
 console.log(JSON.stringify({...result,releaseHashes:'passed',files:12,productionPublished:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Netlify build validation failed; do not publish this artifact.');process.exitCode=1;});
