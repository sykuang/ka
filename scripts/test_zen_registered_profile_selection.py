#!/usr/bin/env python3
"""Offline source contracts and actual SessionManager body with inert native API.

Input is one explicit JSON source bundle on stdin, supplied by a pin-checking
collector. No product files, native helpers, compiler or browser are opened.
Native behavior and XPIDL compilation remain UNVERIFIED.
"""
import os, sys
_BOOTSTRAP_KEYS = sorted(os.environ)
os.environ.clear()
os.environ.update(HOME='/Users/kenkuang', PATH='/usr/bin:/bin',
                  TMPDIR='/Users/kenkuang/.hermes/cache/scratch', PYTHONDONTWRITEBYTECODE='1')
import json
assert len(sys.argv) == 3 and sys.argv[1] == '--receipt-dir', 'usage: test_zen_registered_profile_selection.py --receipt-dir OWNED_OUTPUT < source-bundle.json'
OWN_ROOT = sys.argv[2]
assert os.path.isabs(OWN_ROOT)
with open(OWN_ROOT + '/oracle-bootstrap-' + str(os.getpid()) + '.json', 'w') as _f:
    json.dump({'pid': os.getpid(), 'bootstrapKEYNAMES': _BOOTSTRAP_KEYS,
               'environment': dict(os.environ)}, _f)
    _f.flush()
    os.fsync(_f.fileno())

import re
import subprocess
import sys

NODE = '/Users/kenkuang/.local/share/mise/installs/node/22.22.0/bin/node'
CPP = 'engine/toolkit/profile/nsToolkitProfileService.cpp'
IDL = 'engine/toolkit/profile/nsIToolkitProfileService.idl'
JS = 'src/zen/sessionstore/ZenSessionManager.sys.mjs'


def definition(source, marker):
    """Brace-balanced body, ignoring quoted literals and C/JS comments."""
    start = source.index(marker)
    opening = source.index('{', start)
    level, i = 0, opening
    while i < len(source):
        c = source[i]
        if source.startswith('//', i):
            end = source.find('\n', i + 2)
            i = len(source) if end < 0 else end
            continue
        if source.startswith('/*', i):
            i = source.index('*/', i + 2) + 2
            continue
        if c in '\"\'`':
            quote = c
            i += 1
            while i < len(source):
                if source[i] == '\\':
                    i += 2
                elif source[i] == quote:
                    i += 1
                    break
                else:
                    i += 1
            else:
                raise AssertionError('unterminated quoted literal')
            continue
        if c == '{':
            level += 1
        elif c == '}':
            level -= 1
            if level == 0:
                return source[start:i + 1]
        i += 1
    raise AssertionError('unterminated body')


def selftest():
    sample = 'f() { const s = "}\\\"{"; /* } */ if (1) { // }\n return `{}`; } } tail'
    assert definition(sample, 'f()') == sample[:-5]
    assert definition('f() { return \'{\'; } g() {}', 'g()') == 'g() {}'
    try:
        definition('f() {', 'f()')
    except AssertionError:
        pass
    else:
        raise AssertionError('extractor accepted missing close')
    print('PASS extractor lexical self-controls', flush=True)


def check(sources):
    selftest()
    cpp, idl, js = (sources[p] for p in (CPP, IDL, JS))
    old = definition(cpp, 'nsToolkitProfileService::GetZenCatalogProfileDirectory(')
    for token in ('ReadIniFile(mProfileDBFile', 'ReadIniFile(mInstallDBFile',
                  '/* aStrictQuery */ true', 'InitFromString', '!containedErrors',
                  'BackgroundTasks::GetProfilePrefix', '"zen_catalog"_ns',
                  'leaf.CharAt(8)', 'IsSymlink', 'IsDirectory', 'mProfiles',
                  'file.forget(aResult)'):
        assert token in old, ('original catalog control lost', token)
    assert 'NS_DECL_NSITOOLKITPROFILESERVICE' in sources['engine/toolkit/profile/nsToolkitProfileService.h']
    assert '"1",false,"",true,"","0"' in sources['scripts/test_zen_profile_host_control.py']
    for name in ('getCurrentProfileReference()', 'isLocalProfileReference(',
                 'canRestoreState(', 'getClonedSpaces('):
        assert name in js
    owner = definition(js, '#catalogOwnerSnapshot(')
    assert js.count('this.#catalogOwnerSnapshot(') == (7 if 'getCurrentProfileHostSelection' in idl else 5)
    activate = definition(js, 'async activateIndependentCatalog(')
    upsert = definition(js, 'async #upsertIndependentCatalogSpace(')
    assert 'catch (error)' in activate and 'catch (error)' in upsert
    assert 'return {' in upsert and '"REFUSED"' in upsert
    print('PASS retained original catalog/host-literal/caller controls', flush=True)
    # First expected baseline RED: the actual private owner lacks fresh selection.
    assert 'service.getRegisteredProfileHostSelection(' in owner, (
        'MISSING actual fresh registered-selection consumer/native endpoint')
    assert 'nsToolkitProfileService::GetRegisteredProfileHostSelection(' in cpp, 'MISSING native endpoint'
    signature = re.search(r'nsIFile getRegisteredProfileHostSelection\((.*?)\);', idl, re.S)
    assert signature
    args = re.sub(r'\s+', ' ', signature.group(1)).strip()
    assert args == ('in AUTF8String descriptor, out nsIFile authority, out nsIFile local, '
                    'out AUTF8String name, out AUTF8String path, out AUTF8String isRelative, '
                    'out boolean storeIDPresent, out AUTF8String storeID, '
                    'out boolean showSelectorPresent, out AUTF8String showSelector')
    getter = definition(cpp, 'static nsresult ReadRegisteredProfileHostSelection(' if 'static nsresult ReadRegisteredProfileHostSelection(' in cpp else 'nsToolkitProfileService::GetRegisteredProfileHostSelection(')
    for token in ('ReadIniFile(mProfileDBFile', 'ReadIniFile(mInstallDBFile',
                  '/* aStrictQuery */ true', 'InitFromString', '!containedErrors',
                  'GetSections', '"Name"', '"Path"', '"IsRelative"', '"StoreID"',
                  '"ShowSelector"', 'GetLocalDirFromRootDir(', 'mAppData->Clone(',
                  'NS_ERROR_DATABASE_CHANGED', 'GetPersistentDescriptor',
                  'CheckRegisteredSelectionPath', 'NormalizeCatalogPath',
                  'IsCatalogAncestor', 'GetZenCatalogProfileDirectory(',
                  'storeIDPresent', 'showSelectorPresent'):
        assert token in getter, ('native source contract', token)
    for token in ('CreateProfile(', 'Flush(', 'SetDefault', 'SelectStartup',
                  'mProfileDB.', 'mProfileDBPreimage =', 'mCaptureSerial',
                  'mProfileDBModifiedTime =', 'ProfileRegistryLease', 'NS_LockProfilePath',
                  'GetProfileByDir(', 'GetProfileDescriptor('):
        assert token not in getter, ('readonly boundary', token)
    publish = getter.index('authority.forget(aAuthority)')
    for token in ('verifiedProfiles', 'verifiedInstalls', 'root->Clone(', 'local->Clone('):
        assert getter.index(token) < publish, ('partial output publication', token)
    for field in ('authority', 'local', 'name', 'path', 'isRelative',
                  'storeIDPresent', 'storeID', 'showSelectorPresent', 'showSelector'):
        assert field in owner, ('selection ignored', field)
    assert 'previous.selections' in owner
    assert 'this.isLocalProfileReference(' in owner
    print('PASS native/XPIDL/read-only/publication source contracts (not compilation)', flush=True)
    extra_contracts(sources)
    adapter(js)


