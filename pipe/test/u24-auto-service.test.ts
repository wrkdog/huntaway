import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { startPipe } from '../src/service.ts';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import { AllowanceLedger } from '../src/allowance.ts';

for (const change of ['floor','unknown','complete','write-failure'] as const) test(`automatic service executes claimed Claude branch and ${change} retains original ownership`, async t=>{
  const root=mkdtempSync(join(tmpdir(),'auto-service-')), repo=join(root,'repo'), path=join(root,'record.sqlite');
  const env={PATH:process.env.PATH,HOME:root,TMPDIR:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
  for(const args of [['init','-q',repo],['-C',repo,'commit','--allow-empty','-qm','seed']]) {const r=spawnSync('git',args,{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
  const rows=JSON.parse(readFileSync(new URL('./fixtures/u4/codex-app-server.signed-in.json',import.meta.url),'utf8').replaceAll('gpt-6-sol','gpt-6.1-sol'));
  const limits=rows.find((x:any)=>x.method==='account/rateLimits/read').response.result;
  for(const v of [limits.rateLimits,...Object.values(limits.rateLimitsByLimitId)] as any[]) {v.primary.usedPercent=100;v.primary.resetsAt=Math.floor(Date.now()/1000)+3600;}
  const auth=JSON.parse(readFileSync(new URL('./fixtures/u4/claude-auth-status.signed-in.json',import.meta.url),'utf8')).stdout;
  const codex=join(root,'fake-codex.cjs'),claude=join(root,'fake-claude.cjs');
  writeFileSync(codex,`#!${process.execPath}
const rows=${JSON.stringify(rows)};
if(process.argv[2]==='--version')console.log('codex-cli 0.156.1');
else if(process.argv[2]==='login')console.error('Logged in using ChatGPT');
else if(process.argv[2]==='app-server')require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l),r=rows.find(r=>r.method===m.method);if(r)console.log(JSON.stringify({...r.response,id:m.id}));});
else {require('node:fs').writeFileSync(${JSON.stringify(join(root,'WRONG-CODEX'))},'wrong');process.exit(1);}
`);chmodSync(codex,0o755);
  writeFileSync(claude,`#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);
if(a[0]==='--version')console.log('2.1.80 (Claude Code)');
else if(a[0]==='auth')console.log(JSON.stringify(${JSON.stringify(auth)}));
else if(a[0]==='-p'&&a[1]==='/usage') {
 const at=ms=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).formatToParts(new Date(ms)).map(x=>[x.type,x.value]));return p.month+' '+p.day+' at '+p.hour+':'+p.minute+p.dayPeriod.toLowerCase();};
 console.log(JSON.stringify({type:'result',is_error:false,num_turns:0,total_cost_usd:0,duration_api_ms:0,result:'Current session: 20% used · resets '+at(Date.now()+3600000)+' (America/New_York)\\nCurrent week (all models): 20% used · resets '+at(Date.now()+86400000)+' (America/New_York)'}));
} else {
 fs.readFileSync(0);fs.writeFileSync('partial.txt','owned work');fs.writeFileSync(${JSON.stringify(join(root,'argv.json'))},JSON.stringify(a));
 console.log(JSON.stringify({type:'system',subtype:'init',model:'opus',session_id:'fixture'}));
 ${change==='complete'?"console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'OK'}));":"setInterval(()=>{},100);"}
}
`);chmodSync(claude,0o755);
  let handler:any;
  const server=Object.assign(new EventEmitter(),{listen(_p:number,_h:string,cb:()=>void){cb();},address(){return{port:1};},closeAllConnections(){},close(cb:()=>void){cb();}});
  t.mock.method(http,'createServer',(cb:any)=>{handler=cb;return server;});syncBuiltinESMExports();
  let reported=false, reports=0, blockedAttempt:string|undefined, releaseStop=false;const noteStop=Store.prototype.noteReserveStop;
  if(change==='write-failure') t.mock.method(Store.prototype,'noteReserveStop',function(this:Store,id:string){blockedAttempt??=id;if(id===blockedAttempt&&!releaseStop)throw new Error('fixture stop-intent write unavailable');return noteStop.call(this,id);});
  const noteModel=Store.prototype.noteModel;
  t.mock.method(Store.prototype,'noteModel',function(this:Store,...args:Parameters<typeof noteModel>){noteModel.apply(this,args);if(args[1]==='opus'){reports++;reported=change==='write-failure'?reports>=2:true;}});
  const view=AllowanceLedger.prototype.view;
  t.mock.method(AllowanceLedger.prototype,'view',function(this:AllowanceLedger,id:string,model?:string){
    if(id==='f1'&&reported&&change!=='complete') return change==='floor'||change==='write-failure'?{state:'ok',accountId:id,headroom:.1,binding:'session'}:{state:'unknown',accountId:id,reason:'probe unavailable'};
    return view.call(this,id,model);
  });
  const call=(method:string,url:string,input?:unknown):Promise<any>=>new Promise(resolve=>{
    const req=Object.assign(Readable.from(input===undefined?[]:[Buffer.from(JSON.stringify(input))]),{method,url,headers:{authorization:'Bearer fixture-token-local-only-0000000000000000','content-type':'application/json'}});
    handler(req,{writeHead(code:number){assert.ok(code===200||code===201,`HTTP ${code}`);},end(data:string){resolve(JSON.parse(data));}});
  });
  let pipe:Awaited<ReturnType<typeof startPipe>>|undefined, store:Store|undefined;
  try {
    pipe=await startPipe({accounts:[{id:'c1',provider:'codex',loginDir:root,fingerprint:createHash('sha256').update('<chatgptAccountId>').digest('hex').slice(0,8),enabled:true,maxConcurrency:1},{id:'f1',provider:'claude',loginDir:repo,fingerprint:createHash('sha256').update('<orgId>').digest('hex').slice(0,8),enabled:true,maxConcurrency:change==='write-failure'?2:1}],policy:{codex:{models:{'gpt-6.1-sol':'default'},efforts:['high']},claude:{models:{opus:'default'},efforts:['high']}},storePath:path,worktreeRoot:join(root,'trees'),cli:{codex,claude},env,token:'fixture-token-local-only-0000000000000000',reachable:async()=>true,tickMs:25,minFreeGb:0,hostAlias:'host-02'});
    store=new Store(path);
    assert.equal((await call('GET','/v1/capabilities')).automatic,'pipe-auto-v1');
    const admitted=await call('POST','/v1/requests',{requester:'fixture',project:'fixture',kind:'code',provider:'codex',model:'gpt-6.1-sol',effort:'high',reason:'explicit primary',automatic:{fallback:{provider:'claude',model:'opus',effort:'high',reason:'explicit fallback'},reviewReserve:.1},placement:'ordinary_headroom',mutating:true,cwd:repo,prompt:'fixture',priority:'interactive'});
    assert.equal(admitted.request.state,'running',JSON.stringify(admitted));const id=admitted.request.id;
    assert.equal(store.attempts(id)[0]!.dispatch.host, 'host-02', 'admitAutomatic stamps the executor before execution');
    assert.equal((await call('GET', `/v1/cards/${id}`)).card.attempts[0].host, 'host-02');
    const db = new DatabaseSync(path);
    try { assert.equal(JSON.parse(String(db.prepare('SELECT dispatch FROM attempts WHERE request_id = ?').get(id)!.dispatch)).host, 'host-02'); }
    finally { db.close(); }
    if(change==='write-failure') {
      const second=await call('POST','/v1/requests',{requester:'second',project:'fixture',kind:'code',provider:'codex',model:'gpt-6.1-sol',effort:'high',reason:'primary',automatic:{fallback:{provider:'claude',model:'opus',effort:'high',reason:'fallback'},reviewReserve:.1},placement:'ordinary_headroom',mutating:true,cwd:repo,prompt:'fixture',priority:'interactive'});
      assert.equal(second.request.state,'running');const end=Date.now()+3000;
      while(Date.now()<end && store.get(second.request.id)!.state!=='failed')await sleep(25);
      assert.equal(store.get(second.request.id)!.state,'failed','one failed durable stop must not starve another job guard');
      assert.equal(store.get(id)!.state,'running','failed intent must not authorize a signal');releaseStop=true;
    }
    const deadline=Date.now()+10_000;
    while(Date.now()<deadline){const r=store.get(id)!;if(change==='complete'?r.workspace?.saved:r.state==='failed')break;await sleep(25);}
    const r=store.get(id)!;assert.equal(r.state,change==='complete'?'completed':'failed',JSON.stringify(r));assert.equal(store.attempts(id).length,1);assert.equal(r.model,'gpt-6.1-sol');assert.equal(existsSync(join(root,'WRONG-CODEX')),false);
    assert.ok(r.workspace);assert.equal(readFileSync(join(r.workspace.path,'partial.txt'),'utf8'),'owned work');
    const args=JSON.parse(readFileSync(join(root,'argv.json'),'utf8'));assert.equal(args[args.indexOf('--model')+1],'opus');
    const result=await call('GET',`/v1/requests/${id}`);assert.equal(result.status.selection.accountId,'f1');assert.equal(result.status.selection.provider,'claude');assert.equal(result.status.selection.reportedModel,'opus');assert.ok(result.status.selection.allowance.observedAt);
    if(change==='complete') {assert.equal(r.workspace.saved,'saved');assert.equal(result.status.currentAllowance.provenance,'current_observation');}
    else {assert.match(r.error!.message,/review reserve/);assert.notEqual(r.error!.kind,'cancelled');assert.equal(r.by,undefined);}
  } finally {await pipe?.stop();store?.close();t.mock.restoreAll();syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
});
