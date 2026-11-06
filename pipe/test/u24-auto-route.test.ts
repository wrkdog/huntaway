import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllowanceLedger } from '../src/allowance.ts';
import { DatabaseSync } from 'node:sqlite';
import { Store, type NewRequest } from '../src/store.ts';
import { plan, type AccountStatus } from '../src/queue.ts';
const now = new Date('2026-10-03T12:00:00Z'), reset = '2026-10-03T13:00:00Z';
const policy = { codex: { models: { 'gpt-6.1-sol': 'default' as const }, efforts: ['high'] }, claude: { models: { opus: 'default' as const }, efforts: ['high'] } };
const automatic = { fallback: { provider:'claude', model:'opus', effort:'high', reason:'explicit trial fallback' }, reviewReserve:0.1 };
const request = (extra = {}): NewRequest => ({ requester:'trial', project:'scratch', kind:'code', provider:'codex', model:'gpt-6.1-sol', effort:'high', reason:'primary trial', prompt:'fixture', mutating:false, priority:'interactive', placement:'ordinary_headroom', automatic, ...extra } as NewRequest);
const status = (id:string, room:number | string, running=0): AccountStatus => ({ account:{id,provider:id.startsWith('c')?'codex':'claude',enabled:true,maxConcurrency:1,loginDir:'/fixture',fingerprint:'fixture'}, running,
  evidence: model => ({accountId:id,model,observedAt:now.toISOString(),allowanceObservedAt:now.toISOString(),ordinaryExhaustion:room==='exhausted'||room===0?{observedAt:now.toISOString(),until:reset}:null,verdict:typeof room==='number'?{state:'available',headroom:room}:room==='exhausted'?{state:'unavailable',reason:'allowance exhausted',cause:'allowance',until:reset}:{state:'unknown',reason:room}}) });
const options = { now, evidenceMaxAgeMs:60_000, pinWaitMs:60_000, load:new Map() };
function fixture(t:any) { const root=mkdtempSync(join(tmpdir(),'auto-')), path=join(root,'record.sqlite'), store=new Store(path,{now:()=>now,retryBackoffMs:0}); t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {store,path,root}; }
const claim = (store:Store, id:string, accounts:AccountStatus[], p=policy) => (store as any).startAutomatic(id,accounts,p,[]);