def adapter(js):
    imports = [
        'import { JSONFile } from "resource://gre/modules/JSONFile.sys.mjs";',
        'import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";',
    ]
    for line in imports:
        assert js.count(line) == 1
        js = js.replace(line, '')
    assert not re.search(r'^\s*import\s', js, re.M), 'unexpected module import'
    js = js.replace('export class nsZenSessionManager', 'class nsZenSessionManager')
    js = js.replace('export const ZenSessionStore', 'const ZenSessionStore')
    shim = '''
  __snapshot(...args) { return this.#catalogOwnerSnapshot(...args); }
  __fixture(file, projection, sidebar) {
    this.#startupAdmissionComplete = true;
    this.#file = file;
    this.#independentProjection = projection;
    this.#sidebar = sidebar;
  }
'''
    at = js.rindex('\n}\n')
    augmented = js[:at] + shim + js[at:]
    assert augmented[:at] + augmented[at+len(shim):] == js
    program = ADAPTER_PREFIX.replace('__RECEIPT_DIR__', json.dumps(OWN_ROOT)) + augmented + ADAPTER_CASES
    child = subprocess.Popen([NODE, '--input-type=commonjs'], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, env=dict(os.environ))
    stdout, stderr = child.communicate(program)
    with open(OWN_ROOT + '/NODE-WAITS.jsonl', 'a') as f:
        f.write(json.dumps({'pid': child.pid, 'wait': child.returncode}) + '\n')
    print(stdout, end='', flush=True)
    if stderr:
        print(stderr, file=sys.stderr, end='', flush=True)
    assert child.returncode == 0, ('actual JS adapter wait', child.returncode)



