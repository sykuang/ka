#!/usr/bin/env python3
"""Bounded stdlib/Node source-owner save regression; JSON capture, not native durability."""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ENDPOINTS = r'''const saverFull=fs.readFileSync(out+'/SessionSaver.mjs','utf8');
assert.equal(saverFull.split('var SessionSaverInternal = {').length,2);
const saverOffset=saverFull.indexOf('var SessionSaverInternal = {');
const saverSource=saverFull.slice(saverOffset);
fs.writeFileSync(out+'/saver-scope.json',JSON.stringify({uniqueScope:'var SessionSaverInternal = {',startLine:saverFull.slice(0,saverOffset).split('\n').length}));
// Select the unique internal object before extracting complete unique members.
const saver=eval('({'+['_saveState(', '_writeState(', '_maybeClearCookiesAndStorage(', 'updateLastSaveTime()', 'cancel()'].map(s=>member(saverSource,s)).join(',')+'})');
const clearTimeout=()=>{}, cancelIdleCallback=()=>{};
const notify=(subject,topic)=>Services.obs.notifyObservers(subject,topic);
const TAB_CUSTOM_VALUES=new Map();
DirtyWindows.remove=()=>{};
lazy.TabState={collect:t=>structuredClone(t.state)};
lazy.TabGroupState={collect:g=>structuredClone(g)};
lazy.sessionStoreLogger={debugEnabled:false,debug(){},error:(...a)=>effects.push({name:'writeError',args:a.map(String)})};
lazy.PrivacyFilter=eval('({'+member(fs.readFileSync(out+'/PrivacyFilter.mjs','utf8'),'filterPrivateWindowsAndTabs(')+'})');
const snap=x=>JSON.parse(JSON.stringify(x));
function fixture(nested=true){
  const d=persisted();
  d.windows[0].identity='OUTER';d.windows[0].tabs[0].entries[0].url='https://outer.invalid/old';
  d.global={owner:'OUTER'};d._closedWindows[0].identity='OUTER-CLOSED';d.savedGroups[0].id='outer-saved';
  if(nested){const p=d.deferredInitialState;p.windows[0].identity='INNER';p.windows[0].tabs[0].entries[0].url='https://inner.invalid/history';p.global={owner:'INNER'};p._closedWindows[0].identity='INNER-CLOSED';p.savedGroups[0].id='inner-saved';p.lastSessionState.unknown='inner-last';p.unknownRoot={only:'INNER'};p.cookies=[{owner:'INNER'}];}
  else delete d.deferredInitialState;
  return d;
}
function start(input,kind='normal'){
  effects=[];
  const s=fresh(input);s._windows={};
  let globals={};s._globalState={getState:()=>globals,setFromState:d=>{globals=structuredClone(d.global||{});effects.push({name:'globalRestore'});}};
  const w=win(s,'first',kind);
  Object.assign(w,{gZenWorkspaces:{allStoredTabs:[],activeWorkspace:'local',getWorkspacesForSessionStore:()=>[space('local')]},
    FirefoxViewHandler:{tab:null},gBrowser:{tabGroups:[],splitViews:[],tabbox:{selectedIndex:0},tabs:[]}});
  s._orderedBrowserWindows=[w];s._updateWindowFeatures=()=>{};
  function update(data){
    s._windows[w.__SSi]={...structuredClone(data),isPrivate:kind==='private',isPopup:kind==='popup',isTaskbarTab:kind==='taskbar',isZenUnsynced:kind==='unsynced'};
    w.gZenWorkspaces.allStoredTabs=(data.tabs||[]).map(t=>({state:structuredClone(t)}));
  }
  update({identity:'NEW-'+kind,spaces:[space('local')],tabs:[tab()]});
  s._restoreWindows=(target,d,options)=>{effects.push({name:'restoreWindows',state:snap(d),options});if(target===w)update(d.windows[0]);else s._windows[target.__SSi]=structuredClone(d.windows[0]);};
  lazy.ZenSessionStore.saveState=state=>{effects.push({name:'zenSidecar',state:snap(state)});return Promise.resolve();};
  const read=lazy.ZenSessionStore.onFileRead(input);assert.equal(read,input);
  const initial=s._initSession();assert.equal(initial,input);s._initializeWindow(w,initial);
  // The actual #collectWindowData reads this modeled DOM endpoint on every save.
  return {s,w,update,change(label){const t=w.gZenWorkspaces.allStoredTabs[0].state;t.entries.push({url:'https://live.invalid/'+label,title:label});t.index=t.entries.length;}};
}
let writeNo=0;
async function save(s,label,fail=false){
  lazy.SessionStore=s;const collector=snap(s.getCurrentState(true));
  fs.writeFileSync(out+'/'+label+'.startup.json',JSON.stringify(startup.state,null,2));
  fs.writeFileSync(out+'/'+label+'.collector.json',JSON.stringify(collector,null,2));
  const residentBefore=resident(s);
  let captured,readback,complete=false;
  lazy.SessionFile={write(state){captured=snap(state);effects.push({name:'SessionFile.write'});
    // Real serialization and owned filesystem write/read. No SessionFile codec.
    return Promise.resolve().then(()=>{if(fail)throw Error('owned-write-failure');
      const p=out+'/'+label+'.write.json';fs.writeFileSync(p,JSON.stringify(state,null,2));readback=JSON.parse(fs.readFileSync(p,'utf8'));assert.deepEqual(readback,captured);complete=true;});}};
  const value=saver._saveState(true);assert.ok(value instanceof Promise);await value;
  await Promise.resolve();
  fs.writeFileSync(out+'/'+label+'.effects.json',JSON.stringify(effects,null,2));
  writeNo++;
  return {collector,captured,readback,complete,fulfilled:true,residentBefore,residentAfter:resident(s)};
}
'''
ADAPTER = r'''
const classFields=[];
const classDefaults={};
for(const match of store.matchAll(/^  #(deferredInitialState(?:Pending)?) = (null|false);$/gm)){
 const raw=match[0];classFields.push({raw,sha256:sha(raw),mapping:'#'+match[1]+' -> _'+match[1]});classDefaults['_'+match[1]]=JSON.parse(match[2]);
}
assert.ok('deferredInitialState' in Object.fromEntries(classFields.map(x=>[x.raw.match(/#(\w+)/)[1],true])));
if(store.includes('  get deferredInitialStatePending()')){
 Object.defineProperties(storeOwner,Object.getOwnPropertyDescriptors(eval('({'+member(store,'get deferredInitialStatePending()')+'})')));
}
'''
CASES = r'''const events=[];
const defaultBool=Services.prefs.getBoolPref;
async function check(name,run){effects=[];try{const evidence=await run();events.push({name,status:'PASS',...evidence});}
catch(e){events.push({name,status:e.code==='ERR_ASSERTION'?'FAIL':'ERROR',error:e.stack});}
finally{Services.prefs.getBoolPref=defaultBool;lazy.RunState.isClosing=false;}}
function pending(s,value){assert.equal(s.deferredInitialStatePending,value,'actual owner readonly provenance');}
function resident(s){return snap({windows:s._windows,closed:s._closedWindows,groups:s._savedGroups,deferred:s._deferredInitialState,last:LastSession._state});}
for(const nested of [false,true]) await check('ordinary live '+(nested?'full inactive INNER':'non-nested')+' two fresh cycles',async()=>{
 let input=fixture(nested),inner=nested?snap(input.deferredInitialState):null;
 for(let c=1;c<=2;c++){
  const a=start(input);a.change('live-'+c);const r=await save(a.s,'ordinary-'+nested+'-'+c);
  assert.ok(r.complete);assert.equal(r.readback.windows[0].identity,'OUTER','live ordinary window must not be overwritten');
  assert.equal(r.readback.windows[0].tabs[0].entries.at(-1).title,'live-'+c);
  if(nested)assert.deepEqual(r.readback.deferredInitialState,inner);else assert.ok(!r.readback.deferredInitialState);
  pending(a.s,false);input=r.readback;
 }
});
for(const kind of ['private','taskbar','unsynced'])for(const nested of [false,true])await check(kind+' first '+(nested?'complete INNER':'legacy root')+' future normal session',async()=>{
 const input=fixture(nested),original=snap(nested?input.deferredInitialState:input),a=start(input,kind);
 noUnsafe();const r=await save(a.s,kind+'-'+nested);assert.ok(r.complete);
 assert.deepEqual(r.readback,original,'entire deferred document, not windows only');pending(a.s,true);
 assert.deepEqual(a.s._deferredInitialState,original);
 const cold=start(r.readback);assert.equal(effects.find(e=>e.name==='restoreWindows').state.windows[0].identity,original.windows[0].identity);
 cold.change('future-'+kind);const next=await save(cold.s,kind+'-'+nested+'-cold');assert.ok(next.complete);
 assert.equal(next.readback.windows[0].tabs[0].entries.at(-1).title,'future-'+kind);pending(cold.s,false);
});
await check('first popup live versus private then popup identical collector pair',async()=>{
 const d=fixture();d.global={};
 const popupTab={zenWorkspace:'local',entries:[{url:'https://popup.invalid/first',title:'first'}],index:1};
 d.windows[0]={spaces:[space('local')],tabs:[snap(popupTab)],isPopup:true};
 const a=start(snap(d),'popup');assert.equal(effects.filter(e=>e.name==='restoreWindows').length,1);
 assert.deepEqual(effects.find(e=>e.name==='restoreWindows').state.windows[0],d.windows[0]);
 a.change('popup-live');const collectedA=snap(a.s.getCurrentState(true));
 const b=start(snap(d),'private'),inner=snap(b.s._deferredInitialState),later=win(b.s,'later-popup','popup');
 Object.assign(later,{gZenWorkspaces:{allStoredTabs:[],activeWorkspace:'local',getWorkspacesForSessionStore:()=>[space('local')]},
  FirefoxViewHandler:{tab:null},gBrowser:{tabGroups:[],splitViews:[],tabbox:{selectedIndex:0},tabs:[]}});
 b.s._windows[later.__SSi]={tabs:[],isPrivate:false,isPopup:true,isTaskbarTab:false,isZenUnsynced:false};
 const reached=snap(popupTab);reached.entries.push({url:'https://live.invalid/popup-live',title:'popup-live'});reached.index=2;
 later.gZenWorkspaces.allStoredTabs=[{state:reached}];effects=[];b.s._initializeWindow(later);noUnsafe();
 assert.deepEqual(b.s._deferredInitialState,inner);delete b.s._windows[b.w.__SSi];b.s._orderedBrowserWindows=[later];
 const rawB=snap(b.s.getCurrentState(true)),collectedB=snap(rawB);collectedB.session.lastUpdate=collectedA.session.lastUpdate;
 assert.deepEqual(collectedB,collectedA,'all serialized collector fields coincide');
 const filteredA=snap(collectedA),filteredB=snap(collectedB);lazy.PrivacyFilter.filterPrivateWindowsAndTabs(filteredA);lazy.PrivacyFilter.filterPrivateWindowsAndTabs(filteredB);assert.deepEqual(filteredB,filteredA);
 fs.writeFileSync(out+'/popup-first.normalized.json',JSON.stringify(collectedA,null,2));fs.writeFileSync(out+'/private-then-popup.raw.json',JSON.stringify(rawB,null,2));fs.writeFileSync(out+'/private-then-popup.normalized.json',JSON.stringify(collectedB,null,2));
 const ra=await save(a.s,'popup-first'),rb=await save(b.s,'private-then-popup');
 assert.equal(ra.readback.windows[0].tabs[0].entries.at(-1).title,'popup-live','first popup live history survives');assert.deepEqual(ra.readback.deferredInitialState,inner);
 assert.deepEqual(rb.readback,inner,'later popup keeps legacy pending fallback');pending(a.s,false);pending(b.s,true);
 assert.ok(!JSON.stringify(collectedA).includes('deferredInitialStatePending'));assert.ok(!JSON.stringify(ra.readback).includes('deferredInitialStatePending'));assert.ok(!JSON.stringify(rb.readback).includes('deferredInitialStatePending'));
 return {collectorEqual:true,normalizedOnly:'session.lastUpdate',first:'OUTER live',later:'complete INNER',transient:true};
});
await check('adoption inactive, real private deferral, successful consume once',async()=>{
 effects=[];const input=fixture(),s=fresh(input);pending(s,false);const initial=s._initSession();pending(s,false);
 s._initializeWindow(win(s,'first','private'),initial);pending(s,true);effects=[];
 s._initializeWindow(win(s,'consumer'));assert.equal(s._deferredInitialState,null);pending(s,false);
 assert.equal(effects.filter(e=>e.name==='restoreWindows').length,1);s._initializeWindow(win(s,'later'));assert.equal(effects.filter(e=>e.name==='restoreWindows').length,1);
});
await check('willRestore false and public setter reset clear provenance',async()=>{
 let a=start(fixture(),'private');startup.willRestore=()=>false;effects=[];a.s._initializeWindow(win(a.s,'consumer'));assert.equal(a.s._deferredInitialState,null);pending(a.s,false);noUnsafe();
 a=start(fixture(),'private');const original=snap(a.s._deferredInitialState);assert.ok(!JSON.parse(a.s.getBrowserState()).deferredInitialState);assert.deepEqual(a.s._deferredInitialState,original);pending(a.s,true);
 a.s.setDeferred(null);pending(a.s,false);assert.ok(!a.s.getCurrentState().deferredInitialState);
});
await check('legacy positive setter stages a pending local clone and consume',async()=>{
 const a=start(fixture(false)),d=fixture(false);a.s.setDeferred(d);pending(a.s,true);assert.equal(a.s._deferredInitialState,d);effects=[];a.s._initializeWindow(win(a.s,'consumer'),d);pending(a.s,false);assert.equal(a.s._deferredInitialState,null);assert.equal(effects.filter(e=>e.name==='restoreWindows').length,1);
});
for(const invalid of ['unknown-space','foreign-profile','unknown-version'])await check('refused deferred consumer and Saver promotion '+invalid,async()=>{
 const a=start(fixture(),'private'),p=a.s._deferredInitialState;
 if(invalid==='unknown-space')p.windows[0].tabs[0].zenWorkspace='unknown';if(invalid==='foreign-profile')p.windows[0].spaces[0].geckoProfileReference.persistentDescriptor='fixture-foreign-B';if(invalid==='unknown-version')p.geckoProfileBindingVersion=999;
 const before=snap(p),n=a.s._restoreCount;effects=[];a.s._initializeWindow(win(a.s,'consumer'));assert.equal(a.s._restoreCount,n);assert.deepEqual(a.s._deferredInitialState,before);noUnsafe();
 const r=await save(a.s,'refused-'+invalid);assert.equal(r.complete,false);assert.equal(r.captured,undefined);assert.ok(!effects.some(e=>['SessionFile.write','zenSidecar'].includes(e.name)));pending(a.s,true);assert.deepEqual(a.s._deferredInitialState,before);
});
await check('promotion guards actual current live ownership too',async()=>{
 const a=start(fixture(),'private');a.w.gZenWorkspaces.allStoredTabs[0].state.zenWorkspace='unknown';const original=snap(a.s._deferredInitialState);effects=[];
 const r=await save(a.s,'refused-current');assert.equal(r.complete,false);assert.equal(r.captured,undefined);assert.ok(!effects.some(e=>['SessionFile.write','zenSidecar'].includes(e.name)));assert.deepEqual(a.s._deferredInitialState,original);pending(a.s,true);
});
function mixedDocument(){
 const d=fixture(false);d.windows=[{spaces:[space('local')],isPrivate:true,tabs:[tab()]},{spaces:[space('local')],tabs:[{entries:[]},{entries:[{url:'about:privatebrowsing'}]}]},
 {spaces:[space('local')],selected:2,tabs:[{entries:[]},{...tab(),storage:{secret:'storage'}},{entries:[{url:'about:privatebrowsing'}],userTypedValue:'keep typed'}]}];
 d.selectedWindow=3;d._closedWindows=[{isPrivate:true,tabs:[tab()]},{tabs:[{...tab(),storage:{closed:'unchanged-existing-policy'}}],opaque:'closed-public'}];d.cookies=[{secret:'cookie'}];d.unknownRoot={windows:[{isPrivate:true,opaque:'not a session document'}]};return d;
}
for(const mode of ['ordinary','fallback','normal-no-nested'])for(const shutdown of ['running','sanitize','resume-once'])await check('actual policies '+mode+' '+shutdown+' no resident aliases',async()=>{
 const input=fixture(mode!=='normal-no-nested');if(mode!=='normal-no-nested'){
  input.deferredInitialState=mixedDocument();input.deferredInitialState.lastSessionState=mixedDocument();delete input.deferredInitialState.lastSessionState.lastSessionState;
  input.deferredInitialState.deferredInitialState=mixedDocument();delete input.deferredInitialState.deferredInitialState.lastSessionState;
 }
 // Changes to resident accepted data happen only after actual startup admission;
 // policy input includes private windows, empty tabs, typed private-page and storage.
 const a=start(input,mode==='fallback'?'private':'normal');
 const live=mixedDocument();a.update(live.windows[2]);a.s._closedWindows=live._closedWindows;
 const original=mode==='fallback'?snap(a.s._deferredInitialState):snap(a.s.getCurrentState(true));
 const closing=shutdown!=='running',resume=shutdown==='resume-once';lazy.RunState.isClosing=closing;
 const getBool=Services.prefs.getBoolPref;Services.prefs.getBoolPref=(key,d)=>key==='browser.sessionstore.resume_session_once'?resume:key==='privacy.sanitize.sanitizeOnShutdown'||key==='privacy.clearOnShutdown.cookies'?true:getBool(key,d);
 const expected=snap(original),queue=[expected];for(const doc of queue){for(const key of ['lastSessionState','deferredInitialState'])if(doc[key])queue.push(doc[key]);
  const hasWindows='windows' in doc,hasClosed='_closedWindows' in doc;doc.windows??=[];doc._closedWindows??=[];
  lazy.PrivacyFilter.filterPrivateWindowsAndTabs(doc);storeOwner.keepOnlyWorthSavingTabs.call({_shouldSaveTab:storeOwner._shouldSaveTab},doc);saver._maybeClearCookiesAndStorage(doc);
  if(!hasWindows)delete doc.windows;if(!hasClosed)delete doc._closedWindows;
 }
 const r=await save(a.s,'policies-'+mode+'-'+shutdown);assert.ok(r.complete);if(mode!=='fallback')expected.session.lastUpdate=r.readback.session.lastUpdate;assert.deepEqual(r.readback,expected);assert.deepEqual(r.residentAfter,r.residentBefore,'filtering cannot mutate resident owner aliases');
 if(mode!=='normal-no-nested'){
  const p=mode==='fallback'?r.readback:r.readback.deferredInitialState;assert.equal(p.windows.length,1);assert.equal(p.selectedWindow,1);assert.equal(p.windows[0].selected,1);assert.equal(p.windows[0].tabs.length,2);assert.equal(p._closedWindows.length,1);assert.equal(p.unknownRoot.windows[0].isPrivate,true,'unknown objects untouched');
  assert.equal('cookies' in p,!closing||resume);assert.equal('storage' in p.windows[0].tabs[0],!closing||resume);assert.equal(p._closedWindows[0].tabs[0].storage.closed,'unchanged-existing-policy');
 }
 Services.prefs.getBoolPref=getBool;lazy.RunState.isClosing=false;
});
await check('write rejection remains fulfilled without readback or completion notification',async()=>{
 const a=start(fixture(false));effects=[];const r=await save(a.s,'write-failure',true);assert.ok(r.fulfilled);assert.equal(r.complete,false);assert.equal(r.readback,undefined);assert.equal(effects.filter(e=>e.name==='writeError').length,1);assert.ok(!effects.some(e=>e.name==='observer'&&e.args[1]==='sessionstore-state-write-complete'));
});
for(const edge of ['lastSessionState','deferredInitialState'])for(const platform of ['macosx','win','linux'])
for(const shape of ['sparse-promote','open-promote','retain','absent','empty','open-no-closed'])
await check('optional arrays '+edge+' '+platform+' '+shape,async()=>{
 const priorPlatform=AppConstants.platform;
 try{
  AppConstants.platform=platform;
  const label='optional-'+edge+'-'+platform+'-'+shape,input=fixture(false);
  delete input.lastSessionState;delete input.deferredInitialState;
  const closed={spaces:[space('local')],tabs:[tab(),tab()],selected:2,identity:'CLOSED-'+label,
   closedId:91,closedAt:123,_shouldRestore:shape!=='retain',unknownWindow:{keep:[false,7,{history:'complete'}]}};
  const open={spaces:[space('local')],tabs:[tab()],selected:1,identity:'OPEN-'+label,unknownWindow:{keep:'open'}};
  const nested={maxSplitViewId:7,selectedWindow:1,unknownRoot:{keep:['sparse',false,42]}};
  if(['sparse-promote','open-promote','retain'].includes(shape))nested._closedWindows=[closed];
  if(['open-promote','open-no-closed'].includes(shape))nested.windows=[open];
  if(shape==='empty'){nested.windows=[];nested._closedWindows=[];}
  input[edge]=nested;
  // Freeze complete originals and expected policy output before any producer.
  const original=snap(nested),expected=snap(original);
  if(platform!=='macosx'&&shape.endsWith('promote')){
   const promoted=snap(closed);delete promoted._shouldRestore;
   expected.windows=[promoted,...(expected.windows||[])];expected._closedWindows=[];
  }
  fs.writeFileSync(out+'/'+label+'.original.json',JSON.stringify(original,null,2));
  fs.writeFileSync(out+'/'+label+'.expected.json',JSON.stringify(expected,null,2));
  const a=start(input);
  assert.equal(lazy.ZenSessionStore.canRestoreState(input),true,'actual recursive admission accepts sparse local history');
  assert.equal(lazy.ZenSessionStore.canSaveSession,true,'actual onFileRead completed admission');
  assert.deepEqual(input[edge],original,'onFileRead/init/initialize retain pre-producer original');
  pending(a.s,false);
  assert.deepEqual(snap(a.s.getCurrentState(true))[edge],original,'actual collected input retains complete original history');
  const r=await save(a.s,label);assert.ok(r.complete);
  assert.deepEqual(r.collector[edge],original,'captured collector before cleanup');
  assert.deepEqual(r.readback[edge],expected,'optional cleanup must not delete promoted public history');
  assert.deepEqual(r.residentAfter,r.residentBefore,'policy cannot mutate resident nested history');
  assert.equal(r.readback[edge].selectedWindow,original.selectedWindow,'existing selected-window policy unchanged');
  assert.equal('windows' in r.readback[edge],'windows' in expected);
  assert.equal('_closedWindows' in r.readback[edge],'_closedWindows' in expected);
  if(shape.endsWith('promote')){
   const actual=r.readback[edge],promoted=platform==='macosx'?actual._closedWindows[0]:actual.windows[0];
   assert.deepEqual(promoted.tabs,original._closedWindows[0].tabs,'all tabs, entries, history and unknown fields survive');
   assert.equal((actual.windows||[]).concat(actual._closedWindows||[]).filter(w=>w.identity===closed.identity).length,1,'history occurs once');
   assert.equal('_shouldRestore' in promoted,platform==='macosx','only existing non-mac promotion deletes flag');
  }
  return {edge,platform,shape,originalSha256:sha(JSON.stringify(original)),expectedSha256:sha(JSON.stringify(expected)),readbackSha256:sha(JSON.stringify(r.readback[edge]))};
 }finally{AppConstants.platform=priorPlatform;}
});
const result={runtime:process.version,bodies,classFields,events,count:events.length,passed:events.filter(e=>e.status==='PASS').length,writeNo,
 boundary:'actual source owners + actual PrivacyFilter; modeled DOM/services and captured JSON filesystem write/read only; NOT native codec/durability/browser qualification'};
fs.writeFileSync(out+'/RESULT.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exitCode=events.some(e=>e.status!=='PASS')?1:0;
'''