test('A1 automatic primary precedence, highest ordinary room, two tasks change accounts after exhaustion', t=>{
  const {store}=fixture(t), a=status('c1',.9), b=status('c2',.5), f=status('f1',.99);
  const r=store.submit(request()), first=claim(store,r.id,[b,f,a]); assert.ok(first.ok);assert.equal(first.attempt.accountId,'c1');
  store.finishAttempt(first.attempt.id,{kind:'completed',result:'done'});
  const second=claim(store,store.submit(request()).id,[status('c1','exhausted'),b,f]); assert.ok(second.ok);assert.equal(second.attempt.accountId,'c2');
});
test('A2 busy and ambiguous Codex never authorize Claude; stale/cross-account/future evidence refuses', t=>{
  const {store}=fixture(t);
  const bad=[status('c1',.9,1),status('c1','offline')];
  for(const patch of [{accountId:'foreign'},{observedAt:'2026-10-03T11:00:00Z'},{observedAt:reset},{verdict:{state:'unavailable',reason:'auth exhausted',until:reset}}]) {
    const a=status('c1',.9), read=a.evidence;a.evidence=m=>({...read(m),...patch} as any);bad.push(a);
  }
  for(const a of bad) {const r=store.submit(request()), decision=plan([r],[a,status('f1',.9)],options);assert.equal(decision.dispatch.length,0);assert.equal(decision.waits.length,0);assert.equal(decision.fail.length,1);}
  const busy=claim(store,store.submit(request()).id,[status('c1',.9),status('f1',.9)]);assert.ok(busy.ok);
  const r=store.submit(request());assert.equal(claim(store,r.id,[status('c1',.9),status('f1',.9)]).ok,false);assert.equal(store.get(r.id)!.error?.kind,'admission_busy');
});
test('A3 fallback is explicit, floor is strict, credits excluded, no-room reset persisted without cancellation', t=>{
  const {store}=fixture(t);
  for(const [room,kind] of [[.1,'review_reserve'],[0,'admission_exhausted'],['exhausted','admission_exhausted'],['unknown','admission_unknown']] as const) {
    const r=store.submit(request());assert.equal(claim(store,r.id,[status('c1','exhausted'),status('f1',room)]).ok,false);
    const final=store.get(r.id)!;assert.equal(final.state,'failed');assert.equal(final.error?.kind,kind);assert.equal(final.by,undefined);assert.equal(store.attempts(r.id).length,0);
    if(room==='exhausted') assert.equal((final.error as any).resetAt,new Date(reset).toISOString());
  }
  const r=store.submit(request()), started=claim(store,r.id,[status('c1',0),status('f1',.10001)]);assert.ok(started.ok);
  assert.equal(started.attempt.dispatch.route.provider,'claude');assert.equal(started.attempt.dispatch.route.model,'opus');assert.equal(store.get(r.id)!.model,'gpt-6.1-sol');
  assert.equal((store.requestStatus(r.id)!.selection as any).provider,'claude');
});
test('A4 claim rechecks policy, fresh evidence, transactional slots and clock; direct auto claim cannot bypass route', t=>{
  const {store,path}=fixture(t), r=store.submit(request());const a=status('c1',.9);
  assert.equal(store.startAttempt(r.id,a.account,{...a.evidence(r.model),grant:[]}).ok,false);
  const other=new Store(path,{now:()=>now});t.after(()=>other.close());
  assert.ok(claim(other,other.submit(request()).id,[a]).ok);
  assert.equal(claim(store,r.id,[a,status('f1',.9)]).ok,false);assert.equal(store.get(r.id)!.state,'failed');
  const invalid=store.submit(request());assert.equal(claim(store,invalid.id,[status('c2',.9)],{...policy,claude:{models:{opus:'default'},efforts:['low']}} as any).ok,false);
  const later=new Store(path,{now:()=>new Date(now.getTime()+60_000)});later.submit(request());later.close();
  const stepped=store.submit(request());assert.equal(claim(store,stepped.id,[status('c2',.9)]).ok,false);assert.equal(store.get(stepped.id)!.error?.kind,'admission_unknown');
});
test('A5 malformed automatic intent refuses; retry refusal has no selection but retains original attempts', t=>{
  const {store,path}=fixture(t);
  for(const extra of [{pin:'c1'},{placement:undefined},{model:'other'},{automatic:null},{automatic:{...automatic,reviewReserve:0}},{automatic:{...automatic,fallback:{...automatic.fallback,effort:'low'}}}]) assert.throws(()=>store.submit(request(extra)),/automatic/);
  const r=store.submit(request()), first=claim(store,r.id,[status('c1',.9)]);assert.ok(first.ok);
  store.finishAttempt(first.attempt.id,{kind:'failed',errorKind:'quota_exhausted',message:'pre-tool',untouched:true});
  assert.equal(claim(store,r.id,[status('c1','exhausted'),status('f1',.1)]).ok,false);
  const s=store.requestStatus(r.id)!;assert.equal(s.selection,null);assert.equal(s.attempts.length,1);
  const db=new DatabaseSync(path);t.after(()=>db.close());
  for(const dispatch of ['null','{','{}']) {db.prepare('UPDATE attempts SET dispatch=? WHERE id=?').run(dispatch,first.attempt.id);assert.equal(store.requestStatus(r.id)!.attempts[0]!.allowance,null);}
});

test('A6 a fresh verdict cannot turn a stale/missing provider observation into fallback; floor races refuse', t=>{
  const {store}=fixture(t);
  for(const allowanceObservedAt of [undefined,null,'2026-10-03T11:00:00Z',reset]) {
    const a=status('c1','exhausted'), read=a.evidence;a.evidence=m=>({...read(m),allowanceObservedAt});
    const r=store.submit(request());assert.equal(claim(store,r.id,[a,status('f1',.9)]).ok,false);assert.equal(store.get(r.id)!.error?.kind,'admission_unknown');
  }
  let reads=0;const f=status('f1',.9), read=f.evidence;f.evidence=m=>({...read(m),verdict:{state:'available',headroom:++reads===1?.9:.05}});
  const r=store.submit(request());assert.equal(claim(store,r.id,[status('c1','exhausted'),f]).ok,false);assert.equal(store.attempts(r.id).length,0);
});

