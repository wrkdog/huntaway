import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { Store, type NewRequest } from '../src/store.ts';
import { AllowanceLedger } from '../src/allowance.ts';
import { availability, IdentityLedger } from '../src/availability.ts';
import { run } from '../src/runner.ts';
import { saveWorktree, TempRetryQueue } from '../src/disk.ts';
import { persistCompletedOutcome, classifyAndMarkOfflineOutcome } from '../src/service.ts';
import { eventClock } from '../src/event-clock.ts';
const epoch = new Date('2026-10-03T12:00:00Z');
const policy = {codex:{models:{'gpt-6.1-sol':'default' as const},efforts:['high']},claude:{models:{opus:'default' as const},efforts:['high']}};
const req = (cwd:string, mutating=false):NewRequest => ({requester:'fixture',project:'fixture',kind:'code',provider:'codex',model:'gpt-6.1-sol',effort:'high',reason:'primary',prompt:'inert',mutating,priority:'interactive',cwd,placement:'ordinary_headroom',automatic:{fallback:{provider:'claude',model:'opus',effort:'high',reason:'fallback'},reviewReserve:.1}});
function fixture(t:any) {
 const root=mkdtempSync(join(tmpdir(),'round2-'));let time=epoch;
 const store=new Store(join(root,'record.sqlite'),{now:()=>time,evidenceMaxAgeMs:60_000,retryBackoffMs:0});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const account=(id:string)=>({id,provider:id==='c'?'codex' as const:'claude' as const,enabled:true,maxConcurrency:1,loginDir:root,fingerprint:'fixture'});
 const room=(id:string)=>({account:account(id),running:0,evidence:(model:string)=>({accountId:id,model,observedAt:time.toISOString(),allowanceObservedAt:time.toISOString(),verdict:{state:'available' as const,headroom:.8}})});
 const claim=(id:string,accounts=[room('c')])=>store.startAutomatic(id,accounts,policy,[]);
 return {root,store,account,room,claim,setTime:(v:Date)=>{time=v;},now:()=>time};
}
for(const via of [true,false]) for(const change of ['valid','reset','stale','foreign','missing','malformed'] as const) test(`R2 certificate ${via?'credits':'exhausted'} ${change}`,t=>{
 const f=fixture(t);if(change==='stale')f.setTime(new Date(+epoch-30_000));const ledger=new AllowanceLedger({now:f.now,freshnessMs:60_000}),identities=new IdentityLedger({now:f.now});
 identities.record('c',{signedIn:true,fingerprint:'fixture'});
 ledger.record('c',[{bucket:'week',model:null,usedFraction:via?.95:1,resetsAt:'2026-10-03T12:00:01Z',...(via?{via:'credits' as const}:{})}]);
 f.setTime(epoch);const c=f.room('c');let reads=0;
 c.evidence=((model:string)=>{
  const evidence={accountId:'c',model,observedAt:f.now().toISOString(),allowanceObservedAt:ledger.observedAt('c',model),ordinaryExhaustion:ledger.ordinaryExhaustion('c',model),verdict:availability({account:c.account,identities,allowances:ledger,model,running:0,now:f.now(),identityMaxAgeMs:60_000})};
  // Advance after every final read has obtained its real certificate, before Store's final claim clock.
  if(++reads===2){if(change==='reset'||change==='stale')f.setTime(new Date(+epoch+(change==='reset'?2000:31000)));if(change==='foreign')evidence.accountId='foreign';if(change==='missing')evidence.ordinaryExhaustion=null;if(change==='malformed')evidence.ordinaryExhaustion={observedAt:epoch.toISOString(),until:'bad'};}
  return evidence;
 }) as any;
 const r=f.store.submit(req(f.root)), result=f.claim(r.id,[c,f.room('f')]);
 assert.equal(result.ok,change==='valid');assert.equal(f.store.get(r.id)!.id,r.id);
 if(result.ok){assert.equal(result.attempt.accountId,'f');assert.equal(result.attempt.dispatch.verdict.state,'available');}
 else {assert.equal(f.store.attempts(r.id).length,0);assert.equal(f.store.get(r.id)!.error?.kind,'admission_unknown');}
 if(change==='reset')assert.equal(ledger.view('c','gpt-6.1-sol').state,'unknown');
});
for(const mutating of [false,true]) for(const kind of ['auth','transient'] as const) for(const proof of [false,true]) test(`R2 retry admission ${mutating?'write':'read'} ${kind} proof=${proof}`,t=>{
 const f=fixture(t),r=f.store.submit(req(f.root,mutating)),a=f.claim(r.id);assert.ok(a.ok);
 f.store.noteMayStart(a.attempt.id);f.store.finishAttempt(a.attempt.id,{kind:'failed',errorKind:kind,message:'fixture',...(proof?{untouched:true}:{})});
 const b=f.claim(r.id),safe=proof&&(!mutating||kind==='auth');assert.equal(b.ok,safe);
 if(b.ok){assert.equal(f.store.requestStatus(r.id)!.attempts[0]!.retrySafe,true);assert.equal(f.store.cancel(r.id,'Stop','fixture'),true);f.store.finishAttempt(b.attempt.id,{kind:'cancelled'});assert.equal(f.store.get(r.id)!.state,'cancelled');}
 else assert.equal(f.store.attempts(r.id).length,1);
});
for(const changed of ['first','middle','open','overlap'] as const) test(`R2 unsafe persisted history ${changed} refuses before another execution`,t=>{
 const f=fixture(t),r=f.store.submit(req(f.root)),a=f.claim(r.id);assert.ok(a.ok);
 f.store.finishAttempt(a.attempt.id,{kind:'failed',errorKind:'auth',message:'pre-tool',untouched:true});const b=f.claim(r.id);assert.ok(b.ok);
 f.store.noteMayStart(b.attempt.id);f.store.finishAttempt(b.attempt.id,{kind:'failed',errorKind:'transient',message:'pre-tool',untouched:true});
 const db=new DatabaseSync(join(f.root,'record.sqlite'));try{if(changed==='open')db.prepare('UPDATE attempts SET ended_at=NULL, outcome=NULL WHERE id=?').run(b.attempt.id);else if(changed==='overlap')db.prepare('UPDATE attempts SET started_at=? WHERE id=?').run(new Date(+epoch-1).toISOString(),b.attempt.id);else db.prepare('UPDATE attempts SET outcome=? WHERE id=?').run(JSON.stringify({kind:'failed',errorKind:'auth',message:'after tool'}),changed==='first'?a.attempt.id:b.attempt.id);}finally{db.close();}
 assert.equal(f.claim(r.id).ok,false);assert.equal(f.store.attempts(r.id).length,2);
});
for(const mutating of [false,true]) for(const kind of ['auth','transient'] as const) for(const tool of [false,true]) test(`R2 native proof ${mutating?'write':'read'} ${kind} tool=${tool}`,async t=>{
 const f=fixture(t),repo=join(f.root,'repo'),cli=join(f.root,'fake.cjs');mkdirSync(repo);
 const env={PATH:process.env.PATH,HOME:f.root,TMPDIR:f.root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'f@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'f@example.invalid'};
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{env,stdio:'pipe'});git('init','-q');git('commit','--allow-empty','-qm','seed');
 const rows=[{type:'system',subtype:'init',model:'opus',session_id:'fixture'},...(tool?[{type:'assistant',message:{content:[{type:'tool_use',name:'Read',id:'fixture',input:{}}]}}]:[]),{type:'result',subtype:'error',is_error:true,errors:[kind==='auth'?'401 unauthorized':'connection reset']}];
 writeFileSync(cli,`#!${process.execPath}\nrequire('node:fs').readFileSync(0);for(const row of ${JSON.stringify(rows)})console.log(JSON.stringify(row));process.exitCode=1;\n`);chmodSync(cli,0o755);
 let end:any,closed=false;for await(const e of run({requestId:'fixture',accountId:'f',provider:'claude',model:'opus',effort:'high',prompt:'inert',mutating,cwd:repo,loginDir:f.root},{cli:{claude:cli},env,worktreeRoot:join(f.root,'trees'),reachable:async()=>true,onClosed:()=>{closed=true;}}))if(e.type==='failed')end=e;
 assert.ok(closed);assert.equal(end.errorKind,kind==='transient'?'offline':kind);if(kind==='transient')assert.equal(await classifyAndMarkOfflineOutcome(new Map(),'f','claude',async()=>true),'transient');assert.equal(end.untouched===true,!tool&&(!mutating||kind==='auth'));if(mutating&&(tool||kind==='transient'))assert.ok(end.workspace);
});
// Execute the unchanged production closure with inert native events; disk/git/store/persistence are real.
// This controls the native-outcome/cleanup ordering without a live provider or a timing guess.
for(const ordering of ['completion-first','guard-first','late-stop','service-save','service-before-save','service-already-aborted','stop-after-record'] as const) test(`R2 completion save scope ${ordering}`,async t=>{
 const f=fixture(t),repo=join(f.root,'repo'),trees=join(f.root,'trees');mkdirSync(repo);mkdirSync(trees);
 const env={PATH:process.env.PATH,HOME:f.root,TMPDIR:f.root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'f@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'f@example.invalid'};
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{env,encoding:'utf8',stdio:'pipe'}).trim();git('init','-q');git('commit','--allow-empty','-qm','seed');const seed=git('rev-parse','HEAD');
 const r=f.store.submit(req(repo,true)),c=f.room('c');c.evidence=((model:string)=>({accountId:'c',model,observedAt:epoch.toISOString(),allowanceObservedAt:epoch.toISOString(),ordinaryExhaustion:{observedAt:epoch.toISOString(),until:null},verdict:{state:'unavailable',cause:'allowance',reason:'full',until:null}})) as any;
 const a=f.claim(r.id,[c,f.room('f')]);assert.ok(a.ok);const w={path:join(trees,r.id),branch:`pipe/${r.id}`};git('worktree','add','-b',w.branch,w.path,seed);writeFileSync(join(w.path,'partial.txt'),'owned work');
 const jobs=new Map<string,any>(),logs:any[]=[],state={stopped:false},pending=new Map();let floor=false,saveCalled=false,drained=false;
 const source=readFileSync(new URL('../src/service.ts',import.meta.url),'utf8');
 const stop=()=>{state.stopped=true;new Function('jobs',source.slice(source.indexOf('          for (const job of jobs.values())'),source.indexOf('          await stopGemini(store);')))(jobs);};
 const code=stripTypeScriptTypes(source.slice(source.indexOf('  const execute ='),source.indexOf('\n  const admitAutomatic =')),{mode:'strip'});
 const scope:any={store:f.store,jobs,config:{worktreeRoot:trees,env,storePath:join(f.root,'record.sqlite')},cli:{},workDir:repo,tmpRoot:f.root,verdict:()=>({state:'available',headroom:floor?.05:.8}),allowances:{observedAt:()=>epoch.toISOString()},eventClock,join,attemptTemp:()=>f.root,modelFamily:()=> 'opus',cancelledByRequester:()=>f.store.get(r.id)!.state==='cancelled',pending,journal:{},log:(...v:any[])=>logs.push(v.map(x=>x instanceof Error?x.message:x)),journaledOutcomes:new Set(),pendingHolds:new Set(),persistCompletedOutcome,runnerGroupGone:()=>true,cleanTemp:()=>{},pendingTemps:new TempRetryQueue(),checkDrained:()=>{drained=jobs.size===0;},afterPrunes:async(fn:any)=>{if(ordering==='service-before-save')stop();if(ordering==='service-already-aborted')jobs.get(r.id).saveAbort?.abort();if(ordering==='stop-after-record')assert.equal(f.store.cancel(r.id,'late Stop','fixture'),false);await fn();},stoppedOutcome:(o:any)=>o,
 run:async function*(_spec:any,options:any){options.onWorkspace(w,seed);yield {type:'started',reportedModel:'opus'};if(ordering==='guard-first'){floor=true;jobs.get(r.id).guard();assert.equal(options.signal.aborted,true);yield {type:'failed',errorKind:'cancelled',message:'guard won',workspace:w};}else{yield {type:'completed',result:'OK',workspace:w};if(ordering==='completion-first'||ordering==='late-stop'){floor=true;jobs.get(r.id).guard();assert.equal(options.signal.aborted,true);}if(ordering==='late-stop'){f.store.cancel(r.id,'late Stop','fixture');jobs.get(r.id).abort.abort();}}options.onClosed();},
 saveWorktree:async(...args:Parameters<typeof saveWorktree>)=>{saveCalled=true;if(ordering==='service-save'){queueMicrotask(stop);}return saveWorktree(...args);}};
 Object.defineProperty(scope,'stopped',{get:()=>state.stopped});
 new Function('scope',`with(scope){${code};execute(${JSON.stringify(r.id)},scope.account,${JSON.stringify(a.attempt.id)},scope.route,scope.automatic);}`)({...scope, get stopped(){return state.stopped;},account:f.account('f'),route:a.attempt.dispatch.route,automatic:r.automatic});
 await jobs.get(r.id).done;
 const final=f.store.get(r.id)!;assert.equal(drained,true);assert.equal(final.id,r.id);assert.equal(readFileSync(join(w.path,'partial.txt'),'utf8'),'owned work');
 if(ordering==='completion-first'||ordering==='stop-after-record'){assert.equal(final.state,'completed');assert.equal(final.workspace?.saved,'saved',JSON.stringify(logs));assert.notEqual(final.workspace?.commit,seed);}
 if(ordering==='guard-first'){assert.equal(final.state,'failed');assert.match(final.error!.message,/review reserve/);assert.equal(saveCalled,false);}
 if(ordering==='late-stop'){assert.equal(final.state,'cancelled');assert.notEqual(final.workspace?.saved,'saved');}
 if(ordering==='service-save'||ordering==='service-already-aborted'){assert.equal(saveCalled,true);assert.equal(final.state,'completed');assert.notEqual(final.workspace?.saved,'saved');assert.equal(git('rev-parse',w.branch),seed);assert.match(JSON.stringify(logs),/git was aborted/);}
 if(ordering==='service-before-save'){assert.equal(saveCalled,false);assert.equal(final.state,'completed');assert.notEqual(final.workspace?.saved,'saved');}
});