def constant(path,name):
    tree=ast.parse(path.read_text())
    return next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id==name for t in n.targets))

def once(text,old,new):
    assert text.count(old)==1,old
    return text.replace(old,new)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for key in ('source','store','saver','privacy','node','output'):
        parser.add_argument('--'+key,type=Path,required=True)
    args=parser.parse_args();out=args.output.resolve();out.mkdir(mode=0o700,parents=True,exist_ok=False)
    helper=Path(__file__).with_name('test_zen_saved_groups_preservation.py')
    retention=Path(__file__).with_name('test_zen_deferred_session_retention.py')
    js=constant(helper,'JS').split('const events=[];',1)[0]
    js=once(js,'process.argv.slice(1)','process.argv.slice(2)')
    js=once(js,"const bodies = [];","const out=process.argv[4];\nconst bodies = [];")
    js=once(js,"  bodies.push({signature,sha256:sha(raw),exposedSha256:sha(exposed)});","  const bodyFile='body-'+bodies.length+'.txt';fs.writeFileSync(out+'/'+bodyFile,raw);\n  bodies.push({signature,sha256:sha(raw),exposedSha256:sha(exposed),bodyFile});")
    js=once(js,"  '#initSession()', 'getCurrentState(', 'get savedGroups()',","  '#initSession()', '#initializeWindow(', '#initSplitViewIds(', '#migrateSplitViewIds(',\n  'getNextSplitViewId()', 'getBrowserState()', '#collectWindowData(', 'keepOnlyWorthSavingTabs(', '#shouldSaveTab(', 'getCurrentState(', 'get savedGroups()',")
    js=once(js,'function session(state) {','function session(state,initialize=true) {')
    js=once(js,'    _initSplitViewIds(){},_removeExplicitlyClosedTabs(){},_updateSessionStartTime(){},','    _removeExplicitlyClosedTabs(){},_updateSessionStartTime(){},')
    js=once(js,'_maxSplitViewId:7,','_maxSplitViewId:0,')
    js=once(js,'_deferredInitialState:state.deferredInitialState,','_deferredInitialState:null,')
    js=once(js,'  assert.equal(s._initSession(),state);','  Object.assign(s,classDefaults);\n  if(initialize) assert.equal(s._initSession(),state);')
    js+="\nstoreOwner.setDeferred=eval('({'+member(store,'set _deferredInitialState(').replace('set _deferredInitialState(', 'set value(')+'})').__lookupSetter__('value');\n"
    js+=ADAPTER
    lifecycle=constant(retention,'CASES').split('const events=[];',1)[0]
    lifecycle=once(lifecycle,"s._windows[id]={tabs:[],isTaskbarTab:kind==='taskbar',isZenUnsynced:kind==='unsynced'};","s._windows[id]={tabs:[],isPrivate:kind==='private',isPopup:kind==='popup',isTaskbarTab:kind==='taskbar',isZenUnsynced:kind==='unsynced'};")
    js+=lifecycle+ENDPOINTS+CASES
    sha=lambda b:hashlib.sha256(b).hexdigest()
    sources={'ZenSessionManager.mjs':args.source,'SessionStore.mjs':args.store,'SessionSaver.mjs':args.saver,'PrivacyFilter.mjs':args.privacy}
    bindings={str(p.resolve()):{'sha256':sha(p.read_bytes()),'bytes':len(p.read_bytes())} for p in [*sources.values(),helper,retention,Path(__file__)]}
    for name,p in sources.items():(out/name).write_bytes(p.read_bytes())
    (out/'probe.mjs').write_text(js)
    cmd=[str(args.node),str(out/'probe.mjs'),str(out/'ZenSessionManager.mjs'),str(out/'SessionStore.mjs'),str(out)]
    env=dict(os.environ,TMPDIR='/Users/kenkuang/.hermes/cache/scratch',PYTHONDONTWRITEBYTECODE='1');t=time.monotonic()
    r=subprocess.run(cmd,cwd=out,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=110)
    (out/'run.stdout').write_bytes(r.stdout);(out/'run.stderr').write_bytes(r.stderr)
    receipt={'command':cmd,'source':'source snapshots in owned output','exit_status':r.returncode,'scope':'extracted owners + captured JSON only','actual_wait_seconds':time.monotonic()-t,'timeout_seconds':110,'env':{'TMPDIR':env['TMPDIR'],'PYTHONDONTWRITEBYTECODE':'1'},'inputs':bindings,'oracle_sha256':sha(js.encode()),'input_stable':all(sha(Path(p).read_bytes())==v['sha256'] for p,v in bindings.items())}
    (out/'RUN.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt,indent=2))
    if (out/'RESULT.json').exists():
        data=json.loads((out/'RESULT.json').read_text());print(json.dumps({k:v for k,v in data.items() if k not in ('bodies',)},indent=2))
    else:print(r.stderr.decode())
    return r.returncode

if __name__=='__main__':
    raise SystemExit(main())