test('A7 reserve stop intent survives restart even before spawn; only requester cancellation is cancelled', t=>{
  const {store,path}=fixture(t), r=store.submit(request()), started=claim(store,r.id,[status('c1','exhausted'),status('f1',.9)]);assert.ok(started.ok);
  (store as any).noteReserveStop(started.attempt.id);
  const again=new Store(path,{now:()=>now});try {again.reconcile('owned group gone','interrupted');assert.equal(again.get(r.id)!.state,'failed');assert.match(again.get(r.id)!.error!.message,/review reserve/);assert.equal(again.attempts(r.id).length,1);}finally{again.close();}
  const cancelled=store.submit(request()), next=claim(store,cancelled.id,[status('c1','exhausted'),status('f1',.9)]);assert.ok(next.ok);
  store.noteReserveStop(next.attempt.id);store.cancel(cancelled.id,'requester Stop','fixture');store.finishAttempt(next.attempt.id,{kind:'cancelled'});
  assert.equal(store.get(cancelled.id)!.state,'cancelled');assert.equal(store.get(cancelled.id)!.by,'fixture');assert.equal(store.attempts(cancelled.id)[0]!.outcome!.kind,'cancelled');
});

test('A8 automatic intent advances record version before admission so older engines cannot discard it', t=>{
  const {store,path}=fixture(t), db=new DatabaseSync(path);t.after(()=>db.close());
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,2);
  store.submit(request());assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,3);
  const reopened=new Store(path,{now:()=>now});reopened.close();assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,3);
});

test('A9 a clock step between planning and final claim cannot admit older but seemingly fresh evidence', t=>{
  const {root}=fixture(t);let time=new Date(now.getTime()+30_000), reads=0;
  const store=new Store(join(root,'clock.sqlite'),{now:()=>time});t.after(()=>store.close());const r=store.submit(request());
  const a=status('c1',.9), read=a.evidence;a.evidence=m=>{if(++reads===2)time=new Date(now.getTime()+20_000);return read(m);};
  assert.equal(claim(store,r.id,[a]).ok,false);assert.equal(store.get(r.id)!.error?.kind,'admission_unknown');assert.equal(store.attempts(r.id).length,0);
});

test('A10 malformed or expired limit resets cannot certify exhaustion; credit room is never Claude reserve', t=>{
  const {store}=fixture(t);
  for(const until of [undefined,42,'bad','2026-10-03T11:59:00Z']) {
    const c=status('c1','exhausted'),read=c.evidence;c.evidence=m=>({...read(m),verdict:{state:'unavailable',reason:'exhausted',cause:'allowance',until}} as any);
    const r=store.submit(request());assert.equal(claim(store,r.id,[c,status('f1',.9)]).ok,false);assert.equal(store.get(r.id)!.error?.kind,'admission_unknown');
  }
  const f=status('f1',.5),read=f.evidence;f.evidence=m=>({...read(m),verdict:{state:'available',headroom:.5,via:'credits'}});
  const r=store.submit(request());assert.equal(claim(store,r.id,[status('c1','exhausted'),f]).ok,false);assert.equal(store.get(r.id)!.error?.kind,'admission_exhausted');
});
test('A11 selection is a read snapshot even while another connection holds the writer slot',t=>{
  const {store,path}=fixture(t),r=store.submit(request()),db=new DatabaseSync(path);t.after(()=>db.close());
  db.exec('BEGIN IMMEDIATE');try {assert.equal(store.requestStatus(r.id)!.selection,null);}finally{db.exec('ROLLBACK');}
});

test('A12 ledger observation time is account-bound, complete and fresh even when a durable exhaustion hold survives',()=>{
  let time=now;const ledger=new AllowanceLedger({freshnessMs:60_000,now:()=>time});
  ledger.record('c1',[{bucket:'week',model:null,usedFraction:1,resetsAt:reset}]);
  assert.equal(ledger.observedAt('c1','gpt-6.1-sol'),now.toISOString());assert.equal(ledger.readingSource('c1'),'verified');assert.equal(ledger.observedAt('foreign','gpt-6.1-sol'),null);
  time=new Date(now.getTime()+61_000);assert.equal(ledger.view('c1','gpt-6.1-sol').state,'exhausted');assert.equal(ledger.observedAt('c1','gpt-6.1-sol'),null);
  time=now;assert.equal(ledger.observedAt('c1','gpt-6.1-sol'),null);
  const cached=new AllowanceLedger({freshnessMs:60_000,now:()=>now});cached.record('f1',[{bucket:'session',model:null,usedFraction:.5,resetsAt:reset}],undefined,{verified:false});
  assert.equal(cached.readingSource('f1'),'cache');assert.equal(cached.observedAt('f1','opus'),now.toISOString());
  cached.record('f1',[{bucket:'session',model:null,usedFraction:null,resetsAt:reset}],undefined,{verified:false});assert.equal(cached.observedAt('f1','opus'),null);
});

