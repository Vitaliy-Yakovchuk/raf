from pathlib import Path
import subprocess,sys
revision=sys.argv[1] if len(sys.argv)>1 else None
source=subprocess.check_output(['git','show',revision+':src/production-runtime.ts'],text=True) if revision else Path('src/production-runtime.ts').read_text()
source=source.replace("from './", "from '/srv/dev/work/orchestrator/raf-hotfix/src/").replace("import('./", "import('/srv/dev/work/orchestrator/raf-hotfix/src/")
source="import {appendFileSync as profileAppend} from 'node:fs';\nasync function profileSpan(name,action){const start=performance.now();try{return await action();}finally{profileAppend(process.env.PROFILE_TIMELINE,JSON.stringify({name,start,ms:performance.now()-start})+'\\n');}}\n"+source
for call in ['settleWorkerHealth()', 'settleRuntimeHealthCpu(store, context.orchestratorRoot)', 'probeRunnerAvailability(settings, { env: process.env, execute })', 'handoffTaskReservations(dependencies, { lease, wrapper: await ownIdentity(execute, request.runId, request.tmuxSession) })']:
 if 'await ' in call:continue
 source=source.replace('await '+call, "await profileSpan("+repr(call.split('(')[0])+",()=>"+call+")")
source=source.replace("return executeCommand({ ...command, environment });", "return profileSpan(command.executable+' '+command.args.slice(0,3).join(' '),()=>executeCommand({ ...command, environment }));")
source=source.replace("const result = await executeCommand({ ...command, args: ['-u', '-S', socketPath, ...prefix, ...args], environment });", "const result = await profileSpan(command.executable+' '+command.args.slice(0,3).join(' '),()=>executeCommand({ ...command, args: ['-u', '-S', socketPath, ...prefix, ...args], environment }));")
source=source.replace("let result = await executeCommand({ ...command, environment, args: ['-S', socketPath, ...prefix, ...args] });", "let result = await profileSpan(command.executable+' '+command.args.slice(0,3).join(' '),()=>executeCommand({ ...command, environment, args: ['-S', socketPath, ...prefix, ...args] }));")
source=source.replace("await new Promise(resolve => setTimeout(resolve, settings.timeouts.pollMs));","await profileSpan('poll-wait',()=>new Promise(resolve => setTimeout(resolve, settings.timeouts.pollMs)));")
Path('/tmp/frcll-1-1-6/src').mkdir(exist_ok=True)
Path('/tmp/frcll-1-1-6/src/production-runtime.ts').write_text(source)
