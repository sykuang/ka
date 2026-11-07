#!/usr/bin/env python3
"""Bounded source-owner regression at a serialized JSON boundary, not MozLZ4.

Reuse the adjacent read-only fixture's extractor/platform edges, NOT its seeded
session owner or assertions. Fresh owners start deferred state at null. Actual
Zen admission, onFileRead, initSession, split-ID migration, initializeWindow,
LastSession and collector bodies execute; only external services are doubled.
"""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

CASES = r'''
const lastStart = store.indexOf('var LastSession = {');
assert.ok(lastStart >= 0);
const lastEnd = store.indexOf('\n};',lastStart)+3;
assert.ok(lastEnd > lastStart);
Object.defineProperties(LastSession,Object.getOwnPropertyDescriptors(
  eval('('+store.slice(lastStart+'var LastSession = '.length,lastEnd-1)+')')));
bodies.push({signature:'LastSession',sha256:sha(store.slice(lastStart,lastEnd))});
const NOTIFY_WINDOWS_RESTORED='windows-restored', NOTIFY_SINGLE_WINDOW_RESTORED='single-restored';
const NOTIFY_LAST_SESSION_CLEARED='last-cleared';
const DirtyWindows={clear(){},has(){return false;}};
Services.obs={notifyObservers:tick('observer')};
Services.telemetry={msSinceProcessStart:()=>0};
lazy.SessionSaver={updateLastSaveTime:tick('saveTime')};
lazy.SessionCookies.restore=tick('cookiesRestore');
const SessionStore={getNextSplitViewId(){return current.getNextSplitViewId();}};
let current;
function fresh(state) {
  zen();LastSession._state=null;
  const s=session(state,false);current=s;
  Object.assign(s,{_restoreCount:73,_restoreLastWindow:false,_shouldRestoreLastSession:false,
    _orderedBrowserWindows:[],_deferredAllWindowsRestored:{resolve:tick('resolve')},
    _globalState:{getState:()=>state.global,setFromState:tick('globalRestore')},
    _isCmdLineEmpty:()=>true,_isWindowLoaded:()=>true,
    _restoreWindows:tick('restoreWindows'),_sendWindowRestoredNotification:tick('windowRestored')});
  lazy.ZenSessionStore.onNewEmptySession=tick('empty');
  lazy.ZenSessionStore.restoreNewWindow=tick('newWindow');
  lazy.RunState={isStopped:true,isRunning:false,isQuitting:false,setRunning(){this.isStopped=false;this.isRunning=true;}};
  assert.equal(s._deferredInitialState,null,'fresh owner MUST NOT preseed persisted deferred state');
  return s;
}
function win(s,id,kind='normal') {
  s._windows[id]={tabs:[],isTaskbarTab:kind==='taskbar',isZenUnsynced:kind==='unsynced'};
  return {__SSi:id,isPrivate:kind==='private',toolbar:{visible:kind!=='popup'},
    document:{documentElement:{hasAttribute:name=>kind==='unsynced'&&name==='zen-unsynced-window'}}};
}
function persisted() {
  const root=document(),inner=document();delete inner.deferredInitialState;
  inner.windows[0]._closedTabs=[{state:tab(),closedId:45,custom:{keep:'closed-tab'}}];
  inner.windows[0].closedGroups=[group('closed-inner')];
  inner.windows[0].splitViews=[{id:7,tabs:['a','b'],unknown:'split'}];
  inner.maxSplitViewId=7;inner.lastSessionState.windows=[{spaces:[space('local')],tabs:[tab()]}];
  inner.lastSessionState.maxSplitViewId=7;
  root.maxSplitViewId=7;root.lastSessionState.maxSplitViewId=7;
  root.deferredInitialState=inner;return root;
}
function collect(s){return JSON.parse(JSON.stringify(s.getCurrentState(true)));}
function noUnsafe(){assert.deepEqual(effects.filter(e=>['restoreWindows','globalRestore','cookiesRestore'].includes(e.name)),[]);}
const events=[];
function check(name,run){effects=[];try{run();events.push({name,status:'PASS'});}
  catch(e){events.push({name,status:e.code==='ERR_ASSERTION'?'FAIL':'ERROR',error:e.stack});}}
for(const kind of ['normal','private','taskbar','unsynced']) check('fresh serialized nested retention '+kind,()=>{
  const before=persisted(),input=JSON.parse(JSON.stringify(before));
  const s=fresh(input),read=lazy.ZenSessionStore.onFileRead(input);
  assert.deepEqual(read,before,'normal Zen read preserves complete inert document');
  const initial=s._initSession();
  assert.equal(initial,input,'outer initial state is not swapped');
  assert.deepEqual(input,before,'init keeps unrelated root and original nested fields');
  assert.equal(s._deferredInitialState,input.deferredInitialState,'init adopts persisted owner from null');
  const target=win(s,'first',kind);effects=[];s._initializeWindow(target,initial);
  assert.deepEqual(s._deferredInitialState,before.deferredInitialState,'first window must not overwrite nested payload');
  assert.deepEqual(collect(s).deferredInitialState,before.deferredInitialState,'actual collector serializes complete retained payload');
  assert.deepEqual(s._savedGroups,before.savedGroups);
  if(kind==='normal') {
    assert.deepEqual(effects.find(e=>e.name==='restoreWindows').args[1],before,'normal first restores OUTER state as before');
    assert.equal(effects.filter(e=>e.name==='cookiesRestore').length,1);
  } else noUnsafe();
});
check('private-first without nested payload retains original root fallback',()=>{
  const input=persisted();delete input.deferredInitialState;const before=structuredClone(input);
  const s=fresh(input),initial=s._initSession();assert.equal(s._deferredInitialState,null);
  effects=[];s._initializeWindow(win(s,'private','private'),initial);
  assert.equal(s._deferredInitialState,input);assert.deepEqual(collect(s).deferredInitialState,before);noUnsafe();
});
check('repeated serialize fresh init private first does not nest or lose history',()=>{
  let input=persisted();const original=structuredClone(input.deferredInitialState);
  for(let cycle=0;cycle<4;cycle++) {
    input=JSON.parse(JSON.stringify(input));const s=fresh(input),initial=s._initSession();
    s._initializeWindow(win(s,'private','private'),initial);
    input=collect(s);assert.deepEqual(input.deferredInitialState,original,'cycle '+cycle);
    assert.ok(!('deferredInitialState' in input.deferredInitialState),'no per-cycle wrapper');
  }
});
for(const location of ['root','payload']) for(const invalid of ['unknown-space','foreign-profile','unknown-version'])
check('init admission zero effects '+location+' '+invalid,()=>{
  const input=persisted(),bad=location==='root'?input:input.deferredInitialState;
  if(invalid==='unknown-space')bad.windows[0].tabs[0].zenWorkspace='unknown';
  if(invalid==='foreign-profile')bad.windows[0].spaces[0].geckoProfileReference.persistentDescriptor='fixture-foreign-B';
  if(invalid==='unknown-version')bad.geckoProfileBindingVersion=999;
  const before=structuredClone(input),s=fresh(input);effects=[];
  assert.equal(s._initSession(),null);assert.deepEqual(input,before);
  assert.equal(s._deferredInitialState,null);assert.equal(s._restoreCount,73);
  assert.deepEqual(s._savedGroups,[]);assert.equal(LastSession._state,null);assert.deepEqual(effects,[]);
});
check('eligible normal consumer restores local payload once only',()=>{
  const input=persisted(),original=structuredClone(input.deferredInitialState),s=fresh(input);
  s._initializeWindow(win(s,'private','private'),s._initSession());effects=[];
  s._initializeWindow(win(s,'consumer'));
  assert.equal(s._deferredInitialState,null);assert.equal(s._restoreCount,original.windows.length);
  const restores=effects.filter(e=>e.name==='restoreWindows');assert.equal(restores.length,1);
  assert.deepEqual(restores[0].args[1],original);assert.equal(restores[0].args[2].restoreSource,'deferred_initial_state');
  assert.equal(effects.filter(e=>e.name==='globalRestore').length,1);
  assert.equal(effects.filter(e=>e.name==='cookiesRestore').length,0,'existing deferred route does not restore cookies');
  s._initializeWindow(win(s,'later'));assert.equal(effects.filter(e=>e.name==='restoreWindows').length,1);
  assert.ok(!('deferredInitialState' in collect(s)));
});
for(const invalid of ['unknown-space','foreign-profile','unknown-version']) check('deferred consumer refusal retains payload and flags '+invalid,()=>{
  const input=persisted(),s=fresh(input);s._initializeWindow(win(s,'private','private'),s._initSession());
  const payload=s._deferredInitialState;assert.ok(payload,'retention prerequisite');
  if(invalid==='unknown-space')payload.windows[0].tabs[0].zenWorkspace='unknown';
  if(invalid==='foreign-profile')payload.windows[0].spaces[0].geckoProfileReference.persistentDescriptor='fixture-foreign-B';
  if(invalid==='unknown-version')payload.geckoProfileBindingVersion=999;
  const before=structuredClone(payload),count=s._restoreCount;effects=[];
  s._initializeWindow(win(s,'consumer'));
  assert.equal(s._deferredInitialState,payload);assert.deepEqual(payload,before);
  assert.equal(s._restoreCount,count);assert.equal(s._restoreLastWindow,false);assert.equal(s._shouldRestoreLastSession,false);
  noUnsafe();assert.deepEqual(effects.map(e=>e.name),['empty','windowRestored','observer']);
  assert.deepEqual(collect(s).deferredInitialState,before);
});
check('existing willRestore false consumer clears without restore',()=>{
  const input=persisted(),s=fresh(input);s._initializeWindow(win(s,'private','private'),s._initSession());
  startup.willRestore=()=>false;effects=[];s._initializeWindow(win(s,'consumer'));
  assert.equal(s._deferredInitialState,null);assert.equal(s._restoreCount,73);noUnsafe();
});
check('public browser-state discard does not mutate retained owner',()=>{
  const input=persisted(),s=fresh(input);s._initSession();const original=structuredClone(input.deferredInitialState);
  const publicState=JSON.parse(s.getBrowserState());assert.ok(!('deferredInitialState' in publicState));
  assert.ok(!('lastSessionState' in publicState));assert.deepEqual(s._deferredInitialState,original);
  s.setDeferred(null);assert.ok(!('deferredInitialState' in collect(s)),'explicit setter reset still works');
});
check('existing split ID normalization runs before field adoption',()=>{
  const input=persisted(),inner=input.deferredInitialState;delete inner.maxSplitViewId;
  inner.windows[0].tabs[0].splitViewId='legacy';inner.windows[0].splitViews[0].id='legacy';
  const expected=structuredClone(inner),s=fresh(input);s._initSession();
  assert.ok(s._deferredInitialState,'retention prerequisite');
  const normalized=inner.windows[0].tabs[0].splitViewId;assert.equal(typeof normalized,'number');
  expected.windows[0].tabs[0].splitViewId=normalized;expected.windows[0].splitViews[0].id=normalized;
  expected.maxSplitViewId=inner.maxSplitViewId;
  assert.deepEqual(s._deferredInitialState,expected,'ONLY existing split ID/maxSplitViewId normalization allowed');
  assert.equal(inner.windows[0].splitViews[0].id,normalized);
});
console.log(JSON.stringify({runtime:process.version,evidence:'actual extracted owners; serialized JSON boundary only; no native, codec, browser or startup qualification',
  bodies,events,count:events.length,passed:events.filter(e=>e.status==='PASS').length},null,2));
process.exitCode=events.some(e=>e.status!=='PASS')?1:0;
'''


