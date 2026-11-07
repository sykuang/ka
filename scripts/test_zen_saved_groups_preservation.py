#!/usr/bin/env python3
"""Offline extracted-owner regression; no Gecko, native profile or codec claim.

Only private-member spelling is exposed mechanically. Platform file identity,
startup services, live-window collection and DOM/telemetry endpoints are doubles.
The real onFileRead, admission, initSession, getCurrentState and group-open
owners execute; approval decisions are never replaced with canned booleans.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

JS = r'''
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const [sourcePath, storePath] = process.argv.slice(1);
const source = fs.readFileSync(sourcePath, 'utf8');
const store = fs.readFileSync(storePath, 'utf8');
const sha = x => createHash('sha256').update(x).digest('hex');
const bodies = [];
function member(text, signature) {
  const start = text.indexOf('  '+signature);
  assert.ok(start >= 0, 'missing owner '+signature);
  assert.equal(text.indexOf('  '+signature,start+1),-1,'ambiguous owner '+signature);
  const end = text.indexOf('\n  }', start);
  assert.ok(end > start, 'missing member boundary');
  const raw = text.slice(start,end+4);
  const exposed = raw.replace(/#([A-Za-z]\w*)/g,'_$1');
  bodies.push({signature,sha256:sha(raw),exposedSha256:sha(exposed)});
  return exposed;
}
const zenText = [
  'onFileRead(', 'canRestoreState(', 'canRestoreWindow(',
  'isLocalProfileReference(', 'getCurrentProfileReference(',
  '#projectState(', '#isSyncingWindow(', '#isWindowSaveable(',
  '#isBlankTabData(', 'getClonedSpaces(', '#runStateMigration(',
  'get canSaveSession()', 'get #shouldRestoreOnlyPinned()',
].map(s=>member(source,s)).join(',\n');
const storeText = [
  '#initSession()', 'getCurrentState(', 'get savedGroups()',
  'getSavedTabGroup(', 'getSavedTabGroups()', 'openSavedTabGroup(',
  '#createTabsForSavedOrClosedTabGroup(', 'forgetSavedTabGroup(',
  'undoCloseTabGroup(',
].map(s=>member(store,s)).join(',\n');
const profile = {persistentDescriptor:'fixture-local-A'};
const Ci = {nsIFile:'inert-file-identity'};
const Cc = {'@mozilla.org/file/local;1':{createInstance(){return {
  persistentDescriptor:'',equals(other){return this.persistentDescriptor===other.persistentDescriptor;}
};}}};
let sync = true, pinnedOnly = false, allowUnsynced = true, startup;
const Services = {
  dirsvc:{get(key){assert.equal(key,'ProfD');return profile;}},
  appinfo:{platformBuildID:'fixture-build'},
  prefs:{getStringPref(){return 'fixture-build';},getIntPref(){return pinnedOnly?1:3;},
    getBoolPref(key,d){return key==='zen.session-store.restore-unsynced-windows'?allowUnsynced:d;},
    setStringPref(){throw Error('unexpected preference write');}},
};
const Cu = {cloneInto:structuredClone};
const BROWSER_STARTUP_RESUME_SESSION = 3, LAST_BUILD_ID_PREF = 'fixture-build-pref';
const FORMAT_VERSION = 1, AppConstants = {platform:'macosx'};
let effects;
const tick = name => (...args) => {effects.push({name,args});};
const metric = new Proxy(()=>{}, {get(_,key){if(key==='start')return ()=>1;
  if(key==='stopAndAccumulate')return ()=>{};return metric;},
  apply(_,__,args){effects.push({name:'telemetry',args});}});
const Glean = metric;
const PrivateBrowsingUtils = {isWindowPrivate:win=>!!win.isPrivate};
const TabMetrics = {METRIC_SOURCE:{UNKNOWN:'unknown',SUGGEST:'suggest',TAB_OVERFLOW_MENU:'overflow',RECENT_TABS:'recent'},
  METRIC_TABS_LAYOUT:{VERTICAL:'vertical',HORIZONTAL:'horizontal'},METRIC_REOPEN_TYPE:{SAVED:'saved',DELETED:'deleted'}};
const Components = {Exception:message=>new Error(message)}, Cr = {NS_ERROR_INVALID_ARG:1};
const LastSession = {canRestore:false,setState(){},getState(){throw Error('unexpected last-session read');}};
const lazy = {
  get gWindowSyncEnabled(){return sync;},get SessionStartup(){return startup;},
  PrivateBrowsingUtils:{permanentPrivateBrowsing:false},
  RunState:{isQuitting:false,isRunning:false},SessionCookies:{collect(){return [{fixture:'cookie'}];}},
  DevToolsShim:{saveDevToolsSession(){}},
};
// These evals contain only extracted owner members, not the imported module.
const zenOwner = eval('({'+zenText+'})');
const storeOwner = eval('({'+storeText+'})');
function zen(options={}) {
  const z = Object.create(zenOwner);
  Object.assign(z,{_fileReadComplete:true,_profileBindingBlocked:false,
    _startupAdmissionComplete:false,_independentProjection:null,_independentActivation:null,
    _legacyLocalCatalog:false,_sidebarWithoutCloning:{spaces:[space('local')]},
    log(){},...options});
  lazy.ZenSessionStore=z;
  return z;
}
function space(uuid, owner='fixture-local-A') {
  return {uuid,name:uuid,geckoProfileReference:{version:1,persistentDescriptor:owner}};
}
function tab(workspace='local') {
  return {zenWorkspace:workspace,entries:[{url:'https://fixture.invalid/first',title:'first',custom:{keep:1}},
    {url:'https://fixture.invalid/second',title:'second',scroll:'7,11'}],index:2,
    extData:{addon:'opaque'},customTab:{nested:[false,null,17]}};
}
function group(id,workspace='local') {
  return {id,name:'saved '+id,color:'blue',collapsed:true,closedId:81,windowClosedId:91,
    splitViews:[{id:7,tabs:['one','two'],custom:'split'}],extensions:{opaque:[1,{keep:true}]},
    tabs:[{state:tab(workspace),closedAt:123,closedId:82,pos:4,customClosed:{keep:'closed'}}],
    unknownGroup:{nested:['do not discard']}};
}
function document() {
  return {version:['sessionrestore',1],geckoProfileBindingVersion:1,
    windows:[{spaces:[space('local')],tabs:[{...tab(),pinned:true}],customWindow:{keep:1}}],
    _closedWindows:[{spaces:[space('local')],tabs:[tab()],closedId:99}],
    savedGroups:[group('local-saved'),group('inactive-unknown','unknown-space'),group('inactive-foreign','foreign-space')],
    global:{opaque:'global'},session:{startTime:100,recentCrashes:0},
    lastSessionState:{windows:[],savedGroups:[group('last','unknown-space')],unknown:'last'},
    deferredInitialState:{windows:[],savedGroups:[group('deferred','foreign-space')],unknown:'deferred'},
    unknownRoot:{keep:['whole',false,42]}};
}
function session(state) {
  startup={willRestore:()=>true,willRestoreAsCrashed:()=>false,state,sessionType:1,DEFER_SESSION:2,RESUME_SESSION:3};
  const s=Object.create(storeOwner);
  Object.assign(s,{_savedGroups:[],_log:{debug(){},error(e){throw e;}},
    _initSplitViewIds(){},_removeExplicitlyClosedTabs(){},_updateSessionStartTime(){},
    _prefBranch:{getBoolPref(){return false;}},_recentCrashes:0,_sessionStartTime:100,
    _handleClosedWindows:async()=>{},_notifyOfClosedObjectsChange:tick('notifyClosed'),
    _notifyOfSavedTabGroupsChange:tick('notifySaved'),_removeClosedTabData:tick('removeClosedTabData'),
    _getTopWindow:()=>null,_windows:Object.fromEntries(state.windows.map((w,i)=>[i,w])),
    _statesToRestore:{},_closedWindows:state._closedWindows||[],_activeWindowSSiCache:'',
    _maxSplitViewId:7,_globalState:{getState:()=>state.global},_deferredInitialState:state.deferredInitialState,
    _restoreTabs:tick('restoreTabs'),_getClosedWindowDataByClosedId:()=>({closedId:91,marker:'untouched'}),
    _removeSavedTabGroupFromClosedWindow:tick('removeGroupFromClosedWindow')});
  assert.equal(s._initSession(),state);
  return s;
}
function target(spaces=[space('local')]) {
  const group={select:tick('select')};
  return {__SSi:'fixture-window',marker:{untouched:[1,2]},gZenWorkspaces:{getWorkspaces:()=>spaces},
    gBrowser:{tabContainer:{verticalMode:false},createTabsForSessionRestore(...args){
      effects.push({name:'createTabs',args});return [{group}];}}};
}
const events=[];
function check(name,run){effects=[];try{run();events.push({name,status:'PASS'});}
  catch(e){events.push({name,status:e.code==='ERR_ASSERTION'?'FAIL':'ERROR',error:e.stack});}}
for(const enabled of [false,true]) check('normal read/init/collector full retention sync='+enabled,()=>{
  sync=enabled;pinnedOnly=false;allowUnsynced=true;
  const before=document(), input=structuredClone(before), z=zen();
  const originalGroups=input.savedGroups, firstGroup=input.savedGroups[0];
  const read=z.onFileRead(input);
  assert.deepEqual(read.savedGroups,before.savedGroups,'savedGroups must survive actual onFileRead intact');
  assert.equal(read,input);assert.equal(read.savedGroups,originalGroups);assert.equal(read.savedGroups[0],firstGroup);
  assert.deepEqual(read,before,'unrelated complete root must survive');assert.equal(z.canSaveSession,true);
  const s=session(read);assert.equal(s.savedGroups,read.savedGroups,'init adopts original live collection');
  const collected=s.getCurrentState(true);
  assert.deepEqual(JSON.parse(JSON.stringify(collected)).savedGroups,before.savedGroups,'collector/save JSON retains inactive history and unknown fields');
  const clone=s.getSavedTabGroups();clone[0].unknownGroup.nested.push('detached');
  assert.deepEqual(s.savedGroups,before.savedGroups,'public list getter clones');
});
check('independent projection preserves history without changing caller root',()=>{
  sync=true;const input=document(), before=structuredClone(input);
  const projection={spaces:[{...space('local'),name:'projected name'}],marker:{version:1}};
  const z=zen({_independentProjection:projection});const read=z.onFileRead(input);
  assert.deepEqual(read.savedGroups,before.savedGroups);assert.notEqual(read,input);assert.deepEqual(input,before);
  assert.equal(read.windows[0].spaces[0].name,'projected name');assert.deepEqual(read._closedWindows,before._closedWindows);
  assert.deepEqual(session(read).getCurrentState().savedGroups,before.savedGroups);assert.equal(z.canSaveSession,true);
});
for(const blocked of ['not-read','binding-blocked','foreign-live','unresolved-projection']) check('admission refusal '+blocked,()=>{
  sync=true;const input=document();let options={};
  if(blocked==='not-read')options._fileReadComplete=false;
  if(blocked==='binding-blocked')options._profileBindingBlocked=true;
  if(blocked==='foreign-live')input.windows[0].spaces=[space('local','fixture-foreign-B')];
  if(blocked==='unresolved-projection')options._independentProjection={spaces:[space('other')],marker:{version:1}};
  const before=structuredClone(input),z=zen(options);assert.equal(z.onFileRead(input),input);
  assert.deepEqual(input,before);assert.equal(z.canSaveSession,false);assert.deepEqual(effects,[]);
});
check('known-space enrichment and pinned-only policy retain saved groups',()=>{
  sync=false;pinnedOnly=true;const input=document();delete input.windows[0].spaces[0].geckoProfileReference;
  input.windows[0].tabs.push({...tab(),pinned:false});const groups=structuredClone(input.savedGroups);
  const z=zen();const read=z.onFileRead(input);assert.equal(read.windows[0].tabs.length,1);
  assert.deepEqual(read.windows[0].spaces,[space('local')]);assert.deepEqual(read.savedGroups,groups);
  assert.equal(z.canSaveSession,true);pinnedOnly=false;
});
check('migration actual owner retains saved group history',()=>{
  sync=false;const input=document(),before=structuredClone(input.savedGroups);
  const z=zen({_shouldRunMigration:true,_migrationData:{spaces:[space('local')],pins:[]}});
  assert.deepEqual(z.onFileRead(input).savedGroups,before);assert.equal(z.canSaveSession,true);
});
for(const variant of ['unknown-tab','foreign-tab','foreign-target']) check('open refusal zero consumption '+variant,()=>{
  sync=true;zen();const input=document();const s=session(input);
  const id='local-saved';const g=s.getSavedTabGroup(id);
  if(variant==='unknown-tab')g.tabs[0].state.zenWorkspace='unknown-space';
  if(variant==='foreign-tab')g.tabs[0].state.zenWorkspace='foreign-space';
  const win=target(variant==='foreign-target'?[space('local','fixture-foreign-B')]:[space('local')]);
  const groupsBefore=structuredClone(s.savedGroups),targetBefore=JSON.stringify(win);
  effects=[];assert.equal(s.openSavedTabGroup(id,win,{source:'suggest'}),undefined);
  assert.deepEqual(s.savedGroups,groupsBefore);assert.equal(JSON.stringify(win),targetBefore);
  assert.deepEqual(effects,[],'no create/restore/forget/closed-removal/select/telemetry');
  assert.deepEqual(s.getCurrentState().savedGroups,groupsBefore,'refused groups remain saveable');
});
check('local open succeeds through real helper, admission and forget',()=>{
  sync=true;zen();const s=session(document()),win=target(),id='local-saved';
  const originalIds=s.savedGroups.map(g=>g.id),originalGroup=structuredClone(s.getSavedTabGroup(id));
  effects=[];assert.ok(s.openSavedTabGroup(id,win,{source:'suggest'}));
  const names=effects.map(e=>e.name);
  for(const name of ['createTabs','restoreTabs','removeGroupFromClosedWindow','select','removeClosedTabData'])
    assert.equal(names.filter(n=>n===name).length,1,name+' exactly once');
  assert.equal(names.filter(n=>n==='telemetry').length,2);
  const created=effects.find(e=>e.name==='createTabs').args;
  assert.deepEqual(created[2],originalGroup.tabs.map(t=>t.state));assert.deepEqual(created[4],originalGroup.splitViews);
  assert.deepEqual(s.savedGroups.map(g=>g.id),originalIds.filter(x=>x!==id),'live store consumes only requested immutable ID');
});
check('explicit forget still removes inactive saved history',()=>{
  sync=true;zen();const s=session(document()),id='inactive-unknown',ids=s.savedGroups.map(g=>g.id);
  s.forgetSavedTabGroup(id);assert.deepEqual(s.savedGroups.map(g=>g.id),ids.filter(x=>x!==id));
});
check('undo-close sibling uses same actual refusal guard',()=>{
  sync=true;zen();const s=session(document()),g=group('closed','unknown-space');
  const closed={isPrivate:false,lastClosedTabGroupId:'closed',closedGroups:[g]};
  s._resolveClosedDataSource=()=>closed;s._getClosedTabGroup=()=>g;s.forgetClosedTabGroup= tick('forgetClosed');
  const before=structuredClone(closed),win=target(),targetBefore=JSON.stringify(win);effects=[];
  assert.equal(s.undoCloseTabGroup({},'closed',win),undefined);assert.deepEqual(closed,before);
  assert.equal(JSON.stringify(win),targetBefore);assert.deepEqual(effects,[]);
});
console.log(JSON.stringify({runtime:process.version,evidence:'extracted JS owners with platform doubles; NOT native/cold/codec qualification',
  bodies,events,count:events.length,passed:events.filter(e=>e.status==='PASS').length},null,2));
process.exitCode=events.some(e=>e.status!=='PASS')?1:0;
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'store', 'node'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    env = dict(os.environ, TMPDIR='/Users/kenkuang/.hermes/cache/scratch',
               PYTHONDONTWRITEBYTECODE='1')
    bindings = {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in (args.source, args.store, Path(__file__))}
    print(json.dumps({'python': sys.version, 'inputs': bindings,
                      'adapter': 'private identifiers #name -> _name only'}, sort_keys=True), flush=True)
    command = [str(args.node), '--input-type=module', '-e', JS,
               str(args.source), str(args.store)]
    result = subprocess.run(command, env=env, timeout=90, check=False)
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