// L77: holds block use; only measured ordinary exhaustion authorizes another provider.
test('A13 a generic throttle cannot borrow a positive reading to certify exhaustion', t=>{
  const {store}=fixture(t);
  for(const resetsAt of [null,reset]) {
    const ledger=new AllowanceLedger({freshnessMs:60_000,now:()=>now});
    ledger.record('c1',[{bucket:'week',model:null,usedFraction:.3,resetsAt:reset}]);
    ledger.recordLimit('c1',{bucket:null,model:null,resetsAt,observedAt:now.toISOString()});
    const c=status('c1','exhausted');c.evidence=model=>{const v=ledger.view('c1',model);assert.equal(v.state,'exhausted');return {accountId:'c1',model,observedAt:now.toISOString(),allowanceObservedAt:ledger.observedAt('c1',model),ordinaryExhaustion:(ledger as any).ordinaryExhaustion?.('c1',model),verdict:{state:'unavailable',cause:'allowance',reason:'hold',until:(v as any).until}};};
    const r=store.submit(request());assert.equal(claim(store,r.id,[c,status('f1',.9)]).ok,false);assert.equal(store.get(r.id)!.error?.kind,'admission_unknown');assert.equal(store.attempts(r.id).length,0);
  }
});
test('A14 disabled spares are irrelevant; avoids cannot hide ordinary room or uncertainty', t=>{
  const {store}=fixture(t), disabled=(id:string)=>{const a=status(id,'unknown');a.account.enabled=false;return a;};
  for(const accounts of [[status('c1','exhausted'),disabled('c2'),status('f1',.8)], [status('c1','exhausted'),status('f1',.1),disabled('f2')], [status('c1','exhausted'),status('f1','exhausted'),disabled('f2')]]) {
    const r=store.submit(request()),p=plan([r],accounts,options);assert.equal(p.dispatch[0]?.accountId??p.fail[0]?.code,accounts[1]!.account.provider==='codex'?'f1':accounts[1]!.evidence('opus').verdict.state==='available'?'review_reserve':'admission_exhausted');
  }
  for(const room of ['exhausted','unknown',.7] as const) {
    const r={...store.submit(request()),avoid:['c2','f2']},p=plan([r],[status('c1','exhausted'),status('c2',room),status('f1',.8),status('f2','unknown')],options);
    assert.equal(p.dispatch[0]?.accountId??p.fail[0]?.code,room==='exhausted'?'f1':'admission_unknown');
  }
  for(const primaries of [[],[disabled('c1')],[status('c1','unknown')],[status('c1','exhausted'),status('c2','unknown')],[status('c1','exhausted'),status('c2',.7,1)]]) {
    const p=plan([store.submit(request())],[...primaries,status('f1',.8)],options);assert.equal(p.dispatch.length,0);assert.equal(p.fail[0]?.code,primaries.at(-1)?.running?'admission_busy':'admission_unknown');
  }
  for(const fallback of [[],[disabled('f1')],[status('f1','unknown')],[status('f1',.8,1)]]) {const p=plan([store.submit(request())],[status('c1','exhausted'),...fallback],options);assert.equal(p.dispatch.length,0);assert.equal(p.fail[0]?.code,fallback[0]?.running?'admission_busy':'admission_unknown');}
});
for(const change of ['reset','stale','current'] as const) test(`A15 final claim revalidates every primary prerequisite: ${change}`,t=>{
  const {root}=fixture(t);let time=now,reads=0;
  const store=new Store(join(root,'final.sqlite'),{now:()=>time,evidenceMaxAgeMs:60_000});t.after(()=>store.close());
  const c=status('c1','exhausted'),read=c.evidence;
  c.evidence=m=>{const e=read(m);if(change==='current' && ++reads>1)return {...e,verdict:{state:'available',headroom:.7}};return {...e,ordinaryExhaustion:{observedAt:now.toISOString(),until:change==='reset'?'2026-10-03T12:00:01Z':reset},verdict:{state:'unavailable',cause:'allowance',reason:'measured full',until:change==='reset'?'2026-10-03T12:00:01Z':reset}};};
  const f=status('f1',.8);let fr=0;f.evidence=model=>{if(++fr===2)time=new Date(now.getTime()+(change==='stale'?61_000:2000));return {accountId:'f1',model,observedAt:time.toISOString(),allowanceObservedAt:time.toISOString(),verdict:{state:'available',headroom:.8}};};
  const r=store.submit(request());assert.equal(claim(store,r.id,[c,f]).ok,false);assert.equal(store.get(r.id)!.error?.kind,'admission_unknown');assert.equal(store.attempts(r.id).length,0);assert.equal(store.get(r.id)!.id,r.id);
});
test('A16 automatic retry backoff is a specific refusal retaining its original error and deadline',t=>{
  const {root}=fixture(t),store=new Store(join(root,'backoff.sqlite'),{now:()=>now,retryBackoffMs:60_000});t.after(()=>store.close());
  const r=store.submit(request()),a=claim(store,r.id,[status('c1',.9)]);assert.ok(a.ok);store.finishAttempt(a.attempt.id,{kind:'failed',errorKind:'transient',message:'transport',untouched:true});
  const deadline=store.get(r.id)!.notBefore;assert.ok(deadline);assert.equal(claim(store,r.id,[status('c1',.9)]).ok,false);assert.equal(store.get(r.id)!.error?.kind,'admission_backoff');assert.equal(store.get(r.id)!.error?.resetAt,deadline);assert.match(store.get(r.id)!.error!.message,/transient/);assert.equal(store.attempts(r.id).length,1);
});