def replace_once(text, old, new):
    assert text.count(old) == 1, 'fixture adapter anchor drift: ' + old
    return text.replace(old, new)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'store', 'node'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    helper = Path(__file__).with_name('test_zen_saved_groups_preservation.py')
    tree = ast.parse(helper.read_text())
    js = next(ast.literal_eval(n.value) for n in tree.body
              if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'JS' for t in n.targets))
    js = js.split('const events=[];', 1)[0]
    js = replace_once(js, "  '#initSession()', 'getCurrentState(', 'get savedGroups()',",
                      "  '#initSession()', '#initializeWindow(', '#initSplitViewIds(', '#migrateSplitViewIds(',\n"
                      "  'getNextSplitViewId()', 'getBrowserState()', 'getCurrentState(', 'get savedGroups()',")
    js = replace_once(js, 'function session(state) {', 'function session(state, initialize=true) {')
    js = replace_once(js, '    _initSplitViewIds(){},_removeExplicitlyClosedTabs(){},_updateSessionStartTime(){},',
                      '    _removeExplicitlyClosedTabs(){},_updateSessionStartTime(){},')
    js = replace_once(js, '_maxSplitViewId:7,', '_maxSplitViewId:0,')
    js = replace_once(js, '_deferredInitialState:state.deferredInitialState,', '_deferredInitialState:null,')
    js = replace_once(js, '  assert.equal(s._initSession(),state);', '  if(initialize) assert.equal(s._initSession(),state);')
    # The setter's public name collides with mechanically exposed #private state;
    # expose only that public entry name, retaining the complete original body.
    js += "\nstoreOwner.setDeferred=eval('({'+member(store,'set _deferredInitialState(').replace('set _deferredInitialState(', 'set value(')+'})').__lookupSetter__('value');\n"
    js += CASES
    env = dict(os.environ, TMPDIR='/Users/kenkuang/.hermes/cache/scratch', PYTHONDONTWRITEBYTECODE='1')
    bindings = {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in (args.source, args.store, helper, Path(__file__))}
    print(json.dumps({'python': sys.version, 'inputs': bindings,
                      'adapter': 'private identifiers mechanically exposed; public deferred setter entry renamed to avoid collision; inherited fixture owner starts NULL'}, sort_keys=True), flush=True)
    result = subprocess.run([str(args.node), '--input-type=module', '-e', js,
                             str(args.source), str(args.store)], env=env, timeout=90, check=False)
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
