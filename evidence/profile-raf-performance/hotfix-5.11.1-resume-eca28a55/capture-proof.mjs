import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const runRoot='/home/dev/.raf/tmp/eca28a55-f0f5-4510-a03b-a8cd7d124b74';
const root=runRoot+'/'+(await fs.readdir(runRoot)).find(name=>name.startsWith('codex-raf-results-'));
const destination=process.argv[2];
const deadline=Date.now()+1800000;
const initialEntries=new Set(await fs.readdir(root));
let handles, source;
try {
  while(Date.now()<deadline) {
    if(!handles) {
      const entries=await fs.readdir(root);
      const name=entries.find(name=>!initialEntries.has(name) && /^(capture|ready|replay)-/.test(name));
      if(name) {
        source=root+'/'+name;
        const opened=[];
        try { for(const name of ['stdout','stderr','result.json']) opened.push(await fs.open(source+'/'+name,'r')); handles=opened; }
        catch(error) { for(const file of opened) await file.close(); if(error.code!=='ENOENT') throw error; }
      }
    }
    if(handles) {
      const read=async file=>{const size=(await file.stat()).size;const bytes=Buffer.alloc(size);await file.read(bytes,0,size,0);return bytes;};
      const manifest=await read(handles[2]);
      if(manifest.length) {
        let metadata;
        try { metadata=JSON.parse(manifest); } catch {}
        if(metadata) {
          const [stdout,stderr]=await Promise.all(handles.slice(0,2).map(read));
          if(stdout.length!==metadata.stdoutBytes || stderr.length!==metadata.stderrBytes) throw new Error('Capture length mismatch');
          const result=JSON.parse(stdout);
          if(result.project!=='raf'||result.phase!=='hotfix'||result.group!==process.argv[3]) throw new Error('Capture context mismatch');
          await fs.mkdir(destination,{recursive:true});
          await Promise.all([fs.writeFile(destination+'/stdout.json',stdout),fs.writeFile(destination+'/stderr.txt',stderr),fs.writeFile(destination+'/capture-result.json',manifest)]);
          const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
          await fs.writeFile(destination+'/delivery.json',JSON.stringify({source,method:'Read-only file descriptors opened during own command; read complete streams after capture manifest publication; no capture writes or hard links.',cliCode:metadata.code,stdoutBytes:stdout.length,stdoutSha256:digest(stdout),stderrBytes:stderr.length,stderrSha256:digest(stderr),captureResultSha256:digest(manifest),runId:result.runId,project:result.project,phase:result.phase,group:result.group,selection:result.selection,context:result.context,limitation:'Installed capture manifest has lengths/code only and is removed after replay; this attestation records independently computed hashes and parsed context.'},null,2)+'\n');
          console.log(JSON.stringify({copied:true,runId:result.runId,cliCode:metadata.code,childCode:result.exitCode,outcome:result.outcome,stdoutBytes:stdout.length,stderrBytes:stderr.length}));
          process.exitCode=0; break;
        }
      }
    }
    await new Promise(resolve=>setTimeout(resolve,handles ? 100 : 5));
  }
  if(!process.exitCode && !await fs.stat(destination+'/delivery.json').catch(()=>null)) throw new Error('No complete own capture before deadline');
} finally { if(handles) for(const file of handles) await file.close(); }
