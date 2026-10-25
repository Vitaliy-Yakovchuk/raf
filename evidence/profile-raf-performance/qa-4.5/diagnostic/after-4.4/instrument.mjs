import {registerHooks} from 'node:module';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const rows=[];
globalThis.__qaPsDiagnostic=(name,call)=>{const at=performance.now(),start=process.cpuUsage();try{return call();}finally{const cpu=process.cpuUsage(start);rows.push({name,wallMs:performance.now()-at,cpuUserMs:cpu.user/1000,cpuSystemMs:cpu.system/1000});}};
const modules={"state-store.ts":["openStateStore"],"state-migration-guard.ts":["productionStateContext","verifyStateContext"]}, root="/srv/dev/p45-diag-XSTgEr";
registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(context.parentURL?.startsWith('ps-diagnostic:'))return result;if(!result.url.startsWith('file:'))return result;const file=fileURLToPath(result.url);const name=file.slice(file.lastIndexOf('/')+1);return file.startsWith(root+'/')&&file.includes('/src/')&&modules[name]?{url:'ps-diagnostic:'+result.url,shortCircuit:true}:result;},load(url,context,next){if(!url.startsWith('ps-diagnostic:'))return next(url,context);const real=url.slice('ps-diagnostic:'.length),name=real.slice(real.lastIndexOf('/')+1);return {format:'module',shortCircuit:true,source:'export * from '+JSON.stringify(real)+';import * as actual from '+JSON.stringify(real)+';'+modules[name].map(fn=>'export const '+fn+'=(...args)=>globalThis.__qaPsDiagnostic('+JSON.stringify(name+'::'+fn)+',()=>actual.'+fn+'(...args));').join('')};}});
process.once('exit',()=>fs.writeFileSync("/srv/dev/p45-diag-XSTgEr/operations.json",JSON.stringify(rows,null,2)+String.fromCharCode(10)));