test('A17 concurrent handles cannot overfill fallback and final foreign primary proof refuses',t=>{
  const {store,path}=fixture(t),other=new Store(path,{now:()=>now});t.after(()=>other.close());
  const accounts=[status('c1','exhausted'),status('c2','exhausted'),status('f1',.8)];
  const r=store.submit(request()),s=other.submit(request());assert.ok(claim(store,r.id,accounts).ok);assert.equal(claim(other,s.id,accounts).ok,false);assert.equal(other.get(s.id)!.error?.kind,'admission_busy');assert.equal(other.attempts(s.id).length,0);
  store.finishAttempt(store.attempts(r.id)[0]!.id,{kind:'completed',result:'done'});
  for(const patch of [{accountId:'foreign'},{model:'foreign'},{allowanceObservedAt:null},{verdict:{state:'unknown',reason:'offline'}}]) {
    let reads=0;const c=status('c2','exhausted'),read=c.evidence;c.evidence=m=>++reads===1?read(m):({...read(m),...patch} as any);
    const r=store.submit(request());assert.equal(claim(store,r.id,[accounts[0]!,c,accounts[2]!]).ok,false);assert.equal(store.get(r.id)!.error?.kind,'admission_unknown');assert.equal(store.attempts(r.id).length,0);
  }
});
test('A18 ledger exhaustion proof stays separate from holds and keeps its reset and observation',()=>{
  let time=now;const ledger=new AllowanceLedger({freshnessMs:60_000,now:()=>time});
  for(const [used,via,full] of [[.3,undefined,false],[1,undefined,true],[.3,'credits',true]] as const) {
    ledger.record('c1',[{bucket:'week',model:null,usedFraction:used,resetsAt:reset,...(via?{via}:{})}]);
    assert.deepEqual(ledger.ordinaryExhaustion('c1','gpt-6.1-sol'),full?{observedAt:now.toISOString(),until:reset}:null);
  }
  assert.equal(ledger.ordinaryExhaustion('foreign','gpt-6.1-sol'),null);
  time=new Date(now.getTime()+61_000);assert.equal(ledger.ordinaryExhaustion('c1','gpt-6.1-sol'),null);
  time=now;assert.equal(ledger.ordinaryExhaustion('c1','gpt-6.1-sol'),null);
});
test('A19 a primary set removed during final evidence reads cannot vacuously authorize fallback',t=>{
  const {store}=fixture(t),c=status('c1','exhausted'),f=status('f1',.8),read=f.evidence;let reads=0;
  f.evidence=m=>{if(++reads===2)c.account.enabled=false;return read(m);};
  const r=store.submit(request());assert.equal(claim(store,r.id,[c,f]).ok,false);assert.equal(store.get(r.id)!.error?.kind,'admission_unknown');assert.equal(store.attempts(r.id).length,0);
});
