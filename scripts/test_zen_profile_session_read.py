#!/usr/bin/env python3
"""Source-only SessionFile contract. No Gecko/MozLZ4 execution.

Run with --source, --store, --fixtures (a fresh private projects directory),
--node. The IOUtils adapter reads real UTF-8 fixture files; compressed-name
fixtures are decoded-text stand-ins, NOT native compressed-codec evidence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

JS = r'''
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
const [sourcePath, storePath, fixtureRoot, zenSourcePath, ioSourcePath] = process.argv.slice(1);
const source = await fs.readFile(sourcePath, 'utf8');
const store = await fs.readFile(storePath, 'utf8');
// Source-calibrated boundary semantics; NOT execution/translation of C++.
const ioSource = await fs.readFile(ioSourcePath, 'utf8');
const ownerRead = ioSource.slice(ioSource.indexOf('Result<IOUtils::JsBuffer, IOUtils::IOError> IOUtils::ReadSync('),ioSource.indexOf('Result<IOUtils::JsBuffer, IOUtils::IOError> IOUtils::ReadUTF8Sync('));
const completeOwner = ownerRead.includes('const bool aRequireCompleteRead') &&
  ownerRead.includes('aFile->IsFile(&isFile)') && ownerRead.includes('stream->GetFileDescriptor(&fd)') &&
  ownerRead.includes('PR_GetOpenFileInfo64(fd, &info)') && ownerRead.includes('info.type != PR_FILE_FILE') &&
  /if \(aRequireCompleteRead \|\| !aExpectedSHA256.IsNull\(\)\) \{\s*if \(buffer.BeginReading\(\).Length\(\) != bufSize\)/.test(ownerRead);
assert.ok(ownerRead.includes('stream->GetSize(&rawStreamSize)') && ownerRead.includes('buffer.SetLength(totalRead)'));
console.log(JSON.stringify({ownerCalibration:{sourceSHA256:createHash('sha256').update(ioSource).digest('hex'),completeOwner,
  scope:'source-bound metadata/stream model; real regular owned files for growth/truncation; explicit other-kind MODEL only; no special/native FS probe'}}));
const signature = '  isFormatVersionCompatible(version) {';
const start = store.indexOf(signature);
assert.ok(start >= 0);
const end = store.indexOf('\n  }', start) + 4;
const versionBody = store.slice(start, end);
const format = store.match(/^const FORMAT_VERSION = .*;$/m)[0];
const events = [];
async function check(name, run) {
  try { await run(); events.push({name, status:'PASS'}); }
  catch (error) { events.push({name, status:'FAIL', error: error.stack}); }
}
const document = {
  version:['sessionrestore',1], windows:[{tabs:[{image:7,entries:[{url:'https://fixture.invalid/'}]}]}],
  _closedWindows:[{tabs:[],_closedTabs:[{image:7,state:{entries:[{url:'about:blank'}]}}]}],
  savedGroups:[{id:'saved',tabs:[{entries:[{url:'about:blank'}]}]}],
  deferredInitialState:{windows:[{tabs:[],custom:'deferred'}]},
  lastSessionState:{windows:[{tabs:[]}],custom:'last'},
  unknown:{nested:['kept',false,42]}, _cachedObjs:[[7,'fixture-image']]
};
const text = JSON.stringify(document);
let serial = 0;
async function fixture() {
  const root = path.join(fixtureRoot, String(++serial));
  await fs.mkdir(root, {mode:0o700});
  await fs.mkdir(path.join(root,'sessionstore-backups'), {mode:0o700});
  return root;
}
async function put(root, leaf, value=text) {
  await fs.writeFile(path.join(root,leaf),value,{mode:0o600});
}
async function load(root, independent=false) {
  const calls = {reads:[],decodes:[],crypto:[],parses:0,lazy:[],telemetry:[],logs:[],prefs:[],zen:0,writes:[],init:[],blocks:[],notifications:[]};
  const faults = new Map();
  const physical = new Map();
  const allowedRoots = new Set([root]);
  let upgrade = '';
  let hold = null;
  let beforeDecode = null;
  let cryptoError = null;
  let cryptoStage = 'createInstance';
  const nativeDOM = class extends DOMException {static isInstance(x) {return x instanceof DOMException;}};
  const version = vm.runInNewContext(`${format}\n({${versionBody}}).isFormatVersionCompatible`);
  const logger = Object.fromEntries(['error','warn','debug'].map(k=>[k,(...x)=>calls.logs.push([k,...x])]));
  const writer = {init(...args){calls.init.push(args);},async write(...args){calls.writes.push(args);return {result:{upgradeBackup:false},telemetry:{}};},async wipe(){calls.writes.push(['wipe']);}};
  const runState = {isClosed:false,isClosing:false,isRunning:true,setClosed(){this.isClosed=true;}};
  const adapters = {sessionStoreLogger:logger,SessionStore:{isFormatVersionCompatible:version,willAutoRestore:true},SessionWriter:writer,RunState:runState,ZenSessionStore:{canSaveSession:true,async readFile(){calls.zen++;}}};
  const forbidden = name => {throw new Error('Forbidden platform access: '+name);};
  const lazy = new Proxy({}, {get(_,name){calls.lazy.push(name);if(independent) return forbidden(name);assert.ok(name in adapters);return adapters[name];}});
  const metric = new Proxy(()=>{}, {get(_,key){return new Proxy(()=>{}, {get(){return metric;},apply(_,__,args){calls.telemetry.push([key,...args]);}});},apply(_,__,args){calls.telemetry.push(args);}});
  const services = new Proxy({}, {get(_,name){if(independent)return forbidden('Services.'+name);return {prefs:{getCharPref(k){calls.prefs.push(k);return upgrade;},getIntPref(k,d){calls.prefs.push(k);return d;},setCharPref(){forbidden('pref write');}},appinfo:{platformBuildID:'next'},obs:{notifyObservers(...args){calls.notifications.push(args);}}}[name];}});
  // reads records candidate-selection I/O (raw strict, UTF8 ordinary/baseline).
  // decodes records every UTF8 call separately, including the bound second read.
  async function bytesFromOwnedFile(p, options) {
    assert.ok([...allowedRoots].some(root=>p.startsWith(root+path.sep)), 'root isolation: '+p);
    if(hold) {const f=hold;hold=null;await f();}
    if(faults.has(p))throw faults.get(p);
    try {
      const model=physical.get(p);
      if(model && completeOwner && options?.requireCompleteRead && model.pathKind==='other')
        throw new nativeDOM('nonregular path (explicit metadata MODEL)','InvalidAccessError');
      if(model?.reset)await model.reset();
      const initialSize=model?.size ?? (await fs.stat(p)).size;
      if(model?.afterStat)await model.afterStat();
      if(model && completeOwner && options?.requireCompleteRead && model.fdKind==='other')
        throw new nativeDOM('nonregular opened descriptor (explicit metadata MODEL)','InvalidAccessError');
      const payload=await fs.readFile(p);
      // Actual owner sizes the buffer before reading; ordinary no-digest reads
      // can return a short read or initial-size prefix. Models never claim that
      // an ordinary backing file is physically a special file.
      const bytes=model?payload.subarray(0,initialSize):payload;
      if((options?.expectedSHA256 != null || (completeOwner && options?.requireCompleteRead)) &&
          (bytes.length!==initialSize || payload.length!==initialSize || (await fs.stat(p)).size!==initialSize))
        throw new nativeDOM('incomplete read/EOF/size change (source-calibrated boundary)','NotReadableError');
      if(options?.maxFileBytes != null && bytes.length>options.maxFileBytes)
        throw new nativeDOM('raw cap (Node adapter, not Gecko allocation)','NotReadableError');
      return bytes;
    } catch(e) {if(e.code==='ENOENT')throw new nativeDOM(e.message,'NotFoundError');throw e;}
  }
  const hashInterface = Object.freeze({SHA256:4}); // actual nsICryptoHash.idl
  const Ci = {nsICryptoHash:hashInterface};
  const Cc = new Proxy({}, {get(_,contract) {
    assert.equal(contract,'@mozilla.org/security/hash;1');
    return {createInstance(iid) {
      assert.equal(iid,hashInterface); calls.crypto.push('createInstance');
      const fail = stage => {if(cryptoError && cryptoStage===stage)throw cryptoError;};
      fail('createInstance');
      let hash;
      return {init(algorithm) {assert.equal(algorithm,4);calls.crypto.push('init');fail('init');hash=createHash('sha256');},
        update(bytes,len) {assert.ok(bytes instanceof Uint8Array);assert.equal(len,bytes.length);calls.crypto.push({updateLength:len});fail('update');hash.update(bytes);},
        finish(ascii) {assert.equal(ascii,false);calls.crypto.push('finish');fail('finish');return hash.digest().toString('latin1');}};
    }};
  }});
  const ctx = vm.createContext({DOMException:nativeDOM,Date,Services:services,Cc,Ci,Uint8Array,
    JSON:{parse(s){calls.parses++;return JSON.parse(s);},stringify:JSON.stringify},
    PathUtils:{join(...parts){assert.ok(path.isAbsolute(parts[0]));return path.join(...parts);},parent(p){assert.ok(path.isAbsolute(p));return p==='/'?null:path.dirname(p);},isAbsolute:path.isAbsolute,get profileDir(){if(independent)return forbidden('ProfD');return root;}},
    Glean:new Proxy({}, {get(){if(independent)return forbidden('Glean');return metric;}}),
    IOUtils:{async read(p,options) {
      calls.reads.push({method:'read',path:p,options:{...options}});
      assert.ok(Object.keys(options).every(k=>['maxFileBytes','requireCompleteRead','expectedSHA256'].includes(k)));
      if(options.expectedSHA256 != null)assert.match(options.expectedSHA256,/^[0-9a-f]{64}$/);
      const bytes=await bytesFromOwnedFile(p,options);
      if(options?.expectedSHA256 != null && createHash('sha256').update(bytes).digest('hex')!==options.expectedSHA256)
        throw new nativeDOM('SHA-256 mismatch (raw boundary)','NotReadableError');
      return Uint8Array.from(bytes);
    },async readUTF8(p,options) {
      calls.decodes.push({path:p,options:{...options}});
      if(options?.expectedSHA256 === undefined)calls.reads.push({method:'readUTF8',path:p,options:{...options}});
      if(beforeDecode) {const f=beforeDecode;beforeDecode=null;await f(p);}
      const bytes=await bytesFromOwnedFile(p,options);
      // SHA256 is checked on THIS raw buffer before text/codec adaptation.
      if(options?.expectedSHA256 != null) {
        assert.match(options.expectedSHA256,/^[0-9a-f]{64}$/);
        if(createHash('sha256').update(bytes).digest('hex')!==options.expectedSHA256)
          throw new nativeDOM('SHA-256 mismatch (real Node hash, not native execution)','NotReadableError');
      }
      if(options?.decompress && options.maxDecompressedBytes != null && bytes.length>options.maxDecompressedBytes)
        throw new nativeDOM('decoded cap (decoded-text adapter)','NotReadableError');
      return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    },profileBeforeChange:{addBlocker(...x){calls.blocks.push(x);},removeBlocker(x){calls.blocks.push(['remove',x]);}}}
  });
  // Product bytes remain verbatim; this diagnostic export only observes state.
  const mod = new vm.SourceTextModule(source+'\nexport { SessionFileInternal };\n',{context:ctx,identifier:sourcePath});
  await mod.link(spec=>{assert.equal(spec,'resource://gre/modules/XPCOMUtils.sys.mjs');return new vm.SyntheticModule(['XPCOMUtils'],function(){this.setExport('XPCOMUtils',{declareLazy(){return lazy;}});},{context:ctx});});
  await mod.evaluate();
  ctx.IOUtils.readJSON = async (p,options) => JSON.parse(await ctx.IOUtils.readUTF8(p,options));
  return {api:mod.namespace.SessionFile,internal:mod.namespace.SessionFileInternal,calls,faults,physical,version,runState,adapters,allowedRoots,
    io:ctx.IOUtils,hashClass:Cc['@mozilla.org/security/hash;1'],hashInterface,
    setUpgrade(x){upgrade=x;},hold(f){hold=f;},beforeDecode(f){beforeDecode=f;},cryptoError(e,stage='createInstance'){cryptoError=e;cryptoStage=stage;}};
}
function snapshot(x) {return [x._readOrigin,x._usingOldExtension,x._initialized,x._attempts,x._successes,x._failures];}
function independentEffects(x) {assert.deepEqual(x.calls.lazy,[]);assert.deepEqual(x.calls.telemetry,[]);assert.deepEqual(x.calls.prefs,[]);assert.equal(x.calls.zen,0);assert.deepEqual(x.calls.init,[]);assert.deepEqual(x.calls.writes,[]);assert.deepEqual(x.calls.blocks,[]);assert.deepEqual(x.calls.notifications,[]);}
const budgets={maxFileBytes:1048576,maxDecompressedBytes:1048576};
function read(x,root,latestUpgradeBackupID='') {return x.api.readFromRoot(root,{latestUpgradeBackupID,isFormatVersionCompatible:x.version,...budgets});}
await check('module import without ProfD or lazy consumers',async()=>{const r=await fixture();const x=await load(r,true);independentEffects(x);assert.deepEqual(x.calls.reads,[]);assert.deepEqual(x.calls.crypto,[]);});
await check('ordinary positive and writer initialization contract',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4');const x=await load(r);const p=x.api.Paths;assert.equal(p,x.api.Paths);assert.ok(Object.isFrozen(p));x.setUpgrade('u1');assert.equal(p.upgradeBackup,path.join(r,'sessionstore-backups/upgrade.jsonlz4-u1'));assert.equal(p.nextUpgradeBackup,path.join(r,'sessionstore-backups/upgrade.jsonlz4-next'));x.setUpgrade('');
 const result=await x.api.read();assert.equal(result.origin,'clean');assert.equal(result.source,text);assert.equal(result.noFilesFound,false);assert.equal(result.parsed.windows[0].tabs[0].image,'fixture-image');assert.equal(x.calls.zen,1);assert.ok(x.calls.telemetry.length);assert.equal(x.calls.reads.length,1);assert.equal(x.calls.reads[0].method,'readUTF8');assert.equal(x.calls.decodes.length,1);assert.deepEqual(x.calls.crypto,[]);assert.ok(!('rawSHA256' in result));assert.ok(!('rawLength' in result));await x.api.write({windows:[]});assert.equal(x.calls.init[0][0],'clean');assert.equal(x.calls.init[0][1],false);assert.equal(x.calls.init[0][2],p);assert.equal(x.calls.writes.length,1);
});
await check('explicit root preserves complete document without consumption',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4');const x=await load(r,true);const before=snapshot(x.internal);const result=await read(x,r);assert.equal(result.status,'read');assert.equal(result.origin,'clean');assert.equal(result.path,path.join(r,'sessionstore.jsonlz4'));assert.equal(result.source,text);assert.equal(result.useOldExtension,false);
 const expected=JSON.parse(text);expected.windows[0].tabs[0].image='fixture-image';expected._closedWindows[0]._closedTabs[0].image='fixture-image';assert.equal(JSON.stringify(result.parsed),JSON.stringify(expected));assert.deepEqual(snapshot(x.internal),before);independentEffects(x);assert.equal(await fs.readFile(result.path,'utf8'),text);
});
await check('corrupt primary refuses strict; ordinary uses good backup',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4','{');await put(r,'sessionstore-backups/recovery.jsonlz4');const strict=await load(r,true);await assert.rejects(read(strict,r),e=>e.name==='SyntaxError');assert.equal(strict.calls.reads.length,1);independentEffects(strict);const ordinary=await load(r);assert.equal((await ordinary.api.read()).origin,'recovery');assert.equal(ordinary.calls.zen,1);
});
await check('missing primary selects recovery without writes',async()=>{const r=await fixture();await put(r,'sessionstore-backups/recovery.jsonlz4');const x=await load(r,true);const v=await read(x,r);assert.equal(v.origin,'recovery');assert.equal(x.calls.reads.length,2);independentEffects(x);});
await check('all absent is explicit absence, ordinary retains empty fallback',async()=>{
 const r=await fixture();const x=await load(r,true);const v=await read(x,r);assert.equal(v.status,'absent');assert.equal(v.noFilesFound,true);assert.ok(!('parsed' in v));assert.equal(x.calls.reads.length,8);independentEffects(x);const y=await load(r);const ordinary=await y.api.read();assert.equal(ordinary.origin,'empty');assert.equal(ordinary.parsed,null);assert.equal(ordinary.noFilesFound,true);assert.equal(y.calls.zen,1);
});
await check('unknown and malformed versions refuse before backup',async()=>{for(const version of [['sessionrestore',99],['other',1],{},['sessionrestore','bad']]){const r=await fixture();await put(r,'sessionstore.jsonlz4',JSON.stringify({...document,version}));await put(r,'sessionstore-backups/recovery.jsonlz4');const x=await load(r,true);await assert.rejects(read(x,r),/format\/version/);assert.equal(x.calls.reads.length,1);independentEffects(x);const y=await load(r);assert.equal((await y.api.read()).origin,'recovery');}});
await check('original I/O and decoder errors propagate unchanged',async()=>{for(const stage of ['raw','decode'])for(const name of ['NotReadableError','NotAllowedError','UnknownError']){const r=await fixture();await put(r,'sessionstore.jsonlz4');await put(r,'sessionstore-backups/recovery.jsonlz4');const x=await load(r,true);const error=new DOMException('injected '+name,name);const inject=()=>x.faults.set(path.join(r,'sessionstore.jsonlz4'),error);if(stage==='raw')inject();else x.beforeDecode(inject);await assert.rejects(read(x,r),e=>e===error);assert.equal(x.calls.reads.length,1);assert.equal(x.calls.parses,0);independentEffects(x);}});
await check('legacy pass only after every compressed candidate is absent',async()=>{
 const r=await fixture();await put(r,'sessionstore.js');const x=await load(r,true);const v=await read(x,r);assert.equal(v.useOldExtension,true);assert.equal(v.origin,'clean');assert.equal(v.path,path.join(r,'sessionstore.js'));assert.deepEqual(x.calls.reads.map(c=>path.basename(c.path)),['sessionstore.jsonlz4','recovery.jsonlz4','recovery.baklz4','previous.jsonlz4','sessionstore.js']);assert.equal(x.calls.decodes.at(-1).options.decompress,undefined);independentEffects(x);
 const y=await load(r);assert.equal((await y.api.read()).useOldExtension,true);await y.api.write({windows:[]});assert.equal(y.calls.init[0][1],true);
});
await check('captured upgrade choices and root cannot change across await',async()=>{
 const r=await fixture();await put(r,'sessionstore-backups/upgrade.jsonlz4-u1');const x=await load(r,true);const options={latestUpgradeBackupID:'u1',isFormatVersionCompatible:x.version,...budgets};let release;const barrier=new Promise(r=>release=r);x.hold(()=>barrier);const pending=x.api.readFromRoot(r,options);options.latestUpgradeBackupID='../../escape';options.isFormatVersionCompatible=()=>false;options.maxFileBytes=0;options.maxDecompressedBytes=0;release();const v=await pending;assert.equal(v.origin,'upgradeBackup');assert.equal(v.path,path.join(r,'sessionstore-backups/upgrade.jsonlz4-u1'));assert.ok(Object.isFrozen(v.paths));assert.ok(Object.isFrozen(v.paths.loadOrder));assert.ok(x.calls.reads.every(c=>c.options.maxFileBytes===budgets.maxFileBytes));assert.ok(x.calls.decodes.every(c=>c.options.maxDecompressedBytes===budgets.maxDecompressedBytes));independentEffects(x);
});
await check('invalid explicit context refuses before I/O',async()=>{
 const r=await fixture();const x=await load(r,true);for(const root of ['', 'relative',null,{}])await assert.rejects(read(x,root));for(const id of ['../x','x/y','x\\y','\0',null,1])await assert.rejects(read(x,r,id));await assert.rejects(x.api.readFromRoot(r,{}));assert.equal(x.calls.reads.length,0);independentEffects(x);
});
await check('strict reads do not change prior ordinary writer lineage',async()=>{
 const a=await fixture(),b=await fixture();await put(a,'sessionstore.jsonlz4');await put(b,'sessionstore.js');const x=await load(a);await x.api.read();const before=snapshot(x.internal);const zen=x.calls.zen,telemetry=x.calls.telemetry.length;x.allowedRoots.add(b);const v=await read(x,b);assert.equal(v.useOldExtension,true);assert.equal(v.path,path.join(b,'sessionstore.js'));assert.deepEqual(snapshot(x.internal),before);assert.equal(x.calls.zen,zen);assert.equal(x.calls.telemetry.length,telemetry);await x.api.write({windows:[]});assert.equal(x.calls.init[0][0],'clean');assert.equal(x.calls.init[0][1],false);
});
await check('real filesystem unreadable-kind error does not become absence',async()=>{const r=await fixture();await fs.mkdir(path.join(r,'sessionstore.jsonlz4'));const x=await load(r,true);await assert.rejects(read(x,r),e=>e.code==='EISDIR');assert.equal(x.calls.reads.length,1);independentEffects(x);});
await check('strict refuses cache and predicate failures even named NotFound',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4');await put(r,'sessionstore-backups/recovery.jsonlz4');const x=await load(r,true);const error=new DOMException('predicate refusal','NotFoundError');await assert.rejects(x.api.readFromRoot(r,{latestUpgradeBackupID:'',...budgets,isFormatVersionCompatible(){throw error;}}),e=>e===error);assert.equal(x.calls.reads.length,1);independentEffects(x);
 const bad={...document,_cachedObjs:42};await put(r,'sessionstore.jsonlz4',JSON.stringify(bad));const y=await load(r,true);await assert.rejects(read(y,r),e=>e.name==='TypeError');assert.equal(y.calls.reads.length,1);const ordinary=await load(r);assert.equal((await ordinary.api.read()).origin,'clean');assert.ok(ordinary.calls.logs.some(e=>e[0]==='error'));
});
await check('legacy conversion cannot rewrite the explicit root',async()=>{
 const base=await fixture(),r=path.join(base,'jsonlz4-baklz4');await fs.mkdir(r,{mode:0o700});await fs.mkdir(path.join(r,'sessionstore-backups'),{mode:0o700});await put(r,'sessionstore.js');const x=await load(r,true);const v=await read(x,r+'/');assert.equal(v.path,path.join(r,'sessionstore.js'));assert.equal(v.useOldExtension,true);independentEffects(x);
});
await check('ordinary blocked shutdown write keeps completion without writer',async()=>{
 const r=await fixture();const x=await load(r);x.adapters.ZenSessionStore.canSaveSession=false;x.runState.isClosing=true;await x.api.write({windows:[]});assert.equal(x.runState.isClosed,true);assert.equal(x.calls.init.length,0);assert.equal(x.calls.writes.length,0);assert.equal(x.calls.notifications[0][1],'sessionstore-final-state-write-complete');
});
await check('strict explicit uint32 budgets reject before I/O',async()=>{
 const r=await fixture();const x=await load(r,true);for(const field of ['maxFileBytes','maxDecompressedBytes'])for(const bad of [undefined,null,-1,0.5,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1,4294967296,'1',true]){const opts={latestUpgradeBackupID:'',isFormatVersionCompatible:x.version,...budgets,[field]:bad};await assert.rejects(x.api.readFromRoot(r,opts),e=>e.name==='TypeError');assert.equal(x.calls.reads.length,0);}independentEffects(x);
});
await check('zero budgets and uint32 maximum are accepted without defaults',async()=>{
 for(const budget of [0,4294967295]){const r=await fixture();const x=await load(r,true);const v=await x.api.readFromRoot(r,{latestUpgradeBackupID:'',isFormatVersionCompatible:x.version,maxFileBytes:budget,maxDecompressedBytes:budget});assert.equal(v.status,'absent');assert.equal(x.calls.reads.length,8);for(const c of x.calls.reads){assert.equal(c.options.maxFileBytes,budget);if(c.options.decompress)assert.equal(c.options.maxDecompressedBytes,budget);}independentEffects(x);}
});
await check('compressed and legacy pass budgets; refusal preserves ordinary lineage',async()=>{
 for(const leaf of ['sessionstore.jsonlz4','sessionstore.js']){const r=await fixture();await put(r,leaf);const x=await load(r);const before=snapshot(x.internal);await assert.rejects(x.api.readFromRoot(r,{latestUpgradeBackupID:'',isFormatVersionCompatible:x.version,maxFileBytes:0,maxDecompressedBytes:0}),e=>e.name==='NotReadableError');assert.deepEqual(snapshot(x.internal),before);assert.equal(x.calls.writes.length,0);assert.equal(x.calls.zen,0);assert.equal(x.calls.reads.at(-1).options.maxFileBytes,0);const strictSuccess=await read(x,r);assert.equal(strictSuccess.source,text);assert.equal(strictSuccess.parsed.unknown.nested[0],'kept');assert.deepEqual(snapshot(x.internal),before);const v=await x.api.read();assert.equal(v.source,text);assert.equal(v.parsed.unknown.nested[0],'kept');await x.api.write({windows:[]});assert.equal(x.calls.init[0][0],'clean');assert.equal(x.calls.init[0][1],leaf.endsWith('.js'));assert.equal(x.calls.writes.length,1);assert.ok(x.calls.reads.filter(c=>c.options.maxFileBytes===undefined).length);}
});
await check('selected compressed-name and legacy receipts bind complete owned raw bytes',async()=>{
 for(const leaf of ['sessionstore.jsonlz4','sessionstore.js']) {
  const r=await fixture();await put(r,leaf);const x=await load(r,true);const v=await read(x,r);
  const raw=await fs.readFile(path.join(r,leaf));
  assert.equal(v.rawSHA256,createHash('sha256').update(raw).digest('hex'));
  assert.equal(v.rawLength,raw.length);assert.equal(v.source,text);
  const expected=JSON.parse(text);expected.windows[0].tabs[0].image='fixture-image';expected._closedWindows[0]._closedTabs[0].image='fixture-image';
  assert.equal(JSON.stringify(v.parsed),JSON.stringify(expected));
  assert.equal(x.calls.reads.at(-1).method,'read');assert.equal(x.calls.decodes.length,1);
  assert.equal(x.calls.decodes[0].options.expectedSHA256,v.rawSHA256);
  assert.equal(x.calls.decodes[0].options.maxFileBytes,budgets.maxFileBytes);
  assert.equal(x.calls.decodes[0].options.decompress,leaf.endsWith('.js')?undefined:true);
  if(!leaf.endsWith('.js'))assert.equal(x.calls.decodes[0].options.maxDecompressedBytes,budgets.maxDecompressedBytes);
  assert.deepEqual(x.calls.crypto,['createInstance','init',{updateLength:raw.length},'finish']);
  independentEffects(x);
 }
});
await check('same-size mutation between raw capture and decode refuses before parse or fallback',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4');await put(r,'sessionstore-backups/recovery.jsonlz4');const x=await load(r,true);
 const alternative=text.replace('kept','lost');assert.equal(Buffer.byteLength(alternative),Buffer.byteLength(text));
 x.beforeDecode(p=>fs.writeFile(p,alternative));
 await assert.rejects(read(x,r),e=>e.name==='NotReadableError'&&/SHA-256 mismatch/.test(e.message));
 assert.equal(x.calls.parses,0);assert.equal(x.calls.reads.length,1);assert.equal(x.calls.decodes.length,1);independentEffects(x);
});
await check('vanish after raw capture never becomes missing-primary recovery',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4');await put(r,'sessionstore-backups/recovery.jsonlz4');const x=await load(r,true);
 x.beforeDecode(p=>fs.unlink(p));await assert.rejects(read(x,r),e=>e.name==='NotFoundError');
 assert.equal(x.calls.parses,0);assert.equal(x.calls.reads.length,1);assert.equal(x.calls.decodes.length,1);independentEffects(x);
});
await check('NotFound crypto failure after capture cannot select backup',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4');await put(r,'sessionstore-backups/recovery.jsonlz4');const x=await load(r,true);
 const error=new DOMException('hash unavailable','NotFoundError');x.cryptoError(error);
 await assert.rejects(read(x,r),e=>e===error);assert.equal(x.calls.reads.length,1);assert.equal(x.calls.decodes.length,0);assert.equal(x.calls.parses,0);independentEffects(x);
});
await check('raw cap refuses before hash and zero-byte legacy hashes before existing JSON refusal',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4');const x=await load(r,true);
 await assert.rejects(x.api.readFromRoot(r,{latestUpgradeBackupID:'',isFormatVersionCompatible:x.version,maxFileBytes:0,maxDecompressedBytes:0}),e=>e.name==='NotReadableError');
 assert.deepEqual(x.calls.crypto,[]);assert.equal(x.calls.decodes.length,0);assert.equal(x.calls.parses,0);independentEffects(x);
 const z=await fixture();await put(z,'sessionstore.js','');const y=await load(z,true);
 await assert.rejects(y.api.readFromRoot(z,{latestUpgradeBackupID:'',isFormatVersionCompatible:y.version,maxFileBytes:0,maxDecompressedBytes:0}),e=>e.name==='SyntaxError');
 assert.deepEqual(y.calls.crypto,['createInstance','init',{updateLength:0},'finish']);
 assert.equal(y.calls.decodes[0].options.expectedSHA256,createHash('sha256').update(new Uint8Array()).digest('hex'));
 assert.equal(y.calls.parses,1);assert.equal(y.calls.reads.length,5);independentEffects(y);
});
// Complete read-set opt-in. Old readers ignore these options; the initial
// counterexample therefore exercises the existing consumer, not a missing API.
function inventoryOptions(x, extra={}) {
 return {latestUpgradeBackupID:'',isFormatVersionCompatible:x.version,...budgets,
   readSet:{maxRawBytes:16777216},...extra};
}
await check('read-set: higher absent becomes present during recovery raw read refuses',async()=>{
 const r=await fixture();await put(r,'sessionstore-backups/recovery.jsonlz4');
 const x=await load(r,true),before=snapshot(x.internal),ownedRead=x.io.read;
 let injected=false,accepted,error;
 x.io.read=async(p,options)=>{
   if(!injected&&p===path.join(r,'sessionstore-backups/recovery.jsonlz4')) {
     injected=true;await put(r,'sessionstore.jsonlz4');
   }
   return ownedRead(p,options);
 };
 try {accepted=await x.api.readFromRoot(r,inventoryOptions(x));} catch(e) {error=e;}
 assert.equal(injected,true);assert.equal(await fs.readFile(path.join(r,'sessionstore.jsonlz4'),'utf8'),text);
 const stable=await read(await load(r,true),r);assert.equal(stable.origin,'clean');
 assert.deepEqual(snapshot(x.internal),before);independentEffects(x);
 assert.ok(error,'must refuse changed higher absence; actual selected '+accepted?.origin);
 assert.equal(error.name,'NotReadableError');
});
// Test-only expectation comparator for old readers that lack the aggregate
// interface. It does not replace the consumer or establish authentication.
async function capturedSet(x,r,extra={}) {
 const options=inventoryOptions(x,extra),v=await x.api.readFromRoot(r,options);
 if(v.readSet)return v.readSet;
 const origins=['clean','recovery','recoveryBackup','cleanBackup',...(options.latestUpgradeBackupID?['upgradeBackup']:[])];
 const suffixes=['sessionstore.jsonlz4','sessionstore-backups/recovery.jsonlz4','sessionstore-backups/recovery.baklz4','sessionstore-backups/previous.jsonlz4',`sessionstore-backups/upgrade.jsonlz4-${options.latestUpgradeBackupID}`];
 const candidates=[];
 for(const useOldExtension of [false,true])for(const [i,origin] of origins.entries()) {
   const leaf=useOldExtension?suffixes[i].replace('jsonlz4','js').replace('baklz4','bak'):suffixes[i];
   const p=path.join(r,leaf),entry={origin,path:p,useOldExtension};
   try {const bytes=await fs.readFile(p);candidates.push({...entry,status:'present',rawLength:bytes.length,rawSHA256:createHash('sha256').update(bytes).digest('hex')});}
   catch(e){if(e.code!=='ENOENT')throw e;candidates.push({...entry,status:'absent'});}
 }
 const index=candidates.findIndex(e=>e.status==='present');
 return {root:r,latestUpgradeBackupID:options.latestUpgradeBackupID,...budgets,maxRawBytes:options.readSet.maxRawBytes,status:index<0?'absent':'read',selected:index<0?null:index,candidates};
}
await check('read-set: expected epoch refuses selected same-size edit before decode',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4');const host=await load(r,true),expected=await capturedSet(host,r);
 await put(r,'sessionstore.jsonlz4',text.replace('kept','lost'));const x=await load(r,true),before=snapshot(x.internal);
 await assert.rejects(x.api.readFromRoot(r,inventoryOptions(x,{readSet:{maxRawBytes:16777216,expected}})),e=>e.name==='NotReadableError');
 assert.equal(x.calls.decodes.length,0);assert.deepEqual(snapshot(x.internal),before);independentEffects(x);
});
await check('read-set: expected epoch refuses higher absence flip',async()=>{
 const r=await fixture();await put(r,'sessionstore-backups/recovery.jsonlz4');const expected=await capturedSet(await load(r,true),r);
 await put(r,'sessionstore.jsonlz4');const x=await load(r,true);
 await assert.rejects(x.api.readFromRoot(r,inventoryOptions(x,{readSet:{maxRawBytes:16777216,expected}})),e=>e.name==='NotReadableError');
 assert.equal(x.calls.decodes.length,0);independentEffects(x);
});
await check('read-set: expected canonical root choices order and caps refuse before I/O',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4');const captured=await capturedSet(await load(r,true),r);
 for(const mutate of [s=>s.root+='/other',s=>s.latestUpgradeBackupID='u1',s=>s.maxFileBytes--,s=>s.maxDecompressedBytes--,s=>s.maxRawBytes--,s=>s.candidates.reverse(),s=>s.candidates.pop(),s=>s.selected=1,s=>s.status='absent',s=>s.candidates[0].path+='x']) {
   const expected=JSON.parse(JSON.stringify(captured));mutate(expected);const x=await load(r,true);
   await assert.rejects(x.api.readFromRoot(r,inventoryOptions(x,{readSet:{maxRawBytes:16777216,expected}})),e=>e.name==='TypeError');
   assert.equal(x.calls.reads.length,0);independentEffects(x);
 }
});
await check('read-set: expected metadata and opt-in choices copied before await',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4');const captured=await capturedSet(await load(r,true),r);
 const expected=JSON.parse(JSON.stringify(captured)),x=await load(r,true),options=inventoryOptions(x,{readSet:{maxRawBytes:16777216,expected}});
 let release;const barrier=new Promise(resolve=>release=resolve);x.hold(()=>barrier);
 const pending=x.api.readFromRoot(r,options);expected.root='changed';expected.candidates[0].rawSHA256='0'.repeat(64);expected.candidates.reverse();options.latestUpgradeBackupID='bad/id';options.maxFileBytes=0;options.maxDecompressedBytes=0;options.readSet.maxRawBytes=0;release();
 const v=await pending;assert.equal(v.source,text);assert.ok(v.readSet,'complete interface not baseline-covered');
 assert.equal(JSON.stringify(v.readSet),JSON.stringify(captured));assert.ok(Object.isFrozen(v.readSet));assert.ok(Object.isFrozen(v.readSet.candidates));assert.ok(v.readSet.candidates.every(Object.isFrozen));independentEffects(x);
});
await check('read-set: complete raw inventory retains opaque backups and parsed cache identity',async()=>{
 for(const leaf of ['sessionstore.jsonlz4','sessionstore.js','sessionstore-backups/upgrade.jsonlz4-u1']) {
  const r=await fixture();await put(r,leaf);const opaque=Buffer.from([255,0,123,128]);await put(r,'sessionstore-backups/previous.js',opaque);
  const x=await load(r,true),before=snapshot(x.internal),v=await x.api.readFromRoot(r,inventoryOptions(x,{latestUpgradeBackupID:leaf.includes('upgrade')?'u1':''}));
  assert.ok(v.readSet,'complete interface not baseline-covered');const set=v.readSet,entries=set.candidates;
  assert.equal(entries.length,leaf.includes('upgrade')?10:8);assert.ok(entries.slice(0,entries.length/2).every(e=>e.useOldExtension===false));assert.ok(entries.slice(entries.length/2).every(e=>e.useOldExtension===true));
  assert.equal(entries[set.selected].path,path.join(r,leaf));assert.equal(set.status,'read');assert.equal(v.source,text);assert.equal(v.parsed.windows[0].tabs[0].image,'fixture-image');assert.equal(JSON.stringify(v.parsed.unknown),JSON.stringify(document.unknown));
  const raw=await fs.readFile(path.join(r,leaf));assert.equal(v.rawLength,raw.length);assert.equal(v.rawSHA256,createHash('sha256').update(raw).digest('hex'));
  const lower=entries.find(e=>e.path===path.join(r,'sessionstore-backups/previous.js'));assert.equal(lower.status,'present');assert.equal(lower.rawLength,opaque.length);assert.equal(lower.rawSHA256,createHash('sha256').update(opaque).digest('hex'));
  assert.equal(x.calls.decodes.length,1);assert.equal(x.calls.parses,1);assert.equal(x.calls.decodes[0].path,path.join(r,leaf));assert.equal(x.calls.decodes[0].options.maxFileBytes,raw.length);
  assert.equal(x.calls.reads.length,entries.length*2);assert.equal(await fs.readFile(path.join(r,leaf),'utf8'),text);assert.deepEqual(await fs.readFile(lower.path),opaque);
  assert.deepEqual(snapshot(x.internal),before);independentEffects(x);
 }
});
await check('read-set: stable recovery and full absence including upgrade-disabled choice',async()=>{
 for(const upgrade of ['', 'u1'])for(const present of [false,true]) {
  const r=await fixture();if(present)await put(r,'sessionstore-backups/recovery.jsonlz4');const x=await load(r,true),v=await x.api.readFromRoot(r,inventoryOptions(x,{latestUpgradeBackupID:upgrade}));
  assert.ok(v.readSet,'complete interface not baseline-covered');assert.equal(v.readSet.candidates.length,upgrade?10:8);assert.equal(v.readSet.latestUpgradeBackupID,upgrade);assert.equal(v.readSet.selected,present?1:null);assert.equal(v.status,present?'read':'absent');assert.equal(v.noFilesFound,!present);
  if(!present){assert.ok(!('parsed' in v));assert.ok(v.readSet.candidates.every(e=>e.status==='absent'&&!('rawLength' in e)&&!('rawSHA256' in e)));}
  const y=await load(r,true),replay=await y.api.readFromRoot(r,inventoryOptions(y,{latestUpgradeBackupID:upgrade,readSet:{maxRawBytes:16777216,expected:v.readSet}}));assert.equal(JSON.stringify(replay.readSet),JSON.stringify(v.readSet));independentEffects(x);independentEffects(y);
 }
});
await check('read-set: missing invalid aggregate and malformed expected refuse before reads',async()=>{
 const r=await fixture(),x=await load(r,true);for(const bad of [{},null,true,[],{maxRawBytes:undefined},{maxRawBytes:-1},{maxRawBytes:0.5},{maxRawBytes:NaN},{maxRawBytes:Infinity},{maxRawBytes:Number.MAX_SAFE_INTEGER+1},{maxRawBytes:'1'},{maxRawBytes:0,expected:undefined}]) {
  await assert.rejects(x.api.readFromRoot(r,inventoryOptions(x,{readSet:bad})),e=>e.name==='TypeError');assert.equal(x.calls.reads.length,0);
 }
 let getterCalls=0;const lazy={get maxRawBytes(){getterCalls++;return 1;}};
 await assert.rejects(x.api.readFromRoot(r,inventoryOptions(x,{readSet:lazy})),e=>e.name==='TypeError');assert.equal(getterCalls,0);assert.equal(x.calls.reads.length,0);independentEffects(x);
});
await check('read-set: aggregate zero exact below and safe-integer boundaries',async()=>{
 const empty=await fixture(),z=await load(empty,true);const absent=await z.api.readFromRoot(empty,inventoryOptions(z,{readSet:{maxRawBytes:0}}));assert.equal(absent.status,'absent');assert.ok(absent.readSet,'complete interface not baseline-covered');assert.ok(z.calls.reads.every(c=>c.options.maxFileBytes===0));
 for(const delta of [-1,0,1]) {
  const r=await fixture();await put(r,'sessionstore.jsonlz4');await put(r,'sessionstore-backups/recovery.js','opaque');const x=await load(r,true),size=Buffer.byteLength(text),total=size*3+12,limit=total+delta;
  const pending=x.api.readFromRoot(r,inventoryOptions(x,{readSet:{maxRawBytes:limit}}));
  if(delta<0)await assert.rejects(pending,e=>e.name==='NotReadableError');else {const v=await pending;assert.equal(v.source,text);assert.equal(v.readSet.maxRawBytes,limit);}
  let remaining=limit;for(const c of x.calls.reads){assert.ok(c.options.maxFileBytes<=Math.min(budgets.maxFileBytes,remaining));try {const bytes=await fs.readFile(c.path);if(bytes.length<=c.options.maxFileBytes)remaining-=bytes.length;}catch(e){if(e.code!=='ENOENT')throw e;}if(c===x.calls.reads[7])remaining-=size;}
  independentEffects(x);
 }
 const r=await fixture();await put(r,'sessionstore.jsonlz4');const x=await load(r,true);await assert.rejects(x.api.readFromRoot(r,inventoryOptions(x,{readSet:{maxRawBytes:0}})),e=>e.name==='NotReadableError');assert.equal(x.calls.reads[0].options.maxFileBytes,0);assert.equal(x.calls.crypto.length,0);independentEffects(x);
 const a=await fixture(),y=await load(a,true);assert.equal((await y.api.readFromRoot(a,inventoryOptions(y,{readSet:{maxRawBytes:Number.MAX_SAFE_INTEGER}}))).status,'absent');independentEffects(y);
});
await check('read-set: unselected raw failures refuse whole capture without decode',async()=>{
 for(const fault of ['io','dir','cap','aggregate']) {
  const r=await fixture();await put(r,'sessionstore.jsonlz4');const leaf='sessionstore-backups/recovery.jsonlz4',p=path.join(r,leaf),x=await load(r,true),before=snapshot(x.internal),error=new DOMException('unselected owned failure','NotAllowedError');
  if(fault==='dir')await fs.mkdir(p);else await put(r,leaf,Buffer.alloc(Buffer.byteLength(text)+1,255));
  if(fault==='io')x.faults.set(p,error);
  const opts=inventoryOptions(x);if(fault==='cap')opts.maxFileBytes=Buffer.byteLength(text);if(fault==='aggregate')opts.readSet.maxRawBytes=Buffer.byteLength(text)*2;
  await assert.rejects(x.api.readFromRoot(r,opts),e=>fault==='io'?e===error:fault==='dir'?e.code==='EISDIR':e.name==='NotReadableError');
  assert.equal(x.calls.decodes.length,0);assert.equal(x.calls.parses,0);assert.deepEqual(snapshot(x.internal),before);assert.equal(await fs.readFile(path.join(r,'sessionstore.jsonlz4'),'utf8'),text);independentEffects(x);
 }
});
await check('read-set: expected nonselected edit and present to absent retain original refusal',async()=>{
 for(const change of ['same-size','delete-selected','delete-unselected']) {
  const r=await fixture();await put(r,'sessionstore.jsonlz4');await put(r,'sessionstore-backups/recovery.js','opaque');const expected=await capturedSet(await load(r,true),r),p=path.join(r,change==='delete-selected'?'sessionstore.jsonlz4':'sessionstore-backups/recovery.js');
  if(change==='same-size')await fs.writeFile(p,'OPAQUE');else await fs.unlink(p);
  const x=await load(r,true);await assert.rejects(x.api.readFromRoot(r,inventoryOptions(x,{readSet:{maxRawBytes:16777216,expected}})),e=>e.name===(change==='same-size'?'NotReadableError':'NotFoundError'));assert.equal(x.calls.decodes.length,0);independentEffects(x);
 }
});
await check('read-set: post-decode absence edits deletes and raw hash failure refuse',async()=>{
 for(const change of ['higher-create','selected-delete','lower-delete','lower-edit','hash']) {
  const r=await fixture();await put(r,'sessionstore-backups/recovery.jsonlz4');await put(r,'sessionstore-backups/recovery.js','opaque');const x=await load(r,true),before=snapshot(x.internal),error=new DOMException('post-capture hash owner','NotFoundError');
  x.beforeDecode(async()=>{if(change==='higher-create')await put(r,'sessionstore.jsonlz4');if(change==='selected-delete')await fs.unlink(path.join(r,'sessionstore-backups/recovery.jsonlz4'));if(change==='lower-delete')await fs.unlink(path.join(r,'sessionstore-backups/recovery.js'));if(change==='lower-edit')await put(r,'sessionstore-backups/recovery.js','OPAQUE');if(change==='hash')x.cryptoError(error);});
  await assert.rejects(x.api.readFromRoot(r,inventoryOptions(x)),e=>change==='hash'?e===error:e.name===(change.includes('delete')?'NotFoundError':'NotReadableError'));
  assert.deepEqual(snapshot(x.internal),before);independentEffects(x);
 }
});
await check('read-set: selected decoder pins original expected hash and length before parse',async()=>{
 for(const change of ['same-size','delete','decode','json','cache','version']) {
  const r=await fixture();let payload=text;
  if(change==='decode')payload=Buffer.from([255]);if(change==='json')payload='{';if(change==='cache')payload=JSON.stringify({...document,_cachedObjs:42});if(change==='version')payload=JSON.stringify({...document,version:['sessionrestore',99]});
  await put(r,'sessionstore.jsonlz4',payload);const x=await load(r,true),before=snapshot(x.internal);
  let expected;
  if(['same-size','delete'].includes(change)) {
   expected=await capturedSet(await load(r,true),r);
   x.beforeDecode(async(p)=>{assert.equal(x.calls.decodes[0].options.expectedSHA256,expected.candidates[0].rawSHA256);if(change==='delete')await fs.unlink(p);else await fs.writeFile(p,text.replace('kept','lost'));});
  }
  await assert.rejects(x.api.readFromRoot(r,inventoryOptions(x,expected?{readSet:{maxRawBytes:16777216,expected}}:{})),e=>change==='delete'?e.name==='NotFoundError':change==='same-size'?e.name==='NotReadableError':change==='json'?e.name==='SyntaxError':e.name==='TypeError');
  assert.equal(x.calls.decodes.length,1);if(['same-size','delete','decode'].includes(change))assert.equal(x.calls.parses,0);assert.deepEqual(snapshot(x.internal),before);independentEffects(x);
 }
});
await check('read-set: every hash stage preserves unselected original errors including NotFound',async()=>{
 for(const stage of ['createInstance','init','update','finish']) {
  const r=await fixture();await put(r,'sessionstore.jsonlz4');await put(r,'sessionstore-backups/recovery.js','opaque');const x=await load(r,true),owned=x.io.read,error=new DOMException('unselected hash '+stage,'NotFoundError');
  x.io.read=async(p,opts)=>{if(p===path.join(r,'sessionstore-backups/recovery.js'))x.cryptoError(error,stage);return owned(p,opts);};
  await assert.rejects(x.api.readFromRoot(r,inventoryOptions(x)),e=>e===error);assert.equal(x.calls.decodes.length,0);independentEffects(x);
 }
});
await check('read-set: refusals leave prior ordinary lineage and writer unchanged',async()=>{
 const a=await fixture(),b=await fixture();await put(a,'sessionstore.js');await put(b,'sessionstore.jsonlz4');await put(b,'sessionstore-backups/recovery.js','opaque');
 const x=await load(a);await x.api.read();x.allowedRoots.add(b);const before=snapshot(x.internal),zen=x.calls.zen,telemetry=x.calls.telemetry.length;
 const error=new DOMException('unselected refusal','NotAllowedError');x.faults.set(path.join(b,'sessionstore-backups/recovery.js'),error);
 await assert.rejects(x.api.readFromRoot(b,inventoryOptions(x)),e=>e===error);assert.deepEqual(snapshot(x.internal),before);assert.equal(x.calls.zen,zen);assert.equal(x.calls.telemetry.length,telemetry);
 await x.api.write({windows:[]});assert.equal(x.calls.init[0][0],'clean');assert.equal(x.calls.init[0][1],true);assert.equal(x.calls.writes.length,1);
});
// Complete-regular raw ownership: every counterexample reaches the unchanged
// whole SessionFile module. Physical specials are NEVER opened or constructed.
await check('complete-owner: stable positive and legacy boundary calibration',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4');await put(r,'sessionstore-backups/recovery.js','opaque');
 const x=await load(r,true),p=path.join(r,'sessionstore-backups/recovery.js');
 x.physical.set(p,{pathKind:'other',fdKind:'other',size:0});
 assert.equal((await x.io.read(p,{maxFileBytes:100})).length,0,'legacy raw owner can expose zero-sized other-kind MODEL');
 x.physical.delete(p);const v=await x.api.readFromRoot(r,inventoryOptions(x));assert.equal(v.source,text);independentEffects(x);
});
for(const kind of ['path','opened-FD'])await check('complete-owner R1: refuses '+kind+' nonregular metadata MODEL',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4');await put(r,'sessionstore-backups/recovery.js','');
 const x=await load(r,true),p=path.join(r,'sessionstore-backups/recovery.js'),before=snapshot(x.internal);
 x.physical.set(p,{pathKind:kind==='path'?'other':'regular',fdKind:'other',size:0});
 await assert.rejects(x.api.readFromRoot(r,inventoryOptions(x)),e=>e.name==='InvalidAccessError');
 assert.equal(x.calls.decodes.length,0);assert.deepEqual(snapshot(x.internal),before);independentEffects(x);
});
for(const mutation of ['growth','short-read'])for(const phase of ['initial','recheck'])
 await check('complete-owner R2: refuses '+mutation+' at '+phase+' without preknown digest',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4');const leaf='sessionstore-backups/recovery.js';await put(r,leaf,'opaque');
 const x=await load(r,true),p=path.join(r,leaf),before=snapshot(x.internal);
 const install=()=>x.physical.set(p,{reset:()=>fs.writeFile(p,'opaque'),afterStat:()=>fs.writeFile(p,mutation==='growth'?'opaque-tail':'opa')});
 if(phase==='initial')install();else x.beforeDecode(install);
 // Both legacy inventory observations can return the same incomplete prefix.
 await assert.rejects(x.api.readFromRoot(r,inventoryOptions(x)),e=>e.name==='NotReadableError');
 assert.deepEqual(snapshot(x.internal),before);independentEffects(x);
});
await check('complete-owner: all raw and selected decoder opt in; original pinned digests reused',async()=>{
 const r=await fixture();await put(r,'sessionstore.jsonlz4');await put(r,'sessionstore-backups/recovery.js','opaque');
 const host=await load(r,true),expected=(await host.api.readFromRoot(r,inventoryOptions(host))).readSet;
 assert.ok(host.calls.reads.every(c=>c.options.requireCompleteRead===true));assert.ok(host.calls.decodes.every(c=>c.options.requireCompleteRead===true));
 const x=await load(r,true);await x.api.readFromRoot(r,inventoryOptions(x,{readSet:{maxRawBytes:16777216,expected}}));
 for(const c of x.calls.reads){assert.equal(c.options.requireCompleteRead,true);const entry=expected.candidates.find(e=>e.path===c.path);assert.equal(c.options.expectedSHA256,entry.rawSHA256);}
 assert.equal(x.calls.decodes[0].options.expectedSHA256,expected.candidates[expected.selected].rawSHA256);
 const ordinary=await load(r,true);await read(ordinary,r);assert.ok(ordinary.calls.reads.every(c=>!Object.hasOwn(c.options,'requireCompleteRead')));assert.ok(ordinary.calls.decodes.every(c=>!Object.hasOwn(c.options,'requireCompleteRead')));
});
// Optional Manager oracle: full module plus diagnostic-only private fixture setup.
// nsIFile descriptor decoding/equals below is an explicit Node model, NOT native.
if (zenSourcePath) {
 const managerSource = await fs.readFile(zenSourcePath, 'utf8');
 const digest = s => createHash('sha256').update(s).digest('hex');
 const shim = `
  diagnosticOnlyFixture({sidebar, blocked, projection}) {
    this.#sidebarObject = {get dataWithoutCloning() {return sidebar;}};
    this.#profileBindingBlocked = blocked;
    this.#independentProjection = projection;
  }
`;
 const anchor = 'export class nsZenSessionManager {';
 assert.equal(managerSource.split(anchor).length,2);
 const generated = managerSource.replace(anchor,anchor+shim);
 assert.equal(generated.replace(shim,''),managerSource,
   'only diagnostic setup inserted; EVERY production predicate body unchanged');
 await fs.writeFile(path.join(fixtureRoot,'manager-diagnostic.mjs'),generated,{mode:0o600});
 const accesses = [];
 const effects = Object.fromEntries(['JSONFileCtor','JSONFileLoad','readFile','onFileRead','init','migration','adoption','writer','observer'].map(k=>[k,0]));
 let managerAdapter;
 const effect = name => {effects[name]++;throw new Error('Forbidden effect: '+name);};
 let poison = false;
 function forbidden(name) {accesses.push(name);throw new Error('Forbidden A fallback: '+name);}
 class FileModel {
   constructor(descriptor='',filePath='') {this.descriptor=descriptor;this.path=filePath;}
   get persistentDescriptor() {return this.descriptor;}
   set persistentDescriptor(value) {
     if(!['A','B','B-alias','foreign'].includes(value))throw new Error('unresolved descriptor');
     this.descriptor=value==='B-alias'?'B':value;
   }
   equals(other) {assert.ok(other instanceof FileModel);return this.descriptor===other.descriptor;}
   clone() {return new FileModel(this.descriptor);}
 }
 const aRoot = new FileModel('A'), bRoot = new FileModel('B');
 const lazyBindings = {};
 const services = {
   prefs:new Proxy({}, {get(_,key) {return (...args)=>{
     if(poison)return forbidden('prefs.'+key);
     assert.equal(key,'getBoolPref');assert.equal(args[0],'zen.session-store.backup-file');
     accesses.push('module-init-pref');return true;
   };}}),
   obs:{notifyObservers(){effect('observer');}},
   dirsvc:{get(key,iid) {if(poison)return forbidden('ProfD');assert.equal(key,'ProfD');assert.equal(iid,FileModel);return aRoot;}}
 };
 const context = vm.createContext({Services:services,Uint8Array,
   PathUtils:{join:path.join,isAbsolute:path.isAbsolute,get profileDir(){return forbidden('profileDir');}},
   IOUtils:new Proxy({}, {get(_,key){return (...args)=>managerAdapter.io[key](...args);}}),
   Ci:{nsIFile:FileModel,get nsICryptoHash(){return managerAdapter.hashInterface;}},
   Cc:{'@mozilla.org/file/local;1':{createInstance(iid){assert.equal(iid,FileModel);return new FileModel();}},
     get '@mozilla.org/security/hash;1'(){return managerAdapter.hashClass;}},
   Cu:{cloneInto:structuredClone},
   ChromeUtils:{defineESModuleGetters(target,bindings) {
     for(const key of Object.keys(bindings))Object.defineProperty(target,key,{get(){
       if(poison)return forbidden('lazy.'+key);
       assert.equal(key,'gWindowSyncEnabled');return true;
     }});
     Object.assign(lazyBindings,bindings);
   }}
 });
 const module = new vm.SourceTextModule(generated,{context,identifier:zenSourcePath});
 await module.link(spec=>{
   if(spec==='resource://gre/modules/JSONFile.sys.mjs')return new vm.SyntheticModule(['JSONFile'],function(){
     this.setExport('JSONFile',class {constructor(){effect('JSONFileCtor');} load(){effect('JSONFileLoad');}});
   },{context});
   assert.equal(spec,'resource://gre/modules/XPCOMUtils.sys.mjs');
   return new vm.SyntheticModule(['XPCOMUtils'],function(){this.setExport('XPCOMUtils',{
     defineLazyPreferenceGetter(target,key){Object.defineProperty(target,key,{get(){return forbidden('lazy-pref.'+key);}});}
   });},{context});
 });
 await module.evaluate();
 assert.deepEqual(accesses,['module-init-pref']);accesses.length=0;
 const manager=module.namespace.ZenSessionStore;
 const ref=descriptor=>({version:1,persistentDescriptor:descriptor});
 const space=descriptor=>({uuid:descriptor+'-space',name:descriptor,geckoProfileReference:ref(descriptor)});
 const aSpace=space('A'), bSpace=space('B');
 const sidebar={geckoProfileBindingVersion:1,lastCollected:17,spaces:[bSpace],tabs:[],unknown:{retained:true}};
 const bContext={profileRoot:bRoot,sidebar,profileBindingBlocked:false,independentProjection:null,windowSyncEnabled:true};
 const live={tabs:[{zenWorkspace:'B-space',entries:[{url:'https://b.invalid/old'},{url:'https://b.invalid/current'}]}]};
 const setup=(sidebar={spaces:[aSpace],tabs:[]},blocked=false,projection=null)=>
   manager.diagnosticOnlyFixture({sidebar,blocked,projection});
 const deepFreeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(deepFreeze);Object.freeze(x);}return x;};
 const explicit=(win=live,ctx=bContext)=>manager.canRestoreWindow(win,ctx);
 const poisonA=()=>{setup(new Proxy({}, {get(){return forbidden('private-sidebar');}}),true,
   new Proxy({}, {get(){return forbidden('private-projection');}}));poison=true;};
 setup();
 await check('B context uses B fallback sidebar; ordinary A still rejects B',()=>{
   assert.equal(manager.canRestoreWindow(live),false);
   assert.equal(explicit(),true,'explicit B fallback must not use A sidebar');
   assert.equal(explicit({spaces:[bSpace],tabs:live.tabs}),true);
 });
 await check('B root uses descriptor setter and equals, not descriptor string equality',()=>{
   poisonA();assert.equal(manager.isLocalProfileReference(ref('B'),bRoot),true);
   assert.equal(manager.isLocalProfileReference(ref('B-alias'),bRoot),true);
   assert.equal(manager.isLocalProfileReference(ref('A'),bRoot),false);
   assert.equal(explicit({spaces:[aSpace],tabs:[]}),false);
 });
 await check('B is independent of blocked/private A owners and A fallback poison',()=>{
   poisonA();assert.equal(explicit(),true);
   assert.equal(explicit(live,{...bContext,profileBindingBlocked:true}),false);
   for(const blocked of [false,true])for(const projection of [null,{spaces:[]},{spaces:[aSpace]}]){
     setup({spaces:[aSpace],tabs:[],changed:true},blocked,projection);assert.equal(explicit(),true);
   }
   poisonA();assert.equal(explicit(),true);assert.deepEqual(accesses,[]);
 });
 await check('malformed explicit references and roots fail closed without A',()=>{
   poisonA();for(const bad of [undefined,null,{},[],{version:2,persistentDescriptor:'B'},
     {version:1,persistentDescriptor:''},{version:1,persistentDescriptor:7},ref('unresolved')])
     assert.equal(manager.isLocalProfileReference(bad,bRoot),false);
   for(const root of [undefined,null,{},[],false,'B',{equals(){return true;}}])
     assert.equal(manager.isLocalProfileReference(ref('B'),root),false);
   assert.deepEqual(accesses,[]);
 });
 await check('missing null undefined wrong explicit contexts never borrow A',()=>{
   poisonA();for(const bad of [undefined,null,{},[],false,'B'])assert.equal(manager.canRestoreWindow(live,bad),false);
   for(const key of Object.keys(bContext)){
     const missing={...bContext};delete missing[key];assert.equal(explicit(live,missing),false,key+' missing');
     for(const bad of [undefined,null,7,'bad',false,[],{}]){
       if(key==='independentProjection'&&bad===null||key==='profileBindingBlocked'&&bad===false||key==='windowSyncEnabled'&&bad===false)continue;
       assert.equal(explicit(live,{...bContext,[key]:bad}),false,key+' wrong type');
     }
   }
   for(const bad of [{spaces:null,tabs:[]},{spaces:[],tabs:null},{tabs:[]},{spaces:[]}])
     assert.equal(explicit(live,{...bContext,sidebar:bad}),false);
   for(const bad of [{spaces:null},{spaces:[null]},{spaces:[{}]},{spaces:[aSpace]}])
     assert.equal(explicit(live,{...bContext,independentProjection:bad}),false);
   assert.deepEqual(accesses,[]);
   // A is permissive here: invalid explicit context must refuse even an empty
   // window that ordinary admission accepts without consulting ProfD or sync.
   setup();const emptyWindow={spaces:[],tabs:[]};
   assert.equal(manager.canRestoreWindow(emptyWindow),true);
   for(const bad of [undefined,null,{},[],false,'B'])
     assert.equal(manager.canRestoreWindow(emptyWindow,bad),false);
   for(const key of Object.keys(bContext)){
     const missing={...bContext};delete missing[key];
     assert.equal(manager.canRestoreWindow(emptyWindow,missing),false,key+' empty-window missing');
   }
   assert.deepEqual(accesses,[]);
 });
 await check('spaces absence empty null undefined and unknown membership remain distinct',()=>{
   poisonA();assert.equal(explicit(),true);
   for(const spaces of [[],null,undefined])assert.equal(explicit({...live,spaces}),false);
   assert.equal(explicit({tabs:[{zenWorkspace:'unknown'}]}),false);
   assert.equal(explicit({spaces:[],tabs:[]}),true);
   for(const bad of [null,undefined,[],false,'window'])assert.equal(manager.canRestoreWindow(bad,bContext),false);
   for(const tabs of [null,undefined,{},[null],[[]],[7]])assert.equal(explicit({tabs}),false);
 });
 await check('projection null empty matching missing and window sync policy use B only',()=>{
   poisonA();const empty={spaces:[]},matching={spaces:[bSpace]};
   assert.equal(explicit(live,{...bContext,independentProjection:null}),true);
   assert.equal(explicit(live,{...bContext,independentProjection:deepFreeze(matching)}),true);
   assert.equal(explicit(live,{...bContext,independentProjection:empty}),false);
   for(const flag of ['isPrivate','isPopup','isTaskbarTab','isZenUnsynced'])
     assert.equal(explicit({...live,[flag]:true},{...bContext,independentProjection:empty}),true,flag);
   assert.equal(explicit(live,{...bContext,independentProjection:empty,windowSyncEnabled:false}),true);
   const other={...bSpace,uuid:'other'};
   assert.equal(explicit(live,{...bContext,independentProjection:{spaces:[other]}}),false);
   assert.equal(explicit({tabs:[{zenWorkspace:'unknown'}]},{...bContext,windowSyncEnabled:false}),false);
 });
 await check('existing blank versus nonblank projection policy is unchanged',()=>{
   poisonA();const empty={...bContext,independentProjection:{spaces:[]}};
   for(const tab of [{},{entries:[]},...['about:blank','about:home','about:newtab','about:privatebrowsing'].map(url=>({entries:[{url}]}))])
     assert.equal(explicit({spaces:[],tabs:[tab]},empty),true);
   for(const tab of [{entries:[{url:'https://b.invalid/'}]},
     {entries:[{url:'about:home'}],splitViewId:1},{entries:[{url:'about:newtab'}],splitViewId:1},
     {entries:[{url:'about:blank'},{url:'about:blank'}]}]){
     assert.equal(explicit({spaces:[],tabs:[tab]},empty),false);
     assert.equal(explicit({spaces:[],tabs:[tab]},{...bContext,independentProjection:null}),true);
     assert.equal(explicit({tabs:[tab]},{...bContext,independentProjection:{spaces:[bSpace]}}),true);
   }
 });
 await check('deep frozen complete mixed inactive history stays JSON-byte-equivalent',async()=>{
   poisonA();const foreign={spaces:[space('foreign')],tabs:[{zenWorkspace:'foreign-space',entries:[{url:'https://foreign.invalid/old'},{url:'https://foreign.invalid/new'}]}]};
   const unresolved={spaces:[{uuid:'unresolved'}],tabs:[{zenWorkspace:'unresolved'}]};
   const complete={...document,windows:[{...live,_closedTabs:[{state:foreign.tabs[0]}],closedGroups:[{id:'closed-live',tabs:[{state:unresolved.tabs[0]}]}]}],
     _closedWindows:[foreign,unresolved],deferredInitialState:{windows:[unresolved],_closedWindows:[foreign]},
     lastSessionState:{windows:[foreign],deferredInitialState:{windows:[unresolved]}},
     savedGroups:[{id:'saved-foreign',tabs:[{state:foreign.tabs[0]}]}],closedGroups:[{id:'closed-unresolved',tabs:[{state:unresolved.tabs[0]}]}],
     unknownRoot:{windows:[foreign],unresolved,entries:[{unknown:'preserved'}]}};
   const before=JSON.stringify(complete),contextBefore=JSON.stringify(bContext);
   const r=await fixture();await put(r,'sessionstore.jsonlz4',before);
   const reader=await load(r,true),receipt=await read(reader,r);
   assert.equal(receipt.source,before);assert.equal(JSON.stringify(receipt.parsed),before);
   independentEffects(reader);deepFreeze(receipt.parsed);
   deepFreeze(complete);deepFreeze(bContext);
   assert.equal(explicit(receipt.parsed.windows[0]),true);
   assert.equal(JSON.stringify(receipt.parsed),before);
   assert.equal(await fs.readFile(receipt.path,'utf8'),before);
   poison=false;setup();assert.equal(manager.canRestoreState(complete),false);
   // This is restore-refusal coverage, never host qualification of full history.
   const aLive={spaces:[aSpace],tabs:[{zenWorkspace:'A-space'}]};
   assert.equal(manager.canRestoreWindow(aLive),true);
   assert.equal(manager.canRestoreState({...complete,windows:[aLive]}),false);
   assert.equal(manager.canRestoreWindow(foreign),false);
   assert.equal(manager.canRestoreWindow(unresolved),false);
   assert.equal(JSON.stringify(complete),before);assert.equal(JSON.stringify(bContext),contextBefore);
   assert.equal(complete._closedWindows[0].tabs[0].entries[0].url,'https://foreign.invalid/old');
 });
 await check('ordinary recursive guards retain closed nested positive and foreign refusal',()=>{
   poison=false;setup();const local={spaces:[aSpace],tabs:[{zenWorkspace:'A-space'}]};
   assert.equal(manager.canRestoreWindow(local),true);
   assert.equal(manager.isLocalProfileReference(ref('A')),true);
   assert.equal(manager.isLocalProfileReference(ref('B')),false);
   assert.equal(manager.canRestoreState({_closedWindows:[local],lastSessionState:{windows:[local]},deferredInitialState:{windows:[local]}}),true);
   for(const key of ['windows','_closedWindows'])assert.equal(manager.canRestoreState({[key]:[{spaces:[bSpace]}]}),false);
   for(const key of ['lastSessionState','deferredInitialState'])assert.equal(manager.canRestoreState({[key]:{windows:[{spaces:[bSpace]}]}}),false);
   assert.equal(manager.canRestoreState({geckoProfileBindingVersion:2}),false);
   const error=new Error('ordinary programmer failure');
   assert.throws(()=>manager.canRestoreWindow({get spaces(){throw error;}}),e=>e===error);
   setup(null,true,null);assert.equal(manager.canRestoreWindow({get spaces(){throw error;}}),false);
   poison=true;assert.equal(manager.isLocalProfileReference({}),false);
   assert.equal(manager.isLocalProfileReference(ref('A')),false); // original ProfD failure is caught
   accesses.length=0;poisonA();assert.equal(explicit(),true);assert.deepEqual(accesses,[]);
 });
 // Qualification is read/retain evidence, never startup/adoption/save permission.
 const routeTelemetry={qualification:typeof manager.qualifySessionData==='function'?'new readonly seam':'TEST-ONLY window composition comparator (NOT a production aggregate)',
   sidecarReader:typeof manager.readLocalSidecarFromRoot==='function'?'new receipt reader':'absent; reader feature checks not executed'};
 const qualify=(doc,ctx)=>typeof manager.qualifySessionData==='function'
   ? manager.qualifySessionData(doc,ctx)
   : manager.canRestoreWindow(ctx.sidebar,ctx)&&doc.windows.every(w=>manager.canRestoreWindow(w,ctx));
 const fullSpace={...bSpace,uuid:'{bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb}',theme:null,containerTabId:0,hasCollapsedPinnedTabs:false};
 const fullTab={zenWorkspace:fullSpace.uuid,zenSyncId:'b-tab',entries:[
   {url:'https://b.invalid/old',title:'old',hasUserInteraction:true,unknownHistory:{keep:1}},
   {url:'https://b.invalid/current',title:'current',hasUserInteraction:false}],
   index:2,lastAccessed:17,hidden:false,userContextId:0,groupId:'b-group',splitViewId:1,unknownTab:{keep:true}};
 const groups=[{id:'b-group',name:'B group',color:'blue',collapsed:false,saveOnWindowClose:false,pinned:false,essential:false,splitView:true},
   {id:'b-folder',name:'B folder',color:'blue',collapsed:false,pinned:false,essential:false,splitView:false}];
 const folders=[{id:'b-folder',name:'B folder',pinned:false,essential:false,splitViewGroup:false,collapsed:false,saveOnWindowClose:false,
   parentId:null,prevSiblingInfo:{type:'start',id:null},emptyTabIds:[],isLiveFolder:false,workspaceId:fullSpace.uuid,unknownFolder:'kept'}];
 const splitViewData=[{groupId:'b-group',gridType:'vsep',tabs:['b-tab','b-tab2'],layoutTree:{type:'splitter',direction:'row',
   children:[{type:'leaf',tabId:'b-tab',sizeInParent:50},{type:'leaf',tabId:'b-tab2',sizeInParent:50}]}}];
 const layouts={groups,folders,splitViewData,splitViews:[{id:1,numberOfTabs:2}]};
 const fullTabs=[fullTab,{...structuredClone(fullTab),zenSyncId:'b-tab2'}];
 const fullSide={geckoProfileBindingVersion:1,lastCollected:17,spaces:[fullSpace],tabs:fullTabs,...layouts,unknown:{retained:true}};
 const dormant=descriptor=>({spaces:[space(descriptor)],tabs:[{...fullTab,zenWorkspace:descriptor+'-space',unknownDormant:descriptor}],
   closedAt:19,closedId:23,unknownWindow:{keep:descriptor}});
 const foreign=dormant('foreign'),unresolved=dormant('unresolved');
 const wrapped=tab=>({state:tab,pos:0,closedAt:19,closedId:29,unknownWrapper:{kept:true}});
 const fullDoc={version:['sessionrestore',1],geckoProfileBindingVersion:1,
   windows:[{tabs:fullTabs,...layouts,_closedTabs:[wrapped(foreign.tabs[0])],closedGroups:[{id:'closed',tabs:[wrapped(unresolved.tabs[0])]}]}],
   selectedWindow:1,maxSplitViewId:1,session:{lastUpdate:17,startTime:1,recentCrashes:0},global:{keep:'global'},cookies:[],
   _closedWindows:[foreign,unresolved],savedGroups:[{id:'saved',saved:true,closedAt:19,tabs:[wrapped(foreign.tabs[0])],splitViews:[]}],
   deferredInitialState:{windows:[unresolved],_closedWindows:[foreign]},lastSessionState:{windows:[foreign],deferredInitialState:{windows:[unresolved]}},
   unknownRoot:{windows:[foreign],unresolved,entries:[{unknown:'preserved'}]}};
 const docText=JSON.stringify(fullDoc),sideText=JSON.stringify(fullSide);
 await fs.writeFile(path.join(fixtureRoot,'qualification-originals.json'),JSON.stringify({fullDoc,fullSide}),{mode:0o600});
 deepFreeze(fullDoc);deepFreeze(fullSide);
 for(const [name,counter] of [['readFile','readFile'],['onFileRead','onFileRead'],['init','init'],['saveState','writer'],
   ['onCrashCheckpoints','migration'],['onNewWindow','adoption']])manager[name]=()=>effect(counter);
 const reset=()=>{accesses.length=0;for(const k of Object.keys(effects))effects[k]=0;poisonA();};
 const clean=()=>{assert.deepEqual(accesses,[]);assert.ok(Object.values(effects).every(n=>n===0),JSON.stringify(effects));};
 async function qualifyCase(name,change,expected) {
   await check('qualification: '+name,async()=>{
     reset();const doc=structuredClone(fullDoc),side=structuredClone(fullSide),ctx={...bContext,sidebar:side};
     change(doc,side,ctx);const beforeDoc=JSON.stringify(doc),beforeSide=JSON.stringify(side);
     deepFreeze(doc);deepFreeze(side);deepFreeze(ctx);
     const result=qualify(doc,ctx);
     assert.equal(JSON.stringify(doc),beforeDoc);assert.equal(JSON.stringify(side),beforeSide);clean();
     assert.equal(result,expected);
   });
 }
 await check('qualification: genuine binding-only capability gap',async()=>{
   reset();const r=await fixture();await put(r,'sessionstore.jsonlz4',docText);await put(r,'zen-sessions.jsonlz4',sideText);
   const reader=await load(r,true),receipt=await read(reader,r);managerAdapter=reader;
   const sideReceipt=typeof manager.readLocalSidecarFromRoot==='function'
     ? await manager.readLocalSidecarFromRoot(new FileModel('B',r),budgets) : {parsed:structuredClone(fullSide)};
   const ctx={...bContext,sidebar:sideReceipt.parsed};deepFreeze(receipt.parsed);deepFreeze(ctx);
   assert.equal(manager.canRestoreWindow(ctx.sidebar,ctx),true);
   assert.ok(receipt.parsed.windows.every(w=>manager.canRestoreWindow(w,ctx)));
   assert.equal(qualify(receipt.parsed,ctx),true);
   const bad={...sideReceipt.parsed,geckoProfileBindingVersion:2};const badCtx=deepFreeze({...ctx,sidebar:bad});
   assert.equal(manager.canRestoreWindow(bad,badCtx),true,'window primitive correctly remains marker-agnostic');
   const actual=qualify(receipt.parsed,badCtx);
   assert.equal(JSON.stringify(receipt.parsed),docText);assert.equal(JSON.stringify(sideReceipt.parsed),sideText);
   assert.equal(await fs.readFile(receipt.path,'utf8'),docText);assert.equal(await fs.readFile(path.join(r,'zen-sessions.jsonlz4'),'utf8'),sideText);
   clean();independentEffects(reader);
   console.log(JSON.stringify({capabilityGap:{route:routeTelemetry.qualification,validWindowComposition:true,binding2WindowPrimitive:true,desiredQualification:false,actual}}));
   assert.equal(actual,false,'binding-only unsupported sidecar must refuse read/retain qualification');
 });
 await qualifyCase('complete foreign dormant retained with B sidecar fallback',()=>{},true);
 await qualifyCase('all live B windows admitted',(d)=>{d.windows.push({...structuredClone(d.windows[0]),spaces:[structuredClone(fullSpace)],isPrivate:true});},true);
 await qualifyCase('current producer root tree size omitted and nullable DOM attributes',(d,s)=>{
   for(const x of [d.windows[0],s]){delete x.splitViewData[0].layoutTree.sizeInParent;x.tabs[0].zenWorkspace=null;x.tabs[0].zenSyncId=null;}
 },true);
 await qualifyCase('optional producer fields omitted',(d,s)=>{for(const x of [d.windows[0],s]){for(const k of ['groups','folders','splitViewData','splitViews'])delete x[k];
   for(const t of x.tabs){for(const k of ['index','hidden','lastAccessed','userContextId','groupId','splitViewId'])delete t[k];t.entries=[];}}},true);
 await qualifyCase('ordinary mixed dormant refusal stays false',()=>{poison=false;setup();assert.equal(manager.canRestoreState(fullDoc),false);
   assert.equal(manager.canRestoreState({windows:[{spaces:[aSpace],tabs:[]}]}),true);poisonA();},true);
 const variants=[
   ['explicit root',(_,s,c)=>c.profileRoot=null],['blocked',(_,s,c)=>c.profileBindingBlocked=true],
   ['missing context field',(_,s,c)=>delete c.windowSyncEnabled],['side unresolved tab',(_,s)=>s.tabs[0].zenWorkspace='missing'],
   ['live tabs type',(d)=>d.windows[0].tabs=null],['live window type',(d)=>d.windows.push(null)],
   ['binding2',(_,s)=>s.geckoProfileBindingVersion=2],['side version',(_,s)=>s.version=1],
   ['missing side binding',(_,s)=>delete s.geckoProfileBindingVersion],['marker',(_,s)=>s.zenIndependentCatalog={}],
   ['authority',(_,s)=>s.zenCatalogId='x'],['projection',(_,s,c)=>c.independentProjection={spaces:[fullSpace]}],
   ['side spaces type',(_,s)=>s.spaces=null],['side tabs type',(_,s)=>s.tabs={}],['empty spaces',(_,s)=>s.spaces=[]],
   ['lastCollected',(_,s)=>s.lastCollected=Infinity],['space name',(_,s)=>s.spaces[0].name=7],
   ['space duplicate',(_,s)=>s.spaces.push(structuredClone(s.spaces[0]))],
   ['root binding',(d)=>d.geckoProfileBindingVersion=2],['legacy tuple',(d)=>d.version=['sessionrestore',0]],
   ['string tuple',(d)=>d.version=['sessionrestore','1']],['missing version',(d)=>delete d.version],
   ['long tuple',(d)=>d.version.push(1)],['no live',(d)=>d.windows=[]],['missing live',(d)=>delete d.windows],
   ['side live entry',(_,s)=>s.tabs[0].entries=[null]],['live entry',(d)=>d.windows[0].tabs[0].entries=[{url:7}]],
   ['live entries type',(d)=>d.windows[0].tabs[0].entries={}],['live bool',(d)=>d.windows[0].tabs[0].hidden='false'],
   ['live numeric',(d)=>d.windows[0].tabs[0].index='2'],['live fractional history index',(d)=>d.windows[0].tabs[0].index=0.5],
   ['live unresolved workspace',(d)=>d.windows[0].tabs[0].zenWorkspace='missing'],
   ['folder foreign workspace',(d)=>d.windows[0].folders[0].workspaceId='foreign-space'],
   ['folder emptyTabIds',(d)=>d.windows[0].folders[0].emptyTabIds=null],['group shape',(d)=>d.windows[0].groups=[null]],
   ['group duplicate',(d)=>d.windows[0].groups.push(structuredClone(groups[0]))],
   ['Zen legacy layout',(d)=>delete d.windows[0].splitViewData[0].layoutTree],
   ['Zen layout children',(d)=>d.windows[0].splitViewData[0].layoutTree.children=null],
   ['Gecko split distinct format',(d)=>d.windows[0].splitViews=[{groupId:'b-group',layoutTree:{}}]],
 ];
 for(const value of [undefined,null,[]])variants.push(['own spaces '+String(value),(d)=>d.windows[0].spaces=value]);
 for(const descriptor of ['foreign','unresolved'])for(const flag of [null,'isPrivate','isPopup','isTaskbarTab','isZenUnsynced'])
   variants.push(['all live owner '+descriptor+' '+flag,(d)=>{const w={...structuredClone(d.windows[0]),spaces:[space(descriptor)]};
     if(flag)w[flag]=true;d.windows.push(w);}]);
 for(const [name,change] of variants)await qualifyCase(name,change,false);
 for(const placement of ['sidecar','live-window'])await check('qualification: ordinary wide JSON '+placement+' refuses without throw readonly',()=>{
   reset();const doc=JSON.parse(docText),side=JSON.parse(sideText);
   const width=1000000,cap=8388608;
   const target=placement==='sidecar'?side:doc.windows[0];
   target.splitViewData[0].layoutTree=JSON.parse('{"type":"splitter","direction":"row","children":['+'null,'.repeat(width-1)+'null]}');
   const beforeDoc=JSON.stringify(doc),beforeSide=JSON.stringify(side);
   assert.ok(Buffer.byteLength(beforeDoc)<cap);assert.ok(Buffer.byteLength(beforeSide)<cap);
   const ctx={...bContext,sidebar:side};deepFreeze(doc);deepFreeze(side);deepFreeze(ctx);
   let result,error;
   try {result=manager.qualifySessionData(doc,ctx);} catch(caught) {error=caught;}
   const unchanged=JSON.stringify(doc)===beforeDoc&&JSON.stringify(side)===beforeSide;
   clean();assert.equal(unchanged,true);
   console.log(JSON.stringify({wideJSON:{placement,width,explicitExampleCap:cap,
     doc:{bytes:Buffer.byteLength(beforeDoc),sha256:digest(beforeDoc)},
     side:{bytes:Buffer.byteLength(beforeSide),sha256:digest(beforeSide)},
     unchanged,effects:{...effects},result:result===undefined?null:result,
     thrown:error?{name:error.name,message:error.message,stack:error.stack}:null}}));
   if(error)throw error;
   assert.equal(result,false);
 });
 if(typeof manager.readLocalSidecarFromRoot==='function') {
   const readSide=async(r,x,root,opts=budgets)=>{managerAdapter=x;return manager.readLocalSidecarFromRoot(root,opts);};
   await check('qualification: strict parsed cache reconstruction retained separately from raw',async()=>{
     reset();const r=await fixture(),cached=structuredClone(fullDoc);cached.windows[0].tabs[0].image=7;cached._cachedObjs=[[7,'reconstructed-image']];
     const raw=JSON.stringify(cached);await put(r,'sessionstore.jsonlz4',raw);await put(r,'zen-sessions.jsonlz4',sideText);
     const x=await load(r,true),receipt=await read(x,r),side=await readSide(r,x,new FileModel('B',r));
     const expected=structuredClone(cached);expected.windows[0].tabs[0].image='reconstructed-image';
     const parsedBefore=JSON.stringify(receipt.parsed);assert.equal(parsedBefore,JSON.stringify(expected));assert.notEqual(parsedBefore,raw);
     assert.equal(receipt.source,raw);assert.equal(receipt.rawSHA256,digest(raw));
     const ctx=deepFreeze({...bContext,sidebar:side.parsed});deepFreeze(receipt.parsed);
     assert.equal(manager.qualifySessionData(receipt.parsed,ctx),true);
     assert.equal(JSON.stringify(receipt.parsed),parsedBefore);assert.equal(await fs.readFile(receipt.path,'utf8'),raw);clean();independentEffects(x);
   });
   await check('sidecar receipt: complete raw digest captured paths and caps across await',async()=>{
     reset();const r=await fixture();await put(r,'zen-sessions.jsonlz4',sideText);const x=await load(r,true);
     const root=new FileModel('B',r),opts={...budgets};let release;const barrier=new Promise(r=>release=r);x.hold(()=>barrier);
     const pending=readSide(r,x,root,opts);root.path='/changed';opts.maxFileBytes=0;opts.maxDecompressedBytes=0;release();
     const v=await pending;assert.equal(v.root,r);assert.equal(v.path,path.join(r,'zen-sessions.jsonlz4'));
     assert.equal(v.rawSHA256,digest(sideText));assert.equal(v.rawLength,Buffer.byteLength(sideText));assert.equal(JSON.stringify(v.parsed),sideText);
     assert.equal(x.calls.reads.length,1);assert.equal(x.calls.decodes.length,1);
     assert.equal(x.calls.decodes[0].options.expectedSHA256,v.rawSHA256);assert.equal(x.calls.decodes[0].options.decompress,true);
     assert.equal(x.calls.decodes[0].options.maxFileBytes,budgets.maxFileBytes);assert.equal(x.calls.decodes[0].options.maxDecompressedBytes,budgets.maxDecompressedBytes);
     assert.deepEqual(x.calls.crypto,['createInstance','init',{updateLength:v.rawLength},'finish']);clean();independentEffects(x);
   });
   await check('sidecar receipt: invalid explicit paths and positive uint32 caps zero I/O',async()=>{
     reset();const r=await fixture(),x=await load(r,true);
     for(const root of [null,undefined,{},r,new FileModel('B',''),new FileModel('B','relative'),new FileModel('B',7)])await assert.rejects(readSide(r,x,root));
     for(const field of Object.keys(budgets))for(const bad of [undefined,null,0,-1,.5,NaN,Infinity,4294967296,'1',true])
       await assert.rejects(readSide(r,x,new FileModel('B',r),{...budgets,[field]:bad}));
     managerAdapter=x;await assert.rejects(manager.readLocalSidecarFromRoot(new FileModel('B',r)));
     assert.equal(x.calls.reads.length,0);assert.equal(x.calls.decodes.length,0);clean();
   });
   for(const fault of ['missing','replace','delete','createInstance','init','update','finish','decode','parse','rawcap','decodedcap'])
     await check('sidecar receipt: refuses '+fault+' without recovery',async()=>{
       reset();const r=await fixture();let expected=sideText;await put(r,'zen-sessions.jsonlz4',sideText);
       await put(r,'recovery.jsonlz4',sideText);const x=await load(r,true),p=path.join(r,'zen-sessions.jsonlz4');let opts=budgets;
       if(fault==='missing'){await fs.unlink(p);expected=null;}
       if(fault==='replace'){expected=sideText.replace('retained','replaced');assert.equal(Buffer.byteLength(expected),Buffer.byteLength(sideText));x.beforeDecode(()=>fs.writeFile(p,expected));}
       if(fault==='delete'){expected=null;x.beforeDecode(()=>fs.unlink(p));}
       if(['createInstance','init','update','finish'].includes(fault))x.cryptoError(new Error('hash '+fault),fault);
       if(fault==='decode'){expected=Buffer.from([255]);await fs.writeFile(p,expected);}
       if(fault==='parse'){expected='{';await fs.writeFile(p,expected);}
       if(fault==='rawcap')opts={...budgets,maxFileBytes:1};
       if(fault==='decodedcap')opts={...budgets,maxDecompressedBytes:1};
       await assert.rejects(readSide(r,x,new FileModel('B',r),opts));
       assert.equal(x.calls.reads.length,1);assert.ok(x.calls.decodes.length<=1);
       if(expected===null)await assert.rejects(fs.readFile(p),e=>e.code==='ENOENT');
       else assert.deepEqual(await fs.readFile(p),Buffer.from(expected));
       assert.equal(await fs.readFile(path.join(r,'recovery.jsonlz4'),'utf8'),sideText);clean();independentEffects(x);
     });
 }
 console.log(JSON.stringify({routeTelemetry,effects,moduleInitPrefReads:1}));
 console.log(JSON.stringify({managerOracle:{sourceSHA256:digest(managerSource),generatedSHA256:digest(generated),
   shimSHA256:digest(shim),productionBodiesUnchanged:true,adapter:'Node nsIFile/IOUtils/crypto model; diagnostic-only private setup; real owned FS and SHA256; no native restore/save',poisonAccesses:accesses}},null,2));
}
console.log(JSON.stringify({runtime:process.version,codec:'owned decoded-text IOUtils adapter with real Node SHA256; nsICryptoHash and frozen IOUtils C++ NOT compiled/executed; native MozLZ4 untested',events,count:events.length,passed:events.filter(e=>e.status==='PASS').length},null,2));
process.exitCode=events.some(e=>e.status!=='PASS')?1:0;
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'store', 'fixtures', 'node'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--zen-source', type=Path, help='optional Manager source predicate oracle')
    parser.add_argument('--ioutils-cpp', type=Path)
    args = parser.parse_args()
    if args.ioutils_cpp is None:
        args.ioutils_cpp = args.source.parents[3] / 'xpcom/ioutils/IOUtils.cpp'
    root = args.fixtures.absolute()
    projects = Path('/Users/kenkuang/.hermes/projects')
    if projects not in root.parents or root.exists():
        parser.error('--fixtures must be a fresh directory under ~/.hermes/projects')
    root.mkdir(mode=0o700)
    bindings = {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in (args.source, args.store, args.ioutils_cpp, Path(__file__), *([args.zen_source] if args.zen_source else []))}
    print(json.dumps({'inputs': bindings, 'node': str(args.node)}, sort_keys=True), flush=True)
    node_env = {key: os.environ[key] for key in
                ('HOME', 'PATH', 'TMPDIR', 'PYTHONDONTWRITEBYTECODE') if key in os.environ}
    print(json.dumps({'nodeEnvironment': node_env}), flush=True)
    command = [str(args.node), '--experimental-vm-modules',
               '--input-type=module', '-e', JS,
               str(args.source), str(args.store), str(root),
               str(args.zen_source) if args.zen_source else '', str(args.ioutils_cpp)]
    print(json.dumps({'nodeCommand': command}), flush=True)
    process = subprocess.Popen(command, env=node_env)
    print(json.dumps({'nodePID': process.pid}), flush=True)
    returncode = process.wait()
    print(json.dumps({'nodePID': process.pid, 'waitReturnCode': returncode}), flush=True)
    return returncode


if __name__ == '__main__':
    raise SystemExit(main())