ADAPTER_PREFIX = r'''
'use strict';
const fs = require('node:fs');
const bootstrapKeys = Object.keys(process.env).sort();
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, {HOME:'/Users/kenkuang',PATH:'/usr/bin:/bin',TMPDIR:'/Users/kenkuang/.hermes/cache/scratch',PYTHONDONTWRITEBYTECODE:'1'});
const receipt = fs.openSync(__RECEIPT_DIR__+'/node-bootstrap-'+process.pid+'.json','w');
fs.writeFileSync(receipt, JSON.stringify({pid:process.pid,bootstrapKEYNAMES:bootstrapKeys,environment:process.env}));fs.fsyncSync(receipt);fs.closeSync(receipt);
const assert = require('node:assert/strict');
// Owned endpoint double: no real file/profile/native IO. Identity is inert.
class File {
  constructor(path, identity=path) { this.path=path; this.id=identity; }
  get persistentDescriptor() { return this.path; }
  set persistentDescriptor(v) { this.path=v; this.id=v; }
  equals(f) { return !!f && f.id===this.id; }
  contains(f) { return f.path.startsWith(this.path+'/'); }
  clone() { return Object.assign(new File(this.path,this.id),this); }
  isSymlink() { return !!this.link; }
  isDirectory() { return !this.notDirectory; }
  exists() { return !this.missing; }
}
const A=new File('/authority/Profiles/A'), B=new File('/authority/Profiles/B');
const AL=new File('/cache/A'), BL=new File('/cache/B');
const AUTH=new File('/authority'), CATALOG=new File('/authority/Background Tasks Profiles/catalog');
let calls=[], effects=0, endpointError=null, change=null, outdated=false;
const selections = new Map();
function reset() {
  calls=[]; effects=0; endpointError=null; change=null; outdated=false;
  selections.clear();
  for (const [root,local] of [[A,AL],[B,BL]]) selections.set(root.path,{
    root:root.clone(), authority:AUTH.clone(), local:local.clone(), name:'',
    path:'Profiles/'+root.path.split('/').pop(),isRelative:'1',
    storeIDPresent:false,storeID:'',showSelectorPresent:true,showSelector:'',
  });
}
const service = {
  get isListOutdated() { return outdated; },
  get profiles() { throw new Error('resident enumeration is not fresh registration'); },
  getZenCatalogProfileDirectory() { return CATALOG.clone(); },
  getLocalDirFromRootDir(root) { return (root.equals(A)?AL:BL).clone(); },
  getRegisteredProfileHostSelection(descriptor,...out) {
    calls.push(descriptor);
    if(endpointError) throw endpointError;
    const s=selections.get(descriptor); if(!s) throw new TypeError('unregistered');
    const keys=['authority','local','name','path','isRelative','storeIDPresent','storeID','showSelectorPresent','showSelector'];
    assert.equal(out.length,keys.length);
    keys.forEach((key,i)=>{out[i].value=s[key] instanceof File?s[key].clone():s[key];});
    return s.root.clone();
  },
};
const Ci={nsIFile:File,nsIToolkitProfileService:{},nsIToolkitProfile:{}};
const Cc=new Proxy({}, {get(_target,key){
  if(key==='@mozilla.org/toolkit/profile-service;1') return {getService(){return service;}};
  if(key==='@mozilla.org/file/local;1') return {createInstance(){return new File('');}};
  throw new Error('unapproved endpoint '+key);
}});
let localSpaces=[{uuid:'a',name:'local',geckoProfileReference:{version:1,persistentDescriptor:A.path}}];
let foreignSpace={uuid:'b',name:'foreign',geckoProfileReference:{version:1,persistentDescriptor:B.path}};
let windowRecord={tabs:[],spaces:localSpaces};
let manager={canRenameIndependentCatalogSpace:true,ownerWindow:null,activeWorkspace:'a',
  getWorkspaces(){return localSpaces;},allStoredTabs:[]};
let win={closed:false,gZenWorkspaces:manager,gBrowserInit:{delayedStartupFinished:true},__SSi:'one'};
manager.ownerWindow=win;
const SessionStoreFixture={_windows:{one:windowRecord},getCurrentState(){return {windows:[windowRecord]};}};
const Services={
  prefs:{getBoolPref(key,value){assert.equal(key,'zen.session-store.backup-file');return value;}},
  dirsvc:{get(key){assert.ok(key==='ProfD'||key==='ProfLD');return (key==='ProfD'?A:AL).clone();}},
  wm:{getEnumerator(){return [win];}},uuid:{generateUUID(){effects++;return 'owned-id';}},
};
const Cu={cloneInto(v){return structuredClone(v);},reportError(){}};
const JSONFile=class {constructor(){throw new Error('unapproved JSONFile constructor');}};
const XPCOMUtils={defineLazyPreferenceGetter(target,key,_pref,value){target[key]=value;}};
const ChromeUtils={defineESModuleGetters(target){Object.assign(target,{
  gWindowSyncEnabled:true,PrivateBrowsingUtils:{permanentPrivateBrowsing:false},
  SessionStore:SessionStoreFixture,
  async readCatalogMetadata(){if(change)change();return {zenCatalogId:'catalog',zenCatalogRevision:7,spaces:[...localSpaces,foreignSpace]};},
  async requestZenCatalogCommit(){effects++;throw new Error('unexpected commit');},
});},importESModule(){throw new Error('unapproved dynamic import');}};
const IOUtils=new Proxy({}, {get(){return ()=>{effects++;throw new Error('unexpected IO');};}});
const PathUtils={profileDir:A.path};
'''

ADAPTER_CASES = r'''
(async()=>{
const subject=new nsZenSessionManager();
const catalog={zenCatalogRevision:7,spaces:[...localSpaces,foreignSpace]};
let count=0;
function pass(name){count++;console.log('PASS actual-JS inert-native '+name);}
reset();
const first=subject.__snapshot(A.clone(),A.path,catalog);
assert.deepEqual([...first.roots.keys()],[A.path,B.path]);
assert.deepEqual(new Set(calls),new Set([A.path,B.path]));
assert.equal(first.selections.get(B.path).isRelative,'1');
assert.equal(first.selections.get(B.path).storeIDPresent,false);
assert.equal(first.selections.get(B.path).showSelectorPresent,true);
assert.equal(first.selections.get(B.path).showSelector,'');
assert.notEqual(first.roots.get(B.path),B);
subject.__snapshot(A.clone(),A.path,catalog,first);
assert.equal(effects,0);pass('valid local and foreign; absent vs present-empty raw literals; detached and re-admitted');
for(const key of ['name','path','isRelative','storeIDPresent','storeID','showSelectorPresent','showSelector']){
 reset();const old=subject.__snapshot(A,A.path,catalog);
 const s=selections.get(B.path);
 if(key==='name')s.name='renamed';if(key==='path')s.path='Profiles/../Profiles/B';
 if(key==='isRelative')s.isRelative='0';if(key==='storeIDPresent')s.storeIDPresent=true;
 if(key==='storeID'){s.storeIDPresent=true;s.storeID='new';}
 if(key==='showSelectorPresent')s.showSelectorPresent=false;if(key==='showSelector')s.showSelector='1';
 assert.throws(()=>subject.__snapshot(A,A.path,catalog,old),TypeError);
 assert.equal(effects,0);pass('equal-revision literal/presence remap '+key);
}
for(const kind of ['authority','local','root','alias','catalog','symlink','nonregular','unregistered','isRelative','missing','unknown','version','localCurrent','ancestor','authorityAlias','absentNonempty']){
 reset();const old=subject.__snapshot(A,A.path,catalog);let input=structuredClone(catalog);
 const s=selections.get(B.path);
 if(kind==='authority')s.authority=new File('/other-authority');
 if(kind==='local')s.local=new File('/wrong-local');
 if(kind==='root')s.root=new File('/moved');
 if(kind==='alias')s.root=new File(B.path,A.id);
 if(kind==='catalog')s.root=CATALOG.clone();
 if(kind==='symlink')s.local.link=true;
 if(kind==='nonregular')s.root.notDirectory=true;
 if(kind==='unregistered')selections.delete(B.path);
 if(kind==='isRelative')s.isRelative=true;
 if(kind==='missing')s.path=undefined;
 if(kind==='unknown')input.spaces[1].geckoProfileReference.persistentDescriptor='/unknown';
 if(kind==='version')input.spaces[1].geckoProfileReference.version=2;
 if(kind==='localCurrent')selections.get(A.path).local=BL.clone();
 if(kind==='ancestor')s.local=AUTH.clone();
 if(kind==='authorityAlias')s.authority=B.clone();
 if(kind==='absentNonempty')s.storeID='not-absent';
 assert.throws(()=>subject.__snapshot(A,A.path,input,old));
 assert.equal(effects,0);pass('refuses '+kind+' without effects');
}
reset();outdated=true;assert.throws(()=>subject.__snapshot(A,A.path,catalog));pass('stale resident registry refuses');
reset();const originalError=new Error('original inert IO error');endpointError=originalError;
assert.throws(()=>subject.__snapshot(A,A.path,catalog),e=>e===originalError);pass('native endpoint original error preserved privately');
// Ordinary local restore and sidebar never consult the new endpoint.
reset();endpointError=new Error('must not consult native');
subject.__fixture({},null,{tabs:[],spaces:localSpaces});
assert.equal(subject.canRestoreWindow({tabs:[],spaces:localSpaces}),true);
assert.deepEqual(subject.getClonedSpaces(),localSpaces);assert.equal(calls.length,0);assert.equal(effects,0);
pass('ordinary restore/sidebar/getClonedSpaces unchanged without endpoint');
// Actual mutation caller owns private admission refusal before effects.
for(const timing of ['initial','after-read']) {
 reset();const marker={zenCatalogId:'catalog',zenCatalogRevision:7};
 subject.__fixture({}, {marker,spaces:localSpaces},{tabs:[],spaces:localSpaces});
 if(timing==='initial')endpointError=new Error('missing registered owner');
 else change=()=>{selections.get(B.path).path='changed';selections.delete(B.path);};
 const result=await subject.renameIndependentCatalogSpace(win,'a','next');
 assert.equal(result.status,'REFUSED');assert.equal(effects,0);
 assert.equal(subject.independentCatalogBusy,false);assert.deepEqual(subject.getClonedSpaces(),localSpaces);
 pass('actual upsert settles '+timing+' admission refusal without commit/save/publish');
}
// Legal own root/local nesting is native-qualified; JS must not prohibit it.
reset();selections.get(B.path).local=new File(B.path+'/cache');
subject.__snapshot(A,A.path,catalog);assert.equal(effects,0);
pass('qualified own root/local nesting is not prohibited');
// Missing/unreadable/ambiguous native results preserve refusal and zero effects.
for (const kind of ['missing','unreadable','ambiguous','catalog-root-mismatch']) {
 reset();endpointError=new Error(kind);
 assert.throws(()=>subject.__snapshot(A,A.path,catalog),e=>e===endpointError);
 assert.equal(effects,0);pass('native qualification refusal '+kind);
}
console.log('actual-JS cases='+count+'; native endpoint inert; no native behavior/compile claim');
})().catch(error=>{console.error(error);process.exitCode=1;});
'''

