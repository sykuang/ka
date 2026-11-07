/* Owned-FS Node adapter tests: real JS bodies, no Gecko/native IPC/lock proof. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";

const bootstrapEnvironmentKeys = Object.keys(process.env).sort();
const allowedEnvironment = new Set(["HOME", "PATH", "TMPDIR", "PYTHONDONTWRITEBYTECODE"]);
for (const key of Object.keys(process.env)) if (!allowedEnvironment.has(key)) delete process.env[key];
const sourceRoot = process.argv[2] || path.resolve(import.meta.dirname, "..");
const scratch = process.env.TMPDIR;
assert.equal(scratch, "/Users/kenkuang/.hermes/cache/scratch");
const owned = fs.mkdtempSync(path.join(scratch, "zen-shared-preferences-"));
const ids = n => `{00000000-0000-4000-8000-${String(n).padStart(12, "0")}}`;
const key = "zen.view.sidebar-expanded";
const events = [];
const unhandled = [];
process.on("unhandledRejection", error => unhandled.push({ name: error.name, message: error.message }));
async function test(id, body) {
  try { await body(); events.push({ id, outcome: "PASS" }); }
  catch (error) { events.push({ id, outcome: "FAIL", error: error.message }); }
}
function regular(p) {
  const parts = path.resolve(p).split("/").filter(Boolean); let current = "";
  for (let i = 0; i < parts.length; i++) {
    current += "/" + parts[i];
    const stat = fs.lstatSync(current);
    assert(!stat.isSymbolicLink(), current);
    assert(i === parts.length - 1 ? stat.isFile() : stat.isDirectory(), current);
  }
}
const hashes = {};
const sources = new Map();
const startupPath = path.join(sourceRoot, "src/zen/common/modules/ZenStartup.mjs");
regular(startupPath);
const startupSource = fs.readFileSync(startupPath,"utf8");
hashes.ZenStartup = crypto.createHash("sha256").update(startupSource).digest("hex");
for (const name of ["BackgroundTask_zen_catalog.sys.mjs", "ZenIndependentCatalogReader.sys.mjs", "ZenIndependentCatalogClient.sys.mjs", "ZenSharedPreferences.sys.mjs"]) {
  const file = path.join(sourceRoot, "src/zen/sessionstore", name);
  if (!fs.existsSync(file) && name === "ZenSharedPreferences.sys.mjs") continue;
  regular(file); const text = fs.readFileSync(file, "utf8"); sources.set(name, text);
  hashes[name] = crypto.createHash("sha256").update(text).digest("hex");
}
const sessionManagerPath = path.join(sourceRoot,"src/zen/sessionstore/ZenSessionManager.sys.mjs");
regular(sessionManagerPath);
const sessionManagerSource=fs.readFileSync(sessionManagerPath,"utf8");
hashes.ZenSessionManager=crypto.createHash("sha256").update(sessionManagerSource).digest("hex");
// Diagnostic extraction only: no normal SessionManager/JSONFile/SessionWriter execution.
const consentGetter=sessionManagerSource.match(/  get independentCatalogConsent\(\) \{[\s\S]*?\n  \}/)?.[0];
function fixture(label, initialShared) {
  const root = path.join(owned, label); fs.mkdirSync(root);
  for (const dir of ["manager", "A", "B", "app", "local", "local/Profiles"]) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, "executable"), "not executable; endpoint double only");
  const catalogPath = path.join(root, "manager/zen-independent-catalog.json");
  const spaces = [1, 2].map(n => ({ uuid: ids(n), name: `space${n}`, theme: null, containerTabId: 0,
    geckoProfileReference: { version: 1, persistentDescriptor: path.join(root, n === 1 ? "A" : "B") } }));
  const catalog = { zenCatalogVersion: 1, zenCatalogId: ids(10), zenCatalogRevision: 1, zenCatalogRequestId: ids(11), spaces };
  if (initialShared !== undefined) catalog.sharedPreferences = initialShared;
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  const stats = { reads: 0, writes: 0, launches: 0, requestIDs: 0, prefWrites: [], reports: [], tasks: [], prompts: [] };
  let sequence = 100;
  const faults = {};
  function realm(profile = "A", taskMode = false) {
    let profileName = profile;
    class File {
      constructor(p) { this.path = p; }
      clone() { return new File(this.path); }
      equals(other) { return this.path === other?.path; }
      append(p) { this.path = path.join(this.path, p); }
      initWithPath(p) { this.path = p; }
      exists() { return fs.existsSync(this.path); }
      isSymlink() { try { return fs.lstatSync(this.path).isSymbolicLink(); } catch (e) { if(e.code === "ENOENT") {e.name="NS_ERROR_FILE_NOT_FOUND";} throw e; } }
      isDirectory() { return fs.statSync(this.path).isDirectory(); }
      isFile() { return fs.statSync(this.path).isFile(); }
      isExecutable() { return this.path === path.join(root, "executable"); }
      get parent() { return new File(path.dirname(this.path)); }
      get leafName() { return path.basename(this.path); }
      get persistentDescriptor() { return this.path; }
    }
    const users = new Map(), defaults = new Map(), locks = new Set(), observers = new Map();
    const prefs = {
      PREF_BOOL: 128, PREF_STRING: 32,
      getPrefType(k) { const value=users.has(k)?users.get(k):defaults.get(k);return typeof value === "boolean"?128:typeof value === "string"?32:0; },
      prefHasUserValue: k => users.has(k), prefIsLocked: k => locks.has(k),
      getBoolPref(k, fallback) { const v = users.has(k) ? users.get(k) : defaults.has(k) ? defaults.get(k) : fallback; if(typeof v !== "boolean") throw new Error("bad bool"); return v; },
      getStringPref(k, fallback) { const v = users.has(k) ? users.get(k) : defaults.has(k) ? defaults.get(k) : fallback; if(typeof v !== "string") throw new Error("bad string"); return v; },
      setBoolPref(k,v) { assert.equal(typeof v,"boolean"); set(k,v); },
      setStringPref(k,v) { assert.equal(typeof v,"string"); set(k,v); },
      clearUserPref(k) { if(locks.has(k)) throw new Error("locked"); if(users.delete(k)) notify(k); },
      addObserver(k, observer) { if(!observers.has(k)) observers.set(k,new Set()); observers.get(k).add(observer); },
      removeObserver(k, observer) { observers.get(k)?.delete(observer); },
    };
    function notify(k) { for(const [prefix,list] of observers) if(k.startsWith(prefix)) for(const observer of [...list]) observer.observe(null,"nsPref:changed",k); }
    function set(k,v) { if(locks.has(k)) throw new Error("locked"); if(users.has(k)&&users.get(k)===v)return; users.set(k,v); stats.prefWrites.push({profile,k,v});notify(k); }
    const service = {
      isListOutdated: false,
      getZenCatalogProfileDirectory: () => faults.noManager ? null : new File(path.join(root, faults.manager || "manager")),
      get profiles() { let index=0;const roots=["manager","A","B"];return {hasMoreElements:()=>index<roots.length,getNext:()=>({QueryInterface:()=>({rootDir:new File(path.join(root,roots[index++]))})})}; },
    };
    const sandbox = { console: {error:(...args)=>stats.reports.push({profile,console:args}),log:console.log}, Cu: {reportError:error=>{stats.reports.push({profile,programmingError:error.message});faults.programmingError?.(error);}}, TextEncoder, TextDecoder, Uint8Array, structuredClone, setTimeout, clearTimeout,
      Services: { prefs, uuid: {generateUUID:()=>{stats.requestIDs++;return {toString:()=>ids(sequence++)};}}, appinfo:{OS:"Darwin",processID:taskMode?4242:4343},
        dirsvc:{get:k=>new File(path.join(root,({ProfD:taskMode?"manager":profileName,XREExeF:"executable",UAppData:"app",DefProfLRt:"local/Profiles"})[k]))},
        prompt:{MODAL_TYPE_WINDOW:1,BUTTON_POS_0:1,BUTTON_TITLE_OK:1,asyncConfirmEx:async(...args)=>{stats.prompts.push(args);if(faults.prompt)await faults.prompt();return new Map([["buttonNumClicked",0]]);}},
        obs:{notifyObservers:(_s,topic,data)=>{stats.reports.push({profile,topic,data});faults.report?.(JSON.parse(data));}} },
      Ci:{}, Cc: new Proxy({}, {get:(_o,k)=>({getService:()=>k.includes("backgroundtasks")?{isBackgroundTaskMode:true,backgroundTaskName:()=>"zen_catalog"}:service,createInstance:()=>new File("")})}),
      dump:text=>stats.tasks.push(text),
    };
    const context=vm.createContext(sandbox);
    // Previously admitted C1 anchor exists even on predecessor: it ignores it.
    let admitted={zenCatalogId:ids(10),zenCatalogRevision:1};
    const consentStore={get independentCatalogConsent(){return admitted&&Object.freeze({...admitted});}};
    if(consentGetter){
      const Diagnostic=vm.runInContext(`(class {#independentProjection=null; setup(marker){this.#independentProjection=marker&&{marker};}\n${consentGetter}\n})`,context);
      const actual=new Diagnostic();actual.setup(admitted);
      Object.defineProperty(consentStore,"independentCatalogConsent",{get(){actual.setup(admitted);return actual.independentCatalogConsent;}});
    }
    // Re-home native clone results into this JS realm, as Gecko does.
    sandbox.structuredClone = vm.runInContext(`(value) => {
      function copy(v) { if(v === null || typeof v !== 'object')return v;
        const result=Array.isArray(v)?[]:{};
        for(const k of Object.keys(v))Object.defineProperty(result,k,{value:copy(v[k]),enumerable:true,writable:true,configurable:true});
        return result;
      }return copy(value);
    }`,context);
    const data=v=>vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(v))})`,context);
    sandbox.IOUtils={
      stat:async p=>({type:fs.statSync(p).isFile()?"regular":"directory"}),
      readJSON:async p=>{stats.reads++;if(faults.read)await faults.read(p,profile);try{return data(JSON.parse(fs.readFileSync(p,"utf8")))}catch(e){if(e.code==="ENOENT")e.name="NotFoundError";throw e;}},
      writeJSON:async(p,value,options)=>{stats.writes++;if(faults.write)await faults.write();const text=JSON.stringify(value);const fd=fs.openSync(options.tmpPath,"wx");fs.writeFileSync(fd,text);fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(options.tmpPath,p);if(faults.afterWrite)await faults.afterWrite();return {size:Buffer.byteLength(text),jsonLength:text.length};},
    };
    sandbox.PathUtils={join:path.join};
    const cache=new Map();
    sandbox.ChromeUtils={importESModule:uri=>{
      if(uri.endsWith("/ZenSessionManager.sys.mjs"))return {ZenSessionStore:consentStore};
      if(uri.includes("PrivateBrowsingUtils"))return {PrivateBrowsingUtils:{get permanentPrivateBrowsing(){return !!faults.permanentPrivate;},isWindowPrivate:w=>!!w.isPrivate}};
      if(uri.includes("Timer.sys"))return {setTimeout:faults.timer||setTimeout,clearTimeout};
      if(uri.includes("Subprocess.sys"))return {Subprocess:{call:async options=>{
        stats.launches++;if(faults.launch)return faults.launch(options);
        const task=realm("manager",true);const exitCode=await task.run(JSON.parse(options.arguments[3]));
        const bytes=new TextEncoder().encode(stats.tasks.at(-1));let sent=false;
        return {pid:4242,wait:async()=>{if(faults.wait)await faults.wait();return {exitCode};},stdin:{close(){}},stdout:{read:async()=>{if(sent)return new ArrayBuffer(0);sent=true;return bytes.buffer;}},stderr:{read:async()=>new ArrayBuffer(0)}};
      }}};
      const name=uri.split("/").at(-1);if(cache.has(name))return cache.get(name);
      if(!sources.has(name))throw new Error("unexpected module "+uri);
      const text=sources.get(name);const exports=[...text.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/gm)].map(m=>m[1]);
      const body=text.replace(/^export\s+/gm,"");
      const result=new vm.Script(`(()=>{${body}\nreturn {${exports.join(",")}};})()`,{filename:name}).runInContext(context);
      if(name==="ZenIndependentCatalogReader.sys.mjs"){
        const original=result.readCatalogMetadata;
        result.readCatalogMetadata=async()=>{const catalog=await original();if(faults.clientPreflight&&!taskMode)await faults.clientPreflight();return catalog;};
      }
      cache.set(name,result);return result;
    }};
    const load=name=>sandbox.ChromeUtils.importESModule("resource:///modules/zen/"+name);
    return {prefs,users,defaults,locks,observers,service,context,data,load,consentStore,setConsent:marker=>{admitted=marker;},swapProfile:p=>{profileName=p;},
      run:async request=>load("BackgroundTask_zen_catalog.sys.mjs").runBackgroundTask({length:0,handleFlagWithParam:()=>JSON.stringify(request)}),
      commit:(request,...guard)=>load("ZenIndependentCatalogClient.sys.mjs").requestZenCatalogCommit(data(request),...guard),
      window(options={}){const listeners=new Map();return {closed:false,isPrivate:false,gBrowserInit:{delayedStartupFinished:true},
        browsingContext:{profile,token:{}},document:{l10n:{formatValues:async entries=>{if(faults.l10n)await faults.l10n();return entries.map(e=>e.id);}}},
        gZenWorkspaces:{hasIndependentCatalogProjection:true,privateWindowOrDisabled:false,_invalidateBookmarkContainers(){}},console,
        addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
        removeEventListener(type,fn){listeners.get(type)?.delete(fn);},
        dispatch(type){for(const fn of [...listeners.get(type)||[]])fn({type});},listeners,...options};},
    };
  }
  return {root,catalogPath,catalog,spaces,stats,faults,realm,read:()=>JSON.parse(fs.readFileSync(catalogPath,"utf8")),
    request:(value,k=key)=>({zenCatalogOperation:"preference",zenCatalogRequestId:ids(sequence++),zenCatalogId:ids(10),zenCatalogRevision:JSON.parse(fs.readFileSync(catalogPath,"utf8")).zenCatalogRevision,preference:{key:k,value}})};
}
await test("shared.explicit-manager-write-preserves-spaces", async()=>{
  const f=fixture("primary");const task=f.realm("manager",true);const exit=await task.run(f.request(true));
  assert.equal(exit,0,`valid shared setting must COMMIT, got ${f.stats.tasks.at(-1)}`);
  assert.equal(f.read().sharedPreferences[key],true);assert.deepEqual(f.read().spaces,f.spaces);assert.equal(f.read().zenCatalogRevision,2);
});
await test("legacy.space-order-noop-preserves-bytes",async()=>{
  const f=fixture("legacy");const before=fs.readFileSync(f.catalogPath,"utf8");const request=f.request(true);delete request.preference;request.zenCatalogOperation="order";request.uuids=f.spaces.map(s=>s.uuid);
  assert.equal(await f.realm("manager",true).run(request),0);assert.equal(fs.readFileSync(f.catalogPath,"utf8"),before);assert.equal(f.stats.writes,0);
});
const tick = () => new Promise(resolve=>setImmediate(resolve));
async function settle(f, predicate) { for(let i=0;i<100;i++){if(predicate())return;await tick();}assert.fail("adapter did not settle"); }
await test("consumer.A-explicit-edit-client-task-readback-B-hydrate",async()=>{
  const f=fixture("cross-profile");const a=f.realm("A"),b=f.realm("B");
  assert(sources.has("ZenSharedPreferences.sys.mjs"),"API_GAP: registered shared preference consumer absent");
  const attachA=a.load("ZenSharedPreferences.sys.mjs").attachZenSharedPreferences;
  const attachB=b.load("ZenSharedPreferences.sys.mjs").attachZenSharedPreferences;
  a.users.set(key,false);b.users.set(key,false);
  const wa=a.window(),wb=b.window();await attachA(wa);assert.equal(f.stats.writes,0);
  a.prefs.setBoolPref(key,true);await settle(f,()=>f.read().sharedPreferences?.[key]===true&&f.stats.reports.some(r=>JSON.parse(r.data).status==="COMMITTED"));
  await attachB(wb);assert.equal(b.prefs.getBoolPref(key),true);assert.equal(f.stats.launches,1);assert.deepEqual(f.read().spaces,f.spaces);
  wa.closed=true;wa.dispatch("unload");wb.closed=true;wb.dispatch("unload");
});
const statuses = f => f.stats.reports.filter(r=>r.data).map(r=>JSON.parse(r.data));
function attach(r,w) { assert(sources.has("ZenSharedPreferences.sys.mjs"),"API_GAP: consumer absent");return r.load("ZenSharedPreferences.sys.mjs").attachZenSharedPreferences(w); }
function close(w) { w.closed=true;w.dispatch("unload"); }
function deferred() { let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}; }
const shared = [
 ["zen.view.compact.toolbar-flash-popup",true], ["zen.workspaces.hide-default-container-indicator",false],
 ["zen.pinned-tab-manager.close-shortcut-behavior","close"], ["zen.workspaces.open-new-tab-if-last-unpinned-tab-is-closed",true],
 ["zen.glance.activation-method","meta"], ["zen.glance.enabled",false], ["zen.view.drag-window-from-content",true],
 ["zen.urlbar.behavior","floating-on-type"], ["zen.tabs.show-newtab-vertical",false], ["zen.view.show-newtab-button-top",true],
 ["media.videocontrols.picture-in-picture.enabled",false], ["zen.tabs.ctrl-tab.ignore-essential-tabs",true],
 ["zen.tabs.ctrl-tab.ignore-pending-tabs",true], ["zen.tabs.close-on-back-with-no-history",false],
 ["zen.tabs.select-recently-used-on-close",true], [key,true], ["zen.view.use-single-toolbar",false],
];
for(const [k,value] of shared)await test(`whitelist.commit.${k}`,async()=>{
 const f=fixture(`key-${shared.findIndex(row=>row[0]===k)}`);const r=f.realm();
 const reply=await r.commit(f.request(value,k));assert.equal(reply.status,"COMMITTED");assert.equal(f.read().sharedPreferences[k],value);assert.deepEqual(f.read().spaces,f.spaces);
});
await test("whitelist.local-unknown-no-request-allocation",async()=>{
 const f=fixture("local");const r=f.realm();const w=r.window();await attach(r,w);
 const locals=["zen.tab-unloader.timeout-minutes","zen.pinned-tab-manager.restore-pinned-tabs-to-pinned-url","zen.workspaces.force-container-workspace","zen.workspaces.separate-essentials","zen.workspaces.continue-where-left-off","zen.mods.auto-update","zen.window-sync.sync-only-pinned-tabs","browser.startup.homepage","network.proxy.type","identity.fxaccounts.enabled","zen.mods.dynamic-foreign","__proto__","toString"];
 for(const k of locals)r.prefs.setBoolPref(k,true);
 await tick();assert.equal(f.stats.requestIDs,0);assert.equal(f.stats.launches,0);assert.equal(f.stats.writes,0);assert.equal([...r.observers.values()].reduce((n,s)=>n+s.size,0),17);
 for(const k of locals){const reply=await r.commit(f.request(true,k));assert.equal(reply.status,"REFUSED");}
 assert.equal(f.stats.launches,0);close(w);
});
await test("schema.whole-map-accessors-prototypes-extra-dense-refused-before-effects",async()=>{
 const f=fixture("schema");const r=f.realm();const reader=r.load("ZenIndependentCatalogReader.sys.mjs");
 assert.equal(typeof reader.validateZenSharedPreferences,"function","API_GAP: shared metadata schema absent");
 const bad=["[]","new Array(2)",`({[${JSON.stringify(key)}]:1})`,`({[${JSON.stringify(key)}]:undefined})`,`({[${JSON.stringify(key)}]:true,unknown:false})`,`Object.create({[${JSON.stringify(key)}]:true})`,`Object.defineProperty({},${JSON.stringify(key)},{enumerable:true,get(){throw Error('getter invoked')}})`,`Object.defineProperty({},${JSON.stringify(key)},{enumerable:false,value:true})`,`({['__proto__']:true})`,`({[Symbol('secret')]:true})`];
 for(const expression of bad){const value=vm.runInContext(expression,r.context);assert.throws(()=>reader.validateZenSharedPreferences(value),e=>e.name==="TypeError"&&e.message==="Invalid Zen catalog metadata");}
 for(const [k,v] of shared){assert.doesNotThrow(()=>reader.validateZenSharedPreferences(r.data({[k]:v})));assert.doesNotThrow(()=>reader.validateZenSharedPreferences(r.data({[k]:null})));}
 assert.equal(f.stats.reads,0);assert.equal(f.stats.launches,0);assert.equal(f.stats.writes,0);
 const request=f.request(true);r.context.request=r.data(request);const getter=vm.runInContext(`Object.defineProperty(request.preference,'value',{enumerable:true,get(){throw Error('effect')}})`,r.context);
 assert.equal((await r.load("ZenIndependentCatalogClient.sys.mjs").requestZenCatalogCommit(getter)).status,"REFUSED");
 assert.equal(f.stats.launches,0);assert.equal(f.stats.reads,0);
});
await test("schema.malformed-map-all-or-nothing-UI-and-task",async()=>{
 const f=fixture("malformed",{[key]:true,"zen.urlbar.behavior":"invented"});const r=f.realm();r.users.set(key,false);const w=r.window();
 assert.equal((await attach(r,w)).status,"REFUSED");assert.equal(r.prefs.getBoolPref(key),false);assert.equal(f.stats.prefWrites.length,0);
 assert.notEqual(await f.realm("manager",true).run(f.request(false)),0);assert.equal(f.stats.writes,0);close(w);
});
await test("legacy.space-upsert-order-preserve-shared-map-and-bindings",async()=>{
 const f=fixture("preserve",{[key]:true});const r=f.realm();let request=f.request(false);delete request.preference;request.zenCatalogOperation="upsert";request.space={...f.spaces[0],name:"renamed"};
 assert.equal((await r.commit(request)).status,"COMMITTED");assert.deepEqual(f.read().sharedPreferences,{[key]:true});
 request=f.request(false);delete request.preference;request.zenCatalogOperation="order";request.uuids=f.spaces.map(s=>s.uuid).reverse();assert.equal((await r.commit(request)).status,"COMMITTED");
 assert.deepEqual(f.read().sharedPreferences,{[key]:true});assert.deepEqual(f.read().spaces.map(s=>s.geckoProfileReference),f.spaces.map(s=>s.geckoProfileReference).reverse());
});
await test("consumer.startup-readonly-noop-zero-echo-and-unconfigured-local",async()=>{
 const f=fixture("readonly",{[key]:true});const r=f.realm();const w=r.window();r.users.set("zen.view.use-single-toolbar",true);
 await attach(r,w);assert.equal(r.prefs.getBoolPref(key),true);assert.equal(r.prefs.getBoolPref("zen.view.use-single-toolbar"),true);assert.equal(f.stats.writes,0);assert.equal(f.stats.launches,0);
 w.dispatch("focus");await tick();await tick();assert.equal(f.stats.launches,0);
 assert.equal((await r.commit(f.request(true))).status,"NOOP");assert.equal(f.stats.writes,0);close(w);
});
for(const mode of ["legacy","private","permanent-private","disabled","closing","not-started"])await test(`consumer.inactive-zero-effects.${mode}`,async()=>{
 const f=fixture("inactive-"+mode,{[key]:true});const r=f.realm();const w=r.window();
 if(mode==="legacy")w.gZenWorkspaces.hasIndependentCatalogProjection=false;
 if(mode==="private")w.isPrivate=true;
 if(mode==="permanent-private")f.faults.permanentPrivate=true;
 if(mode==="disabled")w.gZenWorkspaces.privateWindowOrDisabled=true;
 if(mode==="closing")w.closed=true;
 if(mode==="not-started")w.gBrowserInit.delayedStartupFinished=false;
 assert.equal((await attach(r,w)).status,"INACTIVE");assert.equal(f.stats.reads,0);assert.equal(f.stats.prefWrites.length,0);assert.equal(r.observers.size,0);assert.equal(f.stats.launches,0);
});
await test("consumer.locked-pref-not-bypassed-entire-map-held",async()=>{
 const f=fixture("locked",{[key]:true,"zen.glance.enabled":false});const r=f.realm();r.users.set(key,false);r.users.set("zen.glance.enabled",true);r.locks.add("zen.glance.enabled");const w=r.window();
 assert.equal((await attach(r,w)).status,"REFUSED");assert.equal(f.stats.prefWrites.length,0);assert.equal(f.stats.writes,0);assert.equal(r.prefs.getBoolPref(key),false);close(w);
});
await test("consumer.explicit-reset-null-default-not-seeded",async()=>{
 const f=fixture("reset",{[key]:true});const a=f.realm(),b=f.realm("B");a.defaults.set(key,false);b.defaults.set(key,true);const wa=a.window(),wb=b.window();await attach(a,wa);a.prefs.clearUserPref(key);
 await settle(f,()=>statuses(f).some(s=>s.status==="COMMITTED"));assert.equal(f.read().sharedPreferences[key],null);b.users.set(key,false);await attach(b,wb);assert(!b.users.has(key));assert.equal(b.prefs.getBoolPref(key),true);close(wa);close(wb);
});
await test("consumer.focus-refresh-cross-profile-no-echo",async()=>{
 const f=fixture("refresh",{[key]:false});const a=f.realm(),b=f.realm("B");const wa=a.window(),wb=b.window();await attach(a,wa);await attach(b,wb);a.prefs.setBoolPref(key,true);await settle(f,()=>statuses(f).some(s=>s.status==="COMMITTED"));
 assert.equal(b.prefs.getBoolPref(key),false);wb.dispatch("focus");await settle(f,()=>b.prefs.getBoolPref(key)===true);assert.equal(f.stats.launches,1);close(wa);close(wb);
});
await test("consumer.hydration-concurrent-edit-not-overwritten",async()=>{
 const f=fixture("hydration",{[key]:false});const a=f.realm();const gate=deferred();let held=false;f.faults.read=async(_p,profile)=>{if(profile==="A"&&!held){held=true;await gate.promise;}};const w=a.window();const ready=attach(a,w);await settle(f,()=>held);a.prefs.setBoolPref(key,true);gate.resolve();await ready;
 assert.equal(a.prefs.getBoolPref(key),true);assert.equal(f.read().sharedPreferences[key],true);assert.equal(f.stats.launches,1);close(w);
});
await test("consumer.rapid-edits-serialized-no-old-completion-overwrite",async()=>{
 const f=fixture("rapid",{[key]:false});const a=f.realm();const w=a.window();await attach(a,w);const gate=deferred();let waited=false;f.faults.wait=async()=>{if(!waited){waited=true;await gate.promise;}};
 a.prefs.setBoolPref(key,true);await settle(f,()=>waited);a.prefs.setBoolPref(key,false);a.prefs.setBoolPref("zen.view.use-single-toolbar",true);gate.resolve();await settle(f,()=>statuses(f).filter(s=>s.status==="COMMITTED").length===3);
 assert.equal(f.read().sharedPreferences[key],false);assert.equal(f.read().sharedPreferences["zen.view.use-single-toolbar"],true);assert.equal(a.prefs.getBoolPref(key),false);assert.equal(f.stats.launches,3);close(w);
});
await test("consumer.same-process-one-observer-owner-last-unload-cleanup",async()=>{
 const f=fixture("windows");const a=f.realm();const w1=a.window(),w2=a.window();await attach(a,w1);await attach(a,w2);
 assert.equal([...a.observers.values()].reduce((n,s)=>n+s.size,0),17);close(w1);a.prefs.setBoolPref(key,true);await settle(f,()=>statuses(f).some(s=>s.status==="COMMITTED"));close(w2);await tick();
 assert.equal([...a.observers.values()].reduce((n,s)=>n+s.size,0),0);assert.equal(w1.listeners.get("focus").size,0);assert.equal(w2.listeners.get("unload").size,0);
 a.prefs.setBoolPref(key,false);await tick();assert.equal(f.stats.launches,1);
});
for(const mode of ["profile","manager","window-manager","closed"])await test(`consumer.held-hydration-stale-owner.${mode}`,async()=>{
 const f=fixture("stale-"+mode,{[key]:true});const a=f.realm();a.users.set(key,false);const gate=deferred();let held=false;f.faults.read=async()=>{if(!held){held=true;await gate.promise;}};const w=a.window();const ready=attach(a,w);await settle(f,()=>held);
 if(mode==="profile")a.swapProfile("B");if(mode==="manager")f.faults.manager="B";if(mode==="window-manager")w.gZenWorkspaces={...w.gZenWorkspaces};if(mode==="closed")close(w);gate.resolve();
 assert.equal((await ready).status,"REFUSED");assert.equal(a.prefs.getBoolPref(key),false);assert.equal(f.stats.prefWrites.length,0);assert.equal(f.stats.launches,0);if(!w.closed)close(w);
});
await test("consumer.last-window-late-commit-no-resurrection",async()=>{
 const f=fixture("late",{[key]:false});const a=f.realm();const w=a.window();await attach(a,w);const gate=deferred();let held=false;f.faults.wait=async()=>{held=true;await gate.promise;};a.prefs.setBoolPref(key,true);await settle(f,()=>held);close(w);const writes=f.stats.prefWrites.length;gate.resolve();await settle(f,()=>statuses(f).some(s=>s.local==="NOT_PROJECTED"));
 assert.equal(f.stats.prefWrites.length,writes);assert.equal([...a.observers.values()].reduce((n,s)=>n+s.size,0),0);assert.equal(f.stats.launches,1);
});
await test("consumer.CAS-stale-refusal-local-only-no-retry",async()=>{
 const f=fixture("cas",{[key]:false});const a=f.realm();const w=a.window();await attach(a,w);let changed=false;f.faults.read=async(_p,profile)=>{if(profile==="manager"&&!changed){changed=true;const c=f.read();c.zenCatalogRevision++;c.zenCatalogRequestId=ids(700);c.sharedPreferences["zen.view.use-single-toolbar"]=true;fs.writeFileSync(f.catalogPath,JSON.stringify(c));}};
 a.prefs.setBoolPref(key,true);await settle(f,()=>statuses(f).some(s=>s.status==="REFUSED"));assert.equal(a.prefs.getBoolPref(key),true);assert.equal(f.read().sharedPreferences[key],false);assert.equal(f.read().sharedPreferences["zen.view.use-single-toolbar"],true);assert.equal(f.stats.launches,1);await tick();assert.equal(f.stats.launches,1);close(w);
});
await test("consumer.write-failure-UNKNOWN-canonical-old-no-false-rollback-retry",async()=>{
 const f=fixture("unknown",{[key]:false,"zen.view.use-single-toolbar":false});const a=f.realm();const w=a.window();await attach(a,w);const before=fs.readFileSync(f.catalogPath,"utf8");f.faults.write=async()=>{throw new Error("injected write failure");};a.prefs.setBoolPref(key,true);await settle(f,()=>statuses(f).some(s=>s.status==="UNKNOWN"));
 assert.equal(fs.readFileSync(f.catalogPath,"utf8"),before);assert.equal(a.prefs.getBoolPref(key),true);a.prefs.setBoolPref("zen.view.use-single-toolbar",true);w.dispatch("focus");await tick();await tick();assert.equal(f.stats.launches,1);assert.equal(a.prefs.getBoolPref(key),true);assert.equal(a.prefs.getBoolPref("zen.view.use-single-toolbar"),true);close(w);
});
await test("client.deadline-retains-busy-until-owned-wait",async()=>{
 const f=fixture("timeout");const a=f.realm();let expire;f.faults.timer=fn=>{expire=fn;return undefined;};const gate=deferred();let held=false;f.faults.wait=async()=>{held=true;await gate.promise;};const request=f.request(true);const pending=a.commit(request);await settle(f,()=>held);expire();assert.equal((await pending).status,"UNKNOWN");assert.equal((await a.commit(f.request(false))).error,"Busy");assert.equal(f.stats.launches,1);gate.resolve();await tick();await tick();delete f.faults.wait;
 assert.equal((await a.commit(f.request(false))).status,"COMMITTED");assert.equal(f.stats.launches,2);
});
await test("consumer.readback-failure-after-confirmed-commit-not-false-refusal",async()=>{
 const f=fixture("postcommit",{[key]:false});const a=f.realm();const w=a.window();await attach(a,w);let readsAfter=0;f.faults.read=async(_p,profile)=>{if(f.read().zenCatalogRevision===2&&profile==="A"&&++readsAfter===2){const error=new Error("read unavailable");error.name="NotReadableError";throw error;}};
 a.prefs.setBoolPref(key,true);await settle(f,()=>statuses(f).some(s=>["COMMITTED","REFUSED","UNKNOWN"].includes(s.status)));assert.equal(f.read().sharedPreferences[key],true);const result=statuses(f).at(-1);assert.equal(result.status,"COMMITTED");assert.equal(result.local,"NOT_PROJECTED");close(w);
});
await test("consumer.programming-exception-propagates-not-expected-fallback",async()=>{
 const f=fixture("programming");const a=f.realm();const w=a.window();f.faults.read=async()=>{throw new Error("programming defect");};await assert.rejects(attach(a,w),/programming defect/);assert.equal(statuses(f).length,0);close(w);
});
await test("startup.actual-delayed-chain-hydrates-before-compact-expected-failure-continues",async()=>{
 const f=fixture("startup",{[key]:true});const a=f.realm();const w=a.window();let compact=0;let seen;
 const workspaces=w.gZenWorkspaces;workspaces.promiseInitialized=Promise.resolve();
 Object.assign(a.context,{window:w,gZenWorkspaces:workspaces,delayedStartupPromise:Promise.resolve(),SessionStore:{promiseAllWindowsRestored:Promise.resolve()},
  gZenCompactModeManager:{init(){compact++;seen=a.prefs.getBoolPref(key,false);}},gURLBar:{hasAttribute:()=>false},gZenUIManager:{updateTabsToolbar(){}},
  document:{documentElement:{removeAttribute(){}},getElementById:()=>({setAttribute(){}})},});w.requestAnimationFrame=()=>{};
 // Only the unrelated update-animation ES import is substituted.
 new vm.Script(startupSource.replace(/^import[\s\S]*?;\n/m,""),{filename:"ZenStartup.mjs"}).runInContext(a.context);
 w.gZenStartup.delayedStartupFinished();await settle(f,()=>compact===1);assert.equal(seen,true);assert.equal(f.stats.writes,0);close(w);
 const b=f.realm("B");const wb=b.window();let continued=false;wb.gZenWorkspaces.promiseInitialized=Promise.resolve();Object.assign(b.context,{window:wb,gZenWorkspaces:wb.gZenWorkspaces,delayedStartupPromise:Promise.resolve(),SessionStore:{promiseAllWindowsRestored:Promise.resolve()},gZenCompactModeManager:{init(){continued=true;}},gURLBar:{hasAttribute:()=>false},gZenUIManager:{updateTabsToolbar(){}},document:{documentElement:{removeAttribute(){}},getElementById:()=>({setAttribute(){}})}});wb.requestAnimationFrame=()=>{};
 f.faults.read=async()=>{const e=new Error("bad JSON");e.name="SyntaxError";throw e;};new vm.Script(startupSource.replace(/^import[\s\S]*?;\n/m,"")).runInContext(b.context);wb.gZenStartup.delayedStartupFinished();await settle(f,()=>continued);assert(statuses(f).some(s=>s.status==="REFUSED"));close(wb);
});
await test("consumer.confirmed-type-replaces-mismatched-local-type",async()=>{
 const f=fixture("local-type-hydrate",{[key]:true});const a=f.realm();a.users.set(key,"invalid old local type");const w=a.window();await attach(a,w);assert.equal(a.prefs.getBoolPref(key),true);assert.equal(f.stats.launches,0);close(w);
});
await test("consumer.wrong-local-type-refused-not-thrown-or-shared",async()=>{
 const f=fixture("wrong-local-type");const a=f.realm();const w=a.window();await attach(a,w);
 assert.doesNotThrow(()=>a.prefs.setStringPref(key,"not boolean"));assert.equal(f.stats.launches,0);assert(statuses(f).some(s=>s.status==="REFUSED"&&s.local==="LOCAL_ONLY"));close(w);
});
await test("legacy.activation-refusals-binding-and-tmp-controls",async()=>{
 const f=fixture("old-controls");const r=f.realm("manager",true);const before=fs.readFileSync(f.catalogPath,"utf8");
 const activate={zenCatalogOperation:"activate",zenCatalogRequestId:ids(800),zenCatalogRevision:0,spaces:[f.spaces[0]]};assert.notEqual(await r.run(activate),0);assert.equal(fs.readFileSync(f.catalogPath,"utf8"),before);
 const request=f.request(true);delete request.preference;request.zenCatalogOperation="upsert";request.space={...f.spaces[0],geckoProfileReference:f.spaces[1].geckoProfileReference};assert.notEqual(await r.run(request),0);assert.equal(fs.readFileSync(f.catalogPath,"utf8"),before);
 fs.writeFileSync(f.catalogPath+".tmp","foreign leftover");assert.notEqual(await r.run(f.request(true)),0);assert.equal(fs.readFileSync(f.catalogPath,"utf8"),before);assert.equal(fs.readFileSync(f.catalogPath+".tmp","utf8"),"foreign leftover");assert.equal(f.stats.writes,0);
 const fresh=fixture("activate-fresh");fs.unlinkSync(fresh.catalogPath);activate.spaces=[fresh.spaces[0]];assert.equal(await fresh.realm("manager",true).run(activate),0);assert(!Object.hasOwn(fresh.read(),"sharedPreferences"));
});
await test("client.detached-request-and-64KiB-limit-before-launch",async()=>{
 const f=fixture("detach");const a=f.realm();const gate=deferred();let held=false;f.faults.read=async()=>{if(!held){held=true;await gate.promise;}};const request=a.data(f.request(true));const pending=a.load("ZenIndependentCatalogClient.sys.mjs").requestZenCatalogCommit(request);await settle(f,()=>held);request.preference.value=false;gate.resolve();assert.equal((await pending).status,"COMMITTED");assert.equal(f.read().sharedPreferences[key],true);
 const big=f.request(true);delete big.preference;big.zenCatalogOperation="upsert";big.space={...f.spaces[0],name:"x".repeat(65536)};const launches=f.stats.launches;assert.equal((await a.commit(big)).status,"REFUSED");assert.equal(f.stats.launches,launches);
});
await test("client.commit-readback-mismatch-never-fake-success",async()=>{
 const f=fixture("mismatch");const a=f.realm();f.faults.afterWrite=async()=>{const c=f.read();c.sharedPreferences[key]=false;fs.writeFileSync(f.catalogPath,JSON.stringify(c));};const reply=await a.commit(f.request(true));assert.equal(reply.status,"UNKNOWN");assert.equal(f.read().sharedPreferences[key],false);
});
// S1: endpoint arguments, not observer diagnostics, establish presentation.
for (const mode of ["refused", "unknown", "not-projected"]) await test(`S1.visible-once.${mode}`,async()=>{
 const f=fixture("s1-"+mode,{[key]:false});const a=f.realm();const w=a.window(),other=a.window();await attach(a,w);await attach(a,other);
 const modal=deferred();f.faults.prompt=()=>modal.promise;
 if(mode==="refused")a.prefs.setStringPref(key,"invalid type");
 if(mode==="unknown"){f.faults.write=async()=>{throw Error("injected write failure");};a.prefs.setBoolPref(key,true);}
 if(mode==="not-projected"){let n=0;f.faults.read=async(_p,profile)=>{if(profile==="A"&&f.read().zenCatalogRevision===2&&++n===2){const e=Error("unavailable");e.name="NotReadableError";throw e;}};a.prefs.setBoolPref(key,true);}
 await tick();await tick();if(mode!=="refused")await settle(f,()=>statuses(f).some(s=>s.status===(mode==="unknown"?"UNKNOWN":"COMMITTED")));
 await tick();assert.equal(f.stats.prompts.length,1,"one actual prompt endpoint per failure across two windows");
 const args=f.stats.prompts[0];assert.equal(args[0],w.browsingContext);assert.equal(args[1],1);assert.equal(args[2],"zen-shared-preferences-title");assert.equal(args[3],`zen-shared-preferences-${mode==="refused"?"local-only":mode}`);assert.equal(args[4],1);assert.equal(args.length,10);
 // The unresolved modal must not keep the transport slot or worker alive.
 if(mode==="not-projected"){delete f.faults.read;assert.equal((await a.commit(f.request(false))).status,"COMMITTED");}
 const launches=f.stats.launches;modal.resolve();await tick();assert.equal(f.stats.launches,launches);close(w);close(other);
});
for(const mode of ["closed","manager","profile","permanent-private"])await test(`S1.localization-stale-owner.${mode}`,async()=>{
 const f=fixture("s1-l10n-"+mode);const a=f.realm();const w=a.window();await attach(a,w);const gate=deferred();let held=false;f.faults.l10n=async()=>{held=true;await gate.promise;};a.prefs.setStringPref(key,"invalid");
 await tick();assert.equal(held,true,"presentation must localize before opening");
 if(mode==="closed")close(w);if(mode==="manager")w.gZenWorkspaces={...w.gZenWorkspaces};if(mode==="profile")a.swapProfile("B");if(mode==="permanent-private")f.faults.permanentPrivate=true;
 gate.resolve();await tick();assert.equal(f.stats.prompts.length,0);if(!w.closed)close(w);
});
// S2: hold the Client's own final reader preflight, not hydration or proc.wait.
for(const mode of ["closed","window-manager","profile","manager","permanent-private","private","disabled"])await test(`S2.client-preflight-retired.${mode}`,async()=>{
 const f=fixture("s2-"+mode,{[key]:false});const a=f.realm();const w=a.window();await attach(a,w);const gate=deferred();let held=false;f.faults.clientPreflight=async()=>{held=true;await gate.promise;};a.prefs.setBoolPref(key,true);await settle(f,()=>held);assert.equal(f.stats.launches,0);
 if(mode==="closed")close(w);if(mode==="window-manager")w.gZenWorkspaces={...w.gZenWorkspaces};if(mode==="profile")a.swapProfile("B");if(mode==="manager")f.faults.manager="B";if(mode==="permanent-private")f.faults.permanentPrivate=true;if(mode==="private")w.isPrivate=true;if(mode==="disabled")w.gZenWorkspaces.privateWindowOrDisabled=true;
 gate.resolve();await settle(f,()=>statuses(f).some(s=>["REFUSED","COMMITTED","UNKNOWN"].includes(s.status)));assert.equal(f.stats.launches,0,"retired caller must never first launch");assert.equal(f.stats.writes,0);if(!w.closed)close(w);
});
await test("S2.client-sync-strict-true-and-ordinary-single-argument",async()=>{
 const f=fixture("s2-guard");const a=f.realm();let checked=0;
 const reply=await a.commit(f.request(true),()=>{checked++;return true;});assert.equal(reply.status,"COMMITTED");assert.equal(checked,1);
 for(const guard of [()=>false,()=>1,()=>Promise.resolve(true),null,undefined]){const n=f.stats.launches;assert.equal((await a.commit(f.request(false),guard)).status,"REFUSED");assert.equal(f.stats.launches,n);}
 assert.equal((await a.commit(f.request(false))).status,"COMMITTED");
});
for(const mode of ["startup-catalog","minimum-revision","evolving-marker"])await test(`S3.consent.${mode}`,async()=>{
 const f=fixture("s3-consent-"+mode,{[key]:true});const a=f.realm();a.users.set(key,false);const w=a.window();
 if(mode==="startup-catalog"){const c=f.read();c.zenCatalogId=ids(900);fs.writeFileSync(f.catalogPath,JSON.stringify(c));}
 if(mode==="minimum-revision")a.setConsent({zenCatalogId:ids(10),zenCatalogRevision:2});
 let pending,gate;
 if(mode==="evolving-marker"){gate=deferred();let held=false;f.faults.read=async()=>{if(!held){held=true;await gate.promise;}};pending=attach(a,w);await settle(f,()=>held);a.setConsent({zenCatalogId:ids(900),zenCatalogRevision:1});gate.resolve();}else pending=attach(a,w);
 await pending;assert.equal(a.prefs.getBoolPref(key),false,"unconsented catalog must not project");assert.equal(f.stats.prefWrites.length,0);assert.equal(f.stats.launches,0);assert.equal(f.stats.writes,0);close(w);
});
for(const mode of ["request","map","metadata"])for(const route of ["focus","edit"])await test(`S3.equal-revision.${mode}.${route}`,async()=>{
 const f=fixture(`s3-equal-${mode}-${route}`,{[key]:false});const a=f.realm();const w=a.window();await attach(a,w);const n=f.stats.prefWrites.length;
 const c=f.read();if(mode==="request")c.zenCatalogRequestId=ids(901);if(mode==="map")c.sharedPreferences[key]=true;if(mode==="metadata")c.spaces[0].name="equivocation";fs.writeFileSync(f.catalogPath,JSON.stringify(c));
 if(route==="focus")w.dispatch("focus");else a.prefs.setBoolPref("zen.glance.enabled",true);
 await tick();await tick();assert.equal(f.stats.launches,0,"equal-revision equivocation must not commit");assert.equal(f.stats.writes,0);assert.equal(a.prefs.getBoolPref(key),false,"equal-revision equivocation must not project");assert.equal(f.stats.prefWrites.length,n+(route==="edit"?1:0));assert(statuses(f).some(s=>s.status==="REFUSED"));close(w);
});
await test("S3.newer-revision-and-semantic-key-order-admitted",async()=>{
 const f=fixture("s3-newer",{[key]:false,"zen.glance.enabled":true});const a=f.realm();const w=a.window();await attach(a,w);
 let c=f.read();c.sharedPreferences={"zen.glance.enabled":true,[key]:false};fs.writeFileSync(f.catalogPath,JSON.stringify(c));w.dispatch("focus");await tick();assert(!statuses(f).some(s=>s.status==="REFUSED"));
 c=f.read();c.zenCatalogRevision++;c.zenCatalogRequestId=ids(902);c.sharedPreferences[key]=true;fs.writeFileSync(f.catalogPath,JSON.stringify(c));w.dispatch("focus");await settle(f,()=>a.prefs.getBoolPref(key));assert.equal(f.stats.launches,0);close(w);
});
await test("S3.diagnostic-actual-consent-getter-detached-readonly",()=>{
 assert(consentGetter,"DIAGNOSTIC_API_GAP: readonly getter absent; semantic consent tests are separate");
 const f=fixture("s3-getter");const a=f.realm();const marker={zenCatalogId:ids(10),zenCatalogRevision:2};a.setConsent(marker);const result=a.consentStore.independentCatalogConsent;
 assert.deepEqual(Object.keys(result).sort(),["zenCatalogId","zenCatalogRevision"]);assert(Object.isFrozen(result));assert.notEqual(result,marker);assert.throws(()=>{result.zenCatalogId=ids(903);},TypeError);assert.equal(marker.zenCatalogId,ids(10));marker.zenCatalogRevision=3;assert.equal(result.zenCatalogRevision,2);assert.equal(a.consentStore.independentCatalogConsent.zenCatalogRevision,3);a.setConsent(null);assert.equal(a.consentStore.independentCatalogConsent,null);assert.equal(f.stats.reads,0);assert.equal(f.stats.writes,0);
});
for(const mode of ["terminal-microtask","refusal-reentry"])await test(`S4.successor-without-extra-wakeup.${mode}`,async()=>{
 const second="zen.glance.enabled";const f=fixture("s4-"+mode,{[key]:false});const a=f.realm();const w=a.window();await attach(a,w);let produced=false;
 f.faults.report=result=>{if(!produced&&result.status===(mode==="terminal-microtask"?"COMMITTED":"REFUSED")){produced=true;const produce=()=>a.prefs.setBoolPref(second,true);if(mode==="terminal-microtask")queueMicrotask(produce);else produce();}};
 if(mode==="refusal-reentry"){let changed=false;f.faults.read=async(_p,profile)=>{if(profile==="manager"&&!changed){changed=true;const c=f.read();c.zenCatalogRevision++;c.zenCatalogRequestId=ids(910);fs.writeFileSync(f.catalogPath,JSON.stringify(c));}};}
 a.prefs.setBoolPref(key,true);await settle(f,()=>produced);await tick();await tick();
 assert.equal(f.read().sharedPreferences[second],true,"new producer intent stranded at retirement");assert.equal(f.stats.launches,2,"no duplicate launch of original intent");assert.equal(f.read().sharedPreferences[key],mode==="terminal-microtask");assert.equal(statuses(f).filter(s=>s.status==="COMMITTED").length,mode==="terminal-microtask"?2:1);close(w);
});
await test("S4.programming-error-surfaces-no-old-intent-replay",async()=>{
 const f=fixture("s4-programming",{[key]:false});const a=f.realm();const w=a.window();await attach(a,w);let failed=false;
 f.faults.read=async()=>{if(!failed){failed=true;throw Error("producer programming defect");}};
 a.prefs.setBoolPref(key,true);await settle(f,()=>f.stats.reports.some(r=>r.programmingError));await tick();assert.equal(f.stats.launches,0);assert.equal(f.stats.reports.filter(r=>r.programmingError).length,1);assert.equal(statuses(f).length,0);
 a.prefs.setBoolPref("zen.glance.enabled",true);await settle(f,()=>statuses(f).some(s=>s.status==="COMMITTED"));assert.equal(f.stats.launches,1,"failed old intent must not be automatically replayed by a new edit");assert.equal(f.read().sharedPreferences[key],false);assert.equal(f.read().sharedPreferences["zen.glance.enabled"],true);close(w);
});
await test("S1.known-commit-newer-authority-not-unknown",async()=>{
 const f=fixture("s1-known-newer",{[key]:false});const a=f.realm();const w=a.window();await attach(a,w);let n=0;
 f.faults.read=async(_p,profile)=>{if(profile==="A"&&f.read().zenCatalogRevision===2&&++n===2){const c=f.read();c.zenCatalogRevision++;c.zenCatalogRequestId=ids(920);c.sharedPreferences[key]=false;fs.writeFileSync(f.catalogPath,JSON.stringify(c));}};
 a.prefs.setBoolPref(key,true);await settle(f,()=>statuses(f).length);await tick();const result=statuses(f).at(-1);assert.equal(result.status,"COMMITTED","known commit must stay known when a newer catalog prevents projection");assert.equal(result.local,"NOT_PROJECTED");assert.equal(f.stats.prompts.at(-1)[3],"zen-shared-preferences-not-projected");a.prefs.setBoolPref("zen.glance.enabled",true);await tick();assert.equal(f.stats.launches,1);close(w);
});
await test("S1.select-only-nonprivate-enrolled-owner",async()=>{
 const f=fixture("s1-private-owner");const a=f.realm();const w=a.window(),other=a.window();await attach(a,w);await attach(a,other);w.isPrivate=true;a.prefs.setStringPref(key,"invalid");await tick();assert.equal(f.stats.prompts.length,1);assert.equal(f.stats.prompts[0][0],other.browsingContext);close(w);close(other);
});
await test("S1.localization-private-owner-with-other-live-window",async()=>{
 const f=fixture("s1-l10n-private-other");const a=f.realm();const w=a.window(),other=a.window();await attach(a,w);await attach(a,other);const gate=deferred();let held=false;f.faults.l10n=async()=>{held=true;await gate.promise;};a.prefs.setStringPref(key,"invalid");await settle(f,()=>held);w.isPrivate=true;gate.resolve();await tick();assert.equal(f.stats.prompts.length,0,"do not dispatch to a now-private selected owner");close(w);close(other);
});
// Parent S3 sibling probe: Client observes changed metadata at the same epoch.
for(const mode of ["request","map","metadata"])await test(`parent.S3.client-preflight-equal-epoch.${mode}`,async()=>{
 const f=fixture("parent-client-equal-"+mode,{[key]:false});const a=f.realm();const w=a.window();await attach(a,w);let reads=0;
 f.faults.read=async(_p,profile)=>{if(profile==="A"&&++reads===2){const c=f.read();if(mode==="request")c.zenCatalogRequestId=ids(940);if(mode==="map")c.sharedPreferences[key]=true;if(mode==="metadata")c.spaces[0].name="client-observed-equivocation";fs.writeFileSync(f.catalogPath,JSON.stringify(c));}};
 a.prefs.setBoolPref("zen.glance.enabled",true);await settle(f,()=>statuses(f).some(s=>["REFUSED","COMMITTED","UNKNOWN"].includes(s.status)));
 assert.equal(f.stats.launches,0,"equal-epoch equivocation observed inside Client preflight must not launch");assert.equal(f.stats.writes,0);close(w);
});
// Final preflight metadata is detached from Client-owned confirmation state.
await test("S3.client-preflight-detached-mutation-keeps-real-confirmation",async()=>{
 const f=fixture("s3-guard-detached",{[key]:false});const a=f.realm();let supplied;
 const reply=await a.commit(f.request(true),snapshot=>{
  assert(snapshot,"guard must receive the actually admitted preflight snapshot");supplied=snapshot;
  assert.equal(snapshot.spaces.length,2);assert.equal(snapshot.sharedPreferences[key],false);
  snapshot.zenCatalogId=ids(950);snapshot.zenCatalogRevision=99;snapshot.zenCatalogRequestId=ids(951);
  snapshot.spaces[0].name="guard-only";snapshot.sharedPreferences[key]=true;
  return true;
 });
 assert.equal(reply.status,"COMMITTED","guard mutation cannot poison private prior confirmation");
 assert.equal(f.stats.launches,1);assert.equal(f.stats.writes,1);assert.deepEqual(f.read().spaces,f.spaces);
 assert.equal(f.read().zenCatalogRevision,2);assert.equal(f.read().zenCatalogId,ids(10));assert.equal(supplied.spaces[0].name,"guard-only");
});
for(const mode of ["spaces","map"])await test(`S3.client-preflight-detached-mutation-cannot-forge-confirmation.${mode}`,async()=>{
 const f=fixture("s3-guard-forge-"+mode,{[key]:false,"zen.glance.enabled":false});const a=f.realm();
 f.faults.afterWrite=async()=>{const c=f.read();if(mode==="spaces")c.spaces[0].name="forged";else c.sharedPreferences["zen.glance.enabled"]=true;fs.writeFileSync(f.catalogPath,JSON.stringify(c));};
 const reply=await a.commit(f.request(true),snapshot=>{
  assert(snapshot,"guard must receive detached admitted metadata");
  if(mode==="spaces")snapshot.spaces[0].name="forged";else snapshot.sharedPreferences["zen.glance.enabled"]=true;
  return true;
 });
 assert.equal(f.stats.launches,1);assert.equal(f.stats.writes,1);
 assert.equal(reply.status,"UNKNOWN","guard mutation cannot authorize unrelated readback effects");
});
await test("S3.client-observed-semantic-key-order-local-view-admitted",async()=>{
 const f=fixture("s3-client-key-order",{[key]:false,"zen.glance.enabled":false});const a=f.realm();const w=a.window();await attach(a,w);let reads=0;
 f.faults.read=async(_p,profile)=>{if(profile==="A"&&++reads===2){const c=f.read();c.sharedPreferences={"zen.glance.enabled":false,[key]:false};c.spaces=c.spaces.map(s=>Object.fromEntries(Object.entries(s).reverse()));fs.writeFileSync(f.catalogPath,JSON.stringify(Object.fromEntries(Object.entries(c).reverse())));}};
 a.prefs.setBoolPref("zen.glance.enabled",true);await settle(f,()=>statuses(f).length);
 assert.equal(statuses(f).at(-1).status,"COMMITTED");assert.equal(f.stats.launches,1);assert.equal(f.stats.writes,1);assert.equal(f.read().sharedPreferences["zen.glance.enabled"],true);assert.deepEqual(f.read().spaces,f.spaces);close(w);
});
await test("S3.client-observed-newer-revision-refuses-stale-request",async()=>{
 const f=fixture("s3-client-newer",{[key]:false});const a=f.realm();const w=a.window();await attach(a,w);let reads=0;
 f.faults.read=async(_p,profile)=>{if(profile==="A"&&++reads===2){const c=f.read();c.zenCatalogRevision++;c.zenCatalogRequestId=ids(952);fs.writeFileSync(f.catalogPath,JSON.stringify(c));}};
 a.prefs.setBoolPref("zen.glance.enabled",true);await settle(f,()=>statuses(f).length);
 assert.equal(statuses(f).at(-1).status,"REFUSED");assert.equal(f.stats.launches,0);assert.equal(f.stats.writes,0);close(w);
});
await tick();
await test("harness.no-unowned-rejection",()=>assert.deepEqual(unhandled,[]));
console.log(JSON.stringify({kind:"Node-owned-FS-adapter-not-Gecko",pid:process.pid,ppid:process.ppid,bootstrapEnvironmentKeys,activeEnvironmentKeys:Object.keys(process.env).sort(),sourceRoot,owned,hashes,events,total:events.length,passed:events.filter(e=>e.outcome==="PASS").length},null,2));
if(events.some(e=>e.outcome!=="PASS"))process.exitCode=1;