# Independent offline reference for the narrow duplicate preflight, NOT Gecko.
# NS_strtok mutation/leading-delimiter behavior follows the frozen nsCRTGlue.
def duplicate_model(data, catalog_key='catalog'):
    if data.startswith(b'\xef\xbb\xbf'):
        data = data[3:]
    elif data.startswith(b'\xff\xfe'):
        data = data[2:len(data) // 2 * 2].decode('utf-16-le', errors='replace').encode('utf-8')
    text = list(data.decode('latin1')) + ['\0']
    def strtok(delims, cursor):
        if cursor is None:
            return None, None
        while text[cursor] in delims:
            cursor += 1
        start = cursor
        if text[cursor] == '\0':
            return None, cursor
        while text[cursor] != '\0':
            if text[cursor] in delims:
                text[cursor] = '\0'
                return start, cursor + 1
            cursor += 1
        return start, None
    def value(cursor):
        end = cursor
        while text[end] != '\0':
            end += 1
        return ''.join(text[cursor:end])
    def profile(s):
        return s.startswith('Profile') and len(s) > 7 and all('0' <= c <= '9' for c in s[7:])
    cursor, section = 0, None
    sections, identities = set(), set()
    while True:
        token, cursor = strtok('\r\n', cursor)
        if token is None:
            return False
        if text[token] in '#;':
            continue
        while text[token] in ' \t':
            token += 1
        if text[token] == '\0':
            continue
        if text[token] == '[':
            section = token + 1
            rb, rest = strtok(']', section)
            junk, _ = strtok(' \t', rest)
            if rb is None or junk is not None:
                section = None
            elif profile(value(section)):
                s = value(section)
                if s in sections:
                    return True
                sections.add(s)
            continue
        if section is None:
            continue
        key = token
        e, rest = strtok('=', token)
        if e is None or rest is None:
            continue
        name, field = value(section), value(key)
        if (profile(name) and field in ('Name', 'Path', 'IsRelative', 'StoreID', 'ShowSelector')) or (name == 'BackgroundTasksProfiles' and field == catalog_key):
            identity = (name, field)
            if identity in identities:
                return True
            identities.add(identity)


def duplicate_controls():
    cases = 0
    for key in ('Name', 'Path', 'IsRelative', 'StoreID', 'ShowSelector'):
        for first, second in (('one', 'two'), ('same', 'same'), ('', '')):
            data = f'[Profile0]\n{key}={first}\n{key}={second}\n'.encode()
            for raw in (data, b'\xef\xbb\xbf' + data, b'\xff\xfe' + data.decode().encode('utf-16-le')):
                assert duplicate_model(raw), (key, first, second, raw)
                cases += 1
    for data in (
        b'[Profile0]\nName=a\n[Profile0]\nPath=b\n',
        b'[Profile0]\n[Profile0]\n',
        b'[BackgroundTasksProfiles]\ncatalog=a\ncatalog=a\n',
        b'[BackgroundTasksProfiles]\ncatalog=a\n[BackgroundTasksProfiles]\ncatalog=b\n',
        b'\r\n\t[Profile0]\t\rName=a\r\n\tName=a\n',
        b'[Profile0] \t\nName=a\nName=b\n',
    ):
        assert duplicate_model(data), data
        cases += 1
    for data in (
        b'[Profile0]\nName=a\n[Profile1]\nName=a\n',
        b'[Profile0]\rName=\rPath=Profiles/A\nIsRelative=1\rStoreID=\rShowSelector=\n',
        b'#Name=a\n;comment\n[Profile0]\nName=a\n#Name=b\n;Name=c\n',
        b'[Profile0]\nName=a\nName =b\nname=c\n',
        b'[Profile0]\nOpaque=a\nOpaque=b\n',
        b'[ProfileMetadata]\nName=a\nName=b\n[ProfileMetadata]\nPath=x\n',
        b'[BackgroundTasksProfiles]\nother=a\nother=b\n',
        b'[Opaque]\nName=a\nName=b\n[Opaque]\nName=c\n',
        b'[Profile0]junk\nName=a\nName=b\n',
        b'[Profile0]\nName=a\0\nName=b\n',
        b'[Profile0]\nName=a\n\t#comment\n',
    ):
        assert not duplicate_model(data), data
        cases += 1
    print(f'PASS offline duplicate grammar model cases={cases}; not Gecko execution', flush=True)


def extra_contracts(sources):
    cpp, js = sources[CPP], sources[JS]
    getter = definition(cpp, 'static nsresult ReadRegisteredProfileHostSelection(' if 'static nsresult ReadRegisteredProfileHostSelection(' in cpp else 'nsToolkitProfileService::GetRegisteredProfileHostSelection(')
    duplicate = definition(cpp, 'static nsresult CheckRegisteredSelectionDuplicates(')
    path = definition(cpp, 'static nsresult CheckRegisteredSelectionPath(')
    owner = definition(js, '#catalogOwnerSnapshot(')
    assert 'service.profiles' not in owner
    assert '.contains(' not in owner
    assert getter.index('aAuthority && aLocal && aStoreIDPresent') < getter.index('CheckRegisteredSelectionPath(mAppData)')
    assert getter.index("aDescriptor.FindChar('\\0')") < getter.index('CheckRegisteredSelectionPath(mAppData)')
    assert getter.index('CheckRegisteredSelectionDuplicates(profiles.mBytes, catalogKey)') < getter.index('profileDB.InitFromString')
    for key in ('Name', 'Path', 'IsRelative', 'StoreID', 'ShowSelector'):
        assert f'field.EqualsLiteral("{key}")' in duplicate
    for token in ('NS_strtok("\\r\\n", &buffer)', 'NS_strspnp(" \\t", token)', 'NS_strtok("]", &token)', 'NS_strtok("=", &token)', 'NS_strtok(" \\t", &token)', 'AppendUTF16toUTF8(Substring(str, 1), contents)', 'sections.Contains(name)', 'identities.Contains(identity)', 'field.Equals(aCatalogKey)'):
        assert token in duplicate, token
    assert duplicate.index("token[0] == '#'") < duplicate.index('NS_strspnp')
    assert '.Trim(' not in duplicate and '.ToLower' not in duplicate
    assert 'IsFile(&correctType)' in path and 'IsReadable(&readable)' in path
    assert path.count('leaf && aOptional && rv == NS_ERROR_FILE_NOT_FOUND') == 2
    assert 'Exists(' not in path
    # No raw-byte NUL ban: actual INI supports UTF16LE and NS_strtok boundaries.
    assert "profiles.mBytes.FindChar('\\0')" not in getter
    assert "installs.mBytes.FindChar('\\0')" not in getter
    for publish in ('aName = selection.name', '*aStoreIDPresent =', '*aShowSelectorPresent =', 'authority.forget(aAuthority)', 'local.forget(aLocal)', 'root.forget(aResult)'):
        assert getter.index('verifiedInstalls.mBytes.Equals(installs.mBytes)') < getter.index(publish)
    for clone in ('mAppData->Clone(', 'selection.root->Clone(', 'selection.local->Clone('):
        assert getter.index(clone) < getter.index('aName = selection.name')
    assert 'for (const auto& admitted : selections)' in getter
    assert 'GetLocalDirFromRootDir(admitted.root' in getter
    # No manufactured defaults for either optional literal.
    assert 'rv != NS_ERROR_FAILURE' in getter
    assert 'EqualsLiteral("1")' not in getter[getter.index('"StoreID"'):getter.index('if (selection.isRelative')]
    print('PASS pointer/duplicate/optional/path/publication/real-consumer source ordering; native UNVERIFIED', flush=True)
    duplicate_controls()



def entry_adapter(sources):
    js=sources[JS]
    for line in ['import { JSONFile } from "resource://gre/modules/JSONFile.sys.mjs";', 'import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";']:
        assert js.count(line)==1
        js=js.replace(line,'')
    assert not re.search(r'^\s*import\s',js,re.M)
    js=js.replace('export class nsZenSessionManager','class nsZenSessionManager').replace('export const ZenSessionStore','const ZenSessionStore')
    shim='\n  __fixture(file, projection, sidebar) { this.#startupAdmissionComplete=true;this.#file=file;this.#independentProjection=projection;this.#sidebar=sidebar; }\n'
    at=js.rindex('\n}\n');augmented=js[:at]+shim+js[at:]
    assert augmented[:at]+augmented[at+len(shim):]==js
    prefix=ADAPTER_PREFIX.replace('__RECEIPT_DIR__',json.dumps(OWN_ROOT))
    prefix=prefix.replace("const IOUtils=new Proxy({}, {get(){return ()=>{effects++;throw new Error('unexpected IO');};}});",'const IOUtils={};')
    cases=ENTRY_CASES
    for token,key in [('__CLIENT__','src/zen/sessionstore/ZenIndependentCatalogClient.sys.mjs'),('__READER__','src/zen/sessionstore/ZenIndependentCatalogReader.sys.mjs'),('__TASK__','src/zen/sessionstore/BackgroundTask_zen_catalog.sys.mjs')]:
        module=sources[key]
        assert not re.search(r'^\s*import\s',module,re.M)
        module=re.sub(r'^export ', '', module, flags=re.M)
        cases=cases.replace(token,module)
    program=prefix+augmented+cases
    import hashlib
    with open(OWN_ROOT+'/entry-program.js','w') as f:f.write(program)
    with open(OWN_ROOT+'/entry-bindings.json','w') as f:
        json.dump({'sourceSHA':hashlib.sha256(sources[JS].encode()).hexdigest(),'shimSHA':hashlib.sha256(shim.encode()).hexdigest(),'removalExact':True,'programSHA':hashlib.sha256(program.encode()).hexdigest()},f)
    child=subprocess.Popen([NODE,'--input-type=commonjs'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=dict(os.environ))
    stdout,stderr=child.communicate(program)
    with open(OWN_ROOT+'/ENTRY-WAIT.json','w') as f:json.dump({'pid':child.pid,'wait':child.returncode},f)
    print(stdout,end='',flush=True)
    print(stderr,end='',file=sys.stderr,flush=True)
    assert child.returncode==0,('actual entry adapter wait',child.returncode)

def registration_contracts(sources):
    cpp=sources[CPP]
    qualifier=definition(cpp,'static nsresult ReadRegisteredProfileHostSelection(')
    normal=definition(cpp,'nsToolkitProfileService::GetRegisteredProfileHostSelection(')
    current=definition(cpp,'nsToolkitProfileService::GetCurrentProfileHostSelection(')
    assert 'mInstallDBFile, false,' in normal
    assert 'mInstallDBFile, true,' in current
    assert current.index('aAuthority && aLocal') < current.index('NS_GetSpecialDirectory(')
    assert 'NS_APP_USER_PROFILE_50_DIR' in current and 'GetPersistentDescriptor(descriptor)' in current
    for token in ['aCurrentBeforeRegistration ? !manager : !!manager', 'aCurrentBeforeRegistration ? !verifiedManager : !!verifiedManager', 'root->Equals(currentRoot', 'local->Equals(currentLocal', 'NS_APP_USER_PROFILE_LOCAL_50_DIR']:
        assert token in qualifier,token
    assert cpp.count('static nsresult ReadRegisteredProfileHostSelection(')==1
    assert 'getCurrentProfileHostSelection(' in sources[IDL]
    print('PASS explicit CURRENT/absent registration shared qualifier source contract; native UNVERIFIED',flush=True)

ENTRY_CASES = "(async()=>{\nconst Reader = (()=>{ __READER__; return {validateZenCatalogMetadata,validateZenSharedPreferences}; })();\nconst Task = (()=>{ __TASK__; return {validateZenCatalogRequest,applyZenCatalogOperation}; })();\nconst Client = (()=>{ __CLIENT__; return {requestZenCatalogCommit}; })();\nconst uuid=n=>'{00000000-0000-4000-8000-'+String(n).padStart(12,'0')+'}';\nconst clone=v=>structuredClone(v);\nlet metadata=null,disk=null,dispatch=0,saves=0,applies=0,resident=0,reported=[],clientReads=0;\nlet holdClient=null,saveHook=null,readbackHook=null,projectionHook=null,transport='success';\nlet registered=true,adoptions=0;\nconst initialSpaces=[{uuid:uuid(1),name:'local',theme:null,containerTabId:0,geckoProfileReference:{version:1,persistentDescriptor:A.path}}];\nconst remote={uuid:uuid(2),name:'foreign',theme:null,containerTabId:0,geckoProfileReference:{version:1,persistentDescriptor:B.path}};\nfunction makeCatalog(){return {zenCatalogVersion:1,zenCatalogId:uuid(3),zenCatalogRevision:7,zenCatalogRequestId:uuid(4),spaces:[...clone(initialSpaces),clone(remote)]};}\nObject.defineProperty(service,'profiles',{get(){resident++;const profiles=[A,B];return {hasMoreElements(){return profiles.length>0;},getNext(){const root=profiles.shift();return {QueryInterface(){return {rootDir:root.clone()};}};}};}});\nservice.getZenCatalogProfileDirectory=()=>registered?CATALOG.clone():null;\nservice.adoptZenCatalogProfileRegistration=()=>{adoptions++;outdated=false;};\nservice.getCurrentProfileHostSelection=(...out)=>{\n assert.equal(registered,false,'pre-registration endpoint must require absent catalog');\n return service.getRegisteredProfileHostSelection(A.path,...out);\n};\nCu.reportError=error=>reported.push(error);\nServices.appinfo={OS:'Darwin'};\nServices.uuid.generateUUID=()=>({toString:()=>uuid(9)});\nconst dirget=Services.dirsvc.get;\nServices.dirsvc.get=key=>{\n if(['ProfD','ProfLD'].includes(key))return dirget(key);\n const path={XREExeF:'/inert/browser',UAppData:'/authority',DefProfLRt:'/inert/local/Profiles'}[key];\n assert.ok(path,'undeclared native directory '+key);\n const f=new File(path);f.isFile=()=>true;f.isExecutable=()=>true;\n Object.defineProperty(f,'leafName',{get:()=>path.split('/').pop()});\n Object.defineProperty(f,'parent',{get:()=>new File('/inert/local')});return f;\n};\nPathUtils.join=(...p)=>p.join('/');\nconst pipe=bytes=>{let once=false;return {async read(){if(once)return new Uint8Array();once=true;return bytes;}};};\nconst Subprocess={async call(options){\n dispatch++;const request=JSON.parse(options.arguments.at(-1));\n let reply,exitCode;\n if(transport==='unknown'){reply={status:'UNKNOWN',failure:'API_OR_IO',error:'InertUnknown'};exitCode=13;}\n else {\n  metadata=Task.applyZenCatalogOperation(metadata,request,Reader.validateZenCatalogMetadata);\n  if(!registered){registered=true;outdated=true;}\n  reply={status:'COMMITTED',zenCatalogId:metadata.zenCatalogId,zenCatalogRevision:metadata.zenCatalogRevision,zenCatalogRequestId:metadata.zenCatalogRequestId,processID:17,profD:CATALOG.path};exitCode=0;\n }\n return {pid:17,stdout:pipe(new TextEncoder().encode(JSON.stringify(reply)+'\\n')),stderr:pipe(new Uint8Array()),stdin:{close(){}},async wait(){return {exitCode};}};\n}};\nconst clientReader={...Reader,async readCatalogMetadata(){\n clientReads++;const value=clone(metadata);\n if(holdClient){const hook=holdClient;holdClient=null;await hook(value);}\n return value;\n}};\nChromeUtils.importESModule=path=>{\n if(path.endsWith('BackgroundTask_zen_catalog.sys.mjs'))return Task;\n if(path.endsWith('ZenIndependentCatalogReader.sys.mjs'))return clientReader;\n if(path.endsWith('Timer.sys.mjs'))return {setTimeout(){return 1;},clearTimeout(){}};\n if(path.endsWith('Subprocess.sys.mjs'))return {Subprocess};\n throw new Error('unapproved import '+path);\n};\nlazy.requestZenCatalogCommit=Client.requestZenCatalogCommit;\nlazy.validateZenCatalogMetadata=Reader.validateZenCatalogMetadata;\nlazy.readCatalogMetadata=async()=>clone(metadata);\nlazy.readLocalProjection=async()=>{\n if(projectionHook)projectionHook();\n return metadata&&{...clone(metadata),spaces:metadata.spaces.filter(s=>s.geckoProfileReference.persistentDescriptor===A.path).map(clone)};\n};\nIOUtils.readJSON=async()=>{if(readbackHook)readbackHook();return clone(disk);};\nlet subject,file;\nfunction setup(first=false,upsert=false){\n reset();registered=!first;adoptions=0;metadata=first?null:makeCatalog();disk=null;\n dispatch=0;saves=0;applies=0;resident=0;reported=[];clientReads=0;holdClient=null;saveHook=null;readbackHook=null;projectionHook=null;transport='success';\n localSpaces=clone(initialSpaces);windowRecord={tabs:[],spaces:localSpaces,activeZenSpace:uuid(1),selected:1};\n SessionStoreFixture._windows.one=windowRecord;\n manager.activeWorkspace=uuid(1);manager.getWorkspaces=()=>localSpaces;\n manager.applyIndependentCatalogProjection=async recheck=>{recheck();applies++;localSpaces=subject.getClonedSpaces(localSpaces);};\n win.closed=false;\n file={data:{original:true},_saver:{disarm(){},_runningPromise:Promise.resolve()},async _save(){saves++;disk=clone(this.data);if(saveHook)saveHook();}};\n subject=new nsZenSessionManager();\n subject.__fixture(file,upsert?{marker:{zenCatalogId:uuid(3),zenCatalogRevision:7},spaces:clone(localSpaces)}:null,{tabs:[],spaces:clone(localSpaces)});\n}\nconst mutations={\n path(){selections.get(A.path).path='Profiles/../Profiles/A';},\n isRelative(){selections.get(A.path).isRelative='0';},\n presence(){selections.get(A.path).storeIDPresent=true;},\n foreignLocal(){selections.get(B.path).local=new File('/changed/foreign-cache');},\n currentLocal(){selections.get(A.path).local=BL.clone();},\n};\nlet count=0,failures=[];\nasync function test(name,fn){try{await fn();count++;console.log('PASS actual-entry '+name);}catch(error){failures.push({name,error:String(error),stack:error.stack});console.log('FAIL actual-entry '+name+' '+error);}}\nfunction noEffects(){assert.equal(dispatch,0,'fixture Subprocess dispatch');assert.equal(saves,0,'sidecar save');assert.equal(applies,0,'workspace publication');assert.equal(subject.hasIndependentCatalogProjection,false,'projection publication');}\nfor(const first of [false,true]){\n const mode=first?'first':'join';\n await test(mode+' legitimate activation',async()=>{\n  setup(first);const result=await subject.activateIndependentCatalog(win,async kind=>{assert.equal(kind,first?'activate':'join');return true;});\n  assert.equal(result.status,'ATTACHED');assert.equal(dispatch,first?1:0);assert.equal(saves,1);assert.equal(subject.hasIndependentCatalogProjection,true);\n  if(first){assert.equal(resident,0,'no resident seed authority');assert.equal(adoptions,1,'existing explicit registration adoption');}\n });\n await test(mode+' initial IO sentinel original error ownership',async()=>{\n  setup(first);const original=new Error('private original IO sentinel');endpointError=original;\n  const result=await subject.activateIndependentCatalog(win,async()=>true);\n  noEffects();assert.equal(result.status,'REFUSED');assert.ok(reported.includes(original),'same original Error privately reported');assert.deepEqual(Object.keys(result),['status']);\n });\n await test(mode+' bad raw selection before first effects',async()=>{\n  setup(first);selections.get(A.path).isRelative='invalid';\n  const result=await subject.activateIndependentCatalog(win,async()=>true);\n  noEffects();assert.equal(result.status,'REFUSED');\n });\n await test(mode+' cancellation unchanged',async()=>{\n  setup(first);const result=await subject.activateIndependentCatalog(win,async()=>false);assert.equal(result.status,'CANCELLED');noEffects();\n });\n for(const field of ['path','isRelative','presence',...(first?[]:['foreignLocal'])]){\n  await test(mode+' consent retains raw '+field,async()=>{\n   setup(first);await subject.activateIndependentCatalog(win,async()=>{mutations[field]();return true;});noEffects();\n  });\n }\n for(const stage of ['projection','drain','save','readback']){\n  await test(mode+' persistence '+stage+' raw baseline',async()=>{\n   setup(first);const mutate=()=>mutations[first?'path':'foreignLocal']();\n   if(stage==='projection')projectionHook=mutate;\n   if(stage==='drain')file._saver.disarm=()=>{file._saver._runningPromise=Promise.resolve().then(mutate);};\n   if(stage==='save')saveHook=mutate;\n   if(stage==='readback')readbackHook=mutate;\n   const result=await subject.activateIndependentCatalog(win,async()=>true);\n   assert.equal(saves,['save','readback'].includes(stage)?1:0,'sidecar write boundary');assert.equal(subject.hasIndependentCatalogProjection,false,'no publication after remap');\n   assert.ok(['REFUSED','PARTIAL'].includes(result.status));assert.equal(dispatch,first?1:0);\n  });\n }\n}\nfor(const kind of ['path','isRelative','presence','foreignLocal','currentLocal','full-catalog','lifetime']){\n await test('actual Client last metadata await upsert '+kind,async()=>{\n  setup(false,true);let release,entered;\n  const enteredPromise=new Promise(r=>entered=r);const held=new Promise(r=>release=r);\n  holdClient=async value=>{entered();await held;if(kind==='full-catalog')value.spaces[1].name='changed-at-same-revision';};\n  const resultPromise=subject.renameIndependentCatalogSpace(win,uuid(1),'next');\n  await enteredPromise;\n  if(kind==='lifetime')win.closed=true;else if(kind!=='full-catalog')mutations[kind]();\n  release();const result=await resultPromise;\n  assert.equal(dispatch,0,'last-await guard before fixture Subprocess');assert.equal(saves,0);assert.equal(applies,0);assert.ok(['REFUSED','UNKNOWN'].includes(result.status));\n });\n}\nfor(const kind of ['path','isRelative','presence','currentLocal']){\n await test('actual Client last metadata await first '+kind,async()=>{\n  setup(true);let release,entered;\n  const enteredPromise=new Promise(r=>entered=r);const held=new Promise(r=>release=r);\n  holdClient=async()=>{entered();await held;};\n  const resultPromise=subject.activateIndependentCatalog(win,async()=>true);await enteredPromise;mutations[kind]();release();\n  const result=await resultPromise;noEffects();assert.equal(result.status,'REFUSED');\n });\n}\nawait test('join equal-revision complete metadata changed during consent refuses',async()=>{\n setup(false);await subject.activateIndependentCatalog(win,async()=>{metadata.spaces[1].geckoProfileReference.persistentDescriptor='/unadmitted';return true;});noEffects();\n});\nfor(const phase of ['unknown','partial']){\n await test(phase+' reconnect wrong exact identity never recommits',async()=>{\n  setup(true);if(phase==='unknown')transport='unknown';else saveHook=()=>{throw new Error('inert save failure');};\n  const first=await subject.activateIndependentCatalog(win,async()=>true);assert.equal(first.status,phase.toUpperCase());assert.equal(dispatch,1);\n  transport='success';saveHook=null;registered=true;\n  metadata={zenCatalogVersion:1,zenCatalogId:uuid(3),zenCatalogRevision:1,zenCatalogRequestId:uuid(99),spaces:clone(initialSpaces)};\n  const result=await subject.activateIndependentCatalog(win,async()=>true);assert.equal(result.status,'UNKNOWN');assert.equal(dispatch,1);assert.equal(subject.hasIndependentCatalogProjection,false);\n });\n}\nawait test('public activation privately reports original IO Error identity',async()=>{\n setup(false);const original=new Error('original public activation IO sentinel');endpointError=original;\n const result=await subject.activateIndependentCatalog(win,async()=>true);\n assert.ok(reported.includes(original),'same original Error received by private diagnostic owner');noEffects();assert.deepEqual(result,{status:'REFUSED'});\n});\nawait test('actual Client semantically equal reordered metadata keys accepted',async()=>{\n setup(false,true);holdClient=async value=>{const reversed=Object.fromEntries(Object.entries(value.spaces[1]).reverse());value.spaces[1]=reversed;};\n const result=await subject.renameIndependentCatalogSpace(win,uuid(1),'next');assert.equal(result.status,'COMMITTED');assert.equal(dispatch,1);assert.equal(saves,1);\n});\nawait test('actual Client upsert valid commit and publication',async()=>{\n setup(false,true);const result=await subject.renameIndependentCatalogSpace(win,uuid(1),'next');\n assert.equal(result.status,'COMMITTED');assert.equal(dispatch,1);assert.equal(saves,1);assert.equal(applies,1);\n});\nawait test('UNKNOWN first reconnect exact identity no recommit',async()=>{\n setup(true);transport='unknown';let result=await subject.activateIndependentCatalog(win,async()=>true);\n assert.equal(result.status,'UNKNOWN');assert.equal(dispatch,1);transport='success';registered=true;\n metadata={zenCatalogVersion:1,zenCatalogId:uuid(3),zenCatalogRevision:1,zenCatalogRequestId:uuid(9),spaces:clone(initialSpaces)};\n result=await subject.activateIndependentCatalog(win,async()=>true);assert.equal(result.status,'ATTACHED');assert.equal(dispatch,1);\n});\nawait test('PARTIAL first reconnect exact identity no recommit',async()=>{\n setup(true);saveHook=()=>{throw new Error('inert save failure');};let result=await subject.activateIndependentCatalog(win,async()=>true);\n assert.equal(result.status,'PARTIAL');assert.equal(dispatch,1);saveHook=null;\n result=await subject.activateIndependentCatalog(win,async()=>true);assert.equal(result.status,'ATTACHED');assert.equal(dispatch,1);\n});\nconsole.log(JSON.stringify({entryCases:count+failures.length,passed:count,failures}));\nif(failures.length)process.exitCode=1;\n})().catch(error=>{console.error('HARNESS',error);process.exitCode=2;});\n"

if __name__ == '__main__':
    sources=json.load(sys.stdin)
    check(sources)
    entry_adapter(sources)
    registration_contracts(sources)

