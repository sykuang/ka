import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root=process.argv[3], repo=process.argv[2];
const source=fs.readFileSync(repo+'/src/zen/sessionstore/ZenSessionManager.sys.mjs','utf8');
assert.ok(source.includes('async activateIndependentCatalog('),'API-contract RED: missing activation/join seam');
const {api,state,owned,authority,children,space,uuid}=await import(pathToFileURL(root+'/transport.mjs'));
const {reader,task}=await import(pathToFileURL(root+'/child-adapter.mjs'));
const nativeImport=ChromeUtils.importESModule;
ChromeUtils.importESModule=uri=>uri==='resource://gre/modules/PlacesUtils.sys.mjs' ?
  {PlacesUtils:{promiseDBConnection:async()=>({execute:async()=>[]})}} : nativeImport(uri);
const prefs={getBoolPref(k,d){if(k==='zen.session-store.backup-file')return false;return d??true;},getIntPref(){return 3;},getStringPref(){return ''}};
Services.prefs=prefs; Services.obs={notifyObservers(){}};
PathUtils.profileDir=owned+'/A';
const sessionPath=PathUtils.profileDir+'/zen-sessions.jsonlz4';
const readJSON=IOUtils.readJSON;
let markerWrites=0,markerFault=false,markerHook=null,readHook=null,localWriteHold=null;
IOUtils.readJSON=async (...args)=>{const value=await readJSON(...args);if(readHook)await readHook(args[0],value);return value;};
IOUtils.copy=async()=>{};
IOUtils.writeJSON=async (p,value,options)=>{
 assert.equal(p,sessionPath,'SessionStore only writes owned local marker');
 markerWrites++;
 if(localWriteHold)await localWriteHold;
 if(markerHook)await markerHook();
 if(markerFault)throw new Error('controlled local write refusal swallowed by actual JSONFile._save');
 const text=JSON.stringify(value);await fsp.writeFile(p+'.tmp',text);await fsp.rename(p+'.tmp',p);return {size:Buffer.byteLength(text),jsonLength:text.length};
};
class JSONFile {
 constructor(options){this.path=options.path;this._options={compression:'lz4'};this._saver={disarm(){},_runningPromise:null};this._saveFailureHandler=()=>{};this.dataReady=true;}
 get data(){return this._data;} set data(d){this._data=d;}
 async load(){this.data=await readJSON(this.path);}
 saveSoon(){return undefined;}
}
// Execute owning Gecko JSONFile._save body; only filesystem/compression are adapted.
JSONFile.prototype._save=eval('({'+fs.readFileSync(root+'/jsonfile-save-body.txt','utf8')+'})')._save;
globalThis.JSONFile=JSONFile;
globalThis.Cu={cloneInto:structuredClone,reportError(error){console.error('PRODUCT_ERROR',error);}};
globalThis.XPCOMUtils={defineLazyPreferenceGetter(t,k,p,d){t[k]= k==='gShouldLog'?false:d;}};
class DeferredTask { arm(){} }
let browsingState,store;
const sessionAPI={getCurrentState(){return browsingState;}};
ChromeUtils.defineESModuleGetters=(target,map)=>{
 for(const [name,uri] of Object.entries(map)){
  if(uri.includes('ZenIndependentCatalogReader'))target[name]=reader[name];
  else if(uri.includes('ZenIndependentCatalogClient'))target[name]=api[name];
  else if(name==='SessionStore')target[name]=sessionAPI;
  else if(name==='ZenSessionStore')Object.defineProperty(target,name,{get:()=>store});
  else if(name==='PrivateBrowsingUtils')target[name]={permanentPrivateBrowsing:false};
  else if(name==='DeferredTask')target[name]=DeferredTask;
  else if(name==='ZenLiveFoldersManager')target[name]={saveState(){}};
  else if(name==='gWindowSyncEnabled')target[name]=true;
  else if(name==='gSyncOnlyPinnedTabs')target[name]=false;
 }
};
await fsp.writeFile(root+'/session-boundary.mjs',source.replace(/^import .*;$/gm,''));
const {nsZenSessionManager}=await import(pathToFileURL(root+'/session-boundary.mjs'));
const cases=[], failures=[], lifecycleEvidence=[];
const windows=[];
const win=()=>({closed:false,browsingContext:{},gBrowserInit:{delayedStartupFinished:true},gZenWorkspaces:{privateWindowOrDisabled:false,getWorkspaces(){return browsingState.windows[0].spaces;}}});
const blank=()=>({entries:[{url:'about:blank'}]});
const raw=(spaces=[space(1),space(2)],tabs=[{zenSyncId:'local-tab',zenWorkspace:uuid(1),entries:[{url:'https://owned.invalid/original'}]}])=>({geckoProfileBindingVersion:1,spaces:structuredClone(spaces),tabs:structuredClone(tabs),folders:[{id:'local-folder'}],groups:[{id:'local-group'}],splitViewData:[{id:7}],activeZenSpace:spaces[0]?.uuid??'',selected:1,lastCollected:10});
async function reset(spaces,tabs){
 state.active=false;state.fault='normal';markerFault=false;markerHook=null;readHook=null;localWriteHold=null;markerWrites=0;
 if(fs.existsSync(authority))await fsp.rename(authority,authority+'.retained-'+(cases.length+failures.length));
 if(fs.existsSync(authority+'.tmp'))await fsp.rename(authority+'.tmp',authority+'.tmp-retained-'+(cases.length+failures.length));
 const local=raw(spaces,tabs);browsingState={windows:[structuredClone(local)],global:{original:'retained'},_closedWindows:[]};
 await fsp.writeFile(sessionPath,JSON.stringify(local));
 store=new nsZenSessionManager();await store.readFile();store.onFileRead(structuredClone(browsingState));assert.equal(store.canSaveSession,true);
 return win();
}
const confirm=async()=>{assert.equal(store.canMutateWorkspaceMetadata,false,'metadata readonly before confirmation effect');assert.equal(store.canSaveSession,false);return true;};
async function check(name,fn){try{await fn();cases.push(name);console.log('PASS '+name);}catch(error){failures.push({name,error:String(error),stack:error.stack});console.error('FAIL '+name+'\n'+error.stack);}}
async function seedCatalog(spaces){state.active=true;const c={zenCatalogVersion:1,zenCatalogId:uuid(900),zenCatalogRevision:1,zenCatalogRequestId:uuid(901),spaces};await fsp.writeFile(authority,JSON.stringify(c));return c;}

const wmText=fs.readFileSync(repo+'/src/zen/spaces/ZenSpaceManager.mjs','utf8');
assert.ok(wmText.includes('import { nsZenThemePicker } from "resource:///modules/zen/ZenGradientGenerator.mjs";'));
function member(text,name){const start=text.indexOf('  '+name);assert.ok(start>=0,name);const end=text.indexOf('\n  }',start);return text.slice(start,end+4);}
// Modeled native move semantics, not Gecko DOM: nsINode::MoveBefore and
// CustomElementRegistry eConnectedMove (including descendant fallback reactions).
let moveHook=null;
const lifecycleErrors=[], moveEvents=[];
class Element {
 constructor(){this.attrs={};this.events={};this.style={removeProperty(){},setProperty(){}};this.children=[];this.parentNode=this.parentElement=null;this.hidden=false;this.isConnected=false;this.value='';this.reactions={};this.removals=0;this.classList={contains(){return false;}};}
 setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;} removeAttribute(k){delete this.attrs[k];} hasAttribute(k){return k in this.attrs;}
 addEventListener(k,f){(this.events[k]??=[]).push(f);} async emit(k,e={}){for(const f of this.events[k]??[])await f(e);}
 async doCommand(){return this.emit('command');} focus(){this.focused=true;}
 get firstChild(){return this.children[0]??null;}
 get nextSibling(){return this.parentNode?.children[this.parentNode.children.indexOf(this)+1]??null;}
 subtree(){return [this,...this.children.flatMap(e=>e.subtree())];}
 react(name){if(typeof this[name]!=='function')return;this.reactions[name]=(this.reactions[name]??0)+1;try{this[name]();}catch(error){lifecycleErrors.push(String(error));console.error('MODELED_CE_REACTION_ERROR',error);}}
 appendChild(el){if(!el)return;return this.insertBefore(el,null);}
 insertBefore(el,child){assert.ok(child===null||child.parentNode===this,'insert reference belongs to parent');if(el===child)return el;el.remove();this.children.splice(child===null?this.children.length:this.children.indexOf(child),0,el);el.parentNode=el.parentElement=this;const nodes=el.subtree();for(const e of nodes)e.isConnected=this.isConnected;if(this.isConnected)for(const e of nodes)e.react('connectedCallback');return el;}
 after(el){if(this.parentNode)this.parentNode.insertBefore(el,this.nextSibling);}
 remove(){if(!this.parentNode)return;const connected=this.isConnected,nodes=this.subtree();this.parentNode.children.splice(this.parentNode.children.indexOf(this),1);this.parentNode=this.parentElement=null;this.removals++;for(const e of nodes)e.isConnected=false;if(connected)for(const e of nodes)e.react('disconnectedCallback');}
 moveBefore(el,child){
  assert.ok(this.isConnected&&el.isConnected&&el.parentNode,'modeled same connected tree move');
  assert.ok(child===null||child.parentNode===this,'move reference belongs to parent');
  const self=el===child,reference=self?el.nextSibling:child,nodes=el.subtree();
  el.parentNode.children.splice(el.parentNode.children.indexOf(el),1);
  this.children.splice(reference===null?this.children.length:this.children.indexOf(reference),0,el);el.parentNode=el.parentElement=this;
  moveEvents.push({id:el.id,self});
  for(const e of nodes){
   if(typeof e.connectedMoveCallback==='function')e.react('connectedMoveCallback');
   else {e.react('disconnectedCallback');e.react('connectedCallback');}
  }
  moveHook?.(el,self);
 }
 openPopup(){this.opened=true;} click(){this.clicked=true;} checkPinsExistence(){}
 delayConnectedCallback(){return false;} initializeAttributeInheritance(){} querySelector(s){return this.controls?.[s]??null;}
}
let Form,doc,m,iconSelect,alerts,switches,deleted,saves,uiFault=false,uiHold=null;
globalThis.assert=assert;globalThis.Element=Element;globalThis.MozXULElement=Element;globalThis.customElements={define(n,c){Form=c;}};
globalThis.Localization=class{formatValueSync(k){return k;}};
ChromeUtils.defineLazyGetter=(o,k,f)=>Object.defineProperty(o,k,{get:f});
const define=ChromeUtils.defineESModuleGetters;
const themeModule={nsZenThemePicker:new Function('return class { '+member(fs.readFileSync(process.env.ZEN_CREATE_THEME_SOURCE??repo+'/src/zen/spaces/ZenGradientGenerator.mjs','utf8'),'static getTheme(')+' };')()};
ChromeUtils.defineESModuleGetters=(o,map,...args)=>{
 for(const [name,uri] of Object.entries(map)){
  if(uri==='moz-src:///zen/library/ZenLibrary.mjs'){assert.equal(name,'ZenLibrary');o[name]={close(){}};}
  else if(uri==='resource:///modules/zen/ZenGradientGenerator.mjs'){assert.equal(name,'nsZenThemePicker');o[name]=themeModule[name];}
  else define(o,{[name]:uri},...args);
 }
};
assert.equal('nsZenThemePicker' in globalThis,false,'An ESM export is not a window global');
globalThis.gReduceMotion=true;
globalThis.gZenVerticalTabsManager={_hasSetSingleToolbar:false};
globalThis.gNavToolbox=new Element();globalThis.gURLBar={view:{close(){}},handleRevert(){},blur(){},style:{removeProperty(){}}};
globalThis.gZenEmojiPicker={open(target,options){iconSelect=options.onSelect;}};

globalThis.gZenUIManager={generateUuidv4(){return Services.uuid.generateUUID().toString();},updateTabsToolbar(){},motion:{animate(){const p=Promise.resolve();p.complete=()=>{};return p;},stagger(){}}};
// Whole product form; DOM/XPCOM/layout effects only are adapted.
new Function(fs.readFileSync(repo+'/src/zen/spaces/ZenSpaceCreation.mjs','utf8'))();
const names=['#createWorkspaceElement(','#createWorkspaceTabsSection(','#organizeTabsToWorkspaceSections(','getWorkspaceFromId(','saveWorkspace(','get canMutateWorkspaceMetadata()','getWorkspaces(','propagateWorkspaces(','async applyIndependentCatalogProjection(','async openWorkspaceCreation(','#createWorkspaceData(','async createAndSaveWorkspace('];
for(const name of ['get hasIndependentCatalogProjection()','get canRenameIndependentCatalogSpace()','renameIndependentCatalogSpace(','get canCreateIndependentCatalogSpace()','createIndependentCatalogSpace('])if(wmText.includes('  '+name))names.push(name);
function manager(w,spaces){
 const strip=doc.getElementById('tabbrowser-arrowscrollbox');for(const s of spaces){const e=doc.createXULElement('zen-workspace');e.id=s.uuid;e.appendChild(new Element());strip.appendChild(e);}
 const methods=names.map(n=>member(wmText,n)).join('\n');
 const W=new Function('nsZenThemePicker','lazy','window','document','gBrowser','return class { #hasInitialized=true; #activeWorkspace=""; #propagateWorkspaceData(){saves++;} #prepareNewWorkspace(){} #fireSpaceUIUpdate(){} privateWindowOrDisabled=false; workspaceEnabled=true; currentWindowIsSyncing=true; creatingWorkspaceId=null; activeWorkspace="'+spaces[0].uuid+'"; get canDebug(){return false;} getActiveWorkspaceFromCache(){return this._workspaceCache.find(s=>s.uuid===this.activeWorkspace);} getActiveWorkspace(){return this.getActiveWorkspaceFromCache();} workspaceElement(id){return document.getElementById("tabbrowser-arrowscrollbox").children.find(e=>e.id===id);} _organizeWorkspaceStripLocations(){} updateTabsContainers(){} updateWorkspacesChangeContextMenu(){} _fixIndicatorsNames(){} resetEssentialsPosition(){} onWindowResize(){} addChangeListeners(f){this.listener=f;} removeChangeListeners(f){if(this.listener===f)this.listener=null;} async changeWorkspace(s){switches++;if(store.hasIndependentCatalogProjection){assert.ok(store.getClonedSpaces().some(x=>x.uuid===s.uuid),"adopt before switch/new local tabs");}this.activeWorkspace=s.uuid;if(this.listener)await this.listener();} changeWorkspaceWithID(id){return this.changeWorkspace(this.getWorkspaceFromId(id));} async removeWorkspace(id){deleted++;this._workspaceCache=this._workspaceCache.filter(s=>s.uuid!==id);} '+methods+' };')(themeModule.nsZenThemePicker,{ZenSessionStore:store},w,doc,globalThis.gBrowser);
 // Bind layout-side adapter counters in the extracted class's lexical realm.
 const out=new W();out._workspaceCache=structuredClone(spaces);out.ownerWindow=w;
 out.isWorkspaceActive=s=>s.uuid===out.activeWorkspace;
 const apply=out.applyIndependentCatalogProjection.bind(out);out.applyIndependentCatalogProjection=async(...args)=>{if(uiHold)await uiHold;if(uiFault)throw new Error('controlled adoption failure');return apply(...args);};
 return out;
}
// Names used only by the layout adapters above, not replacement business logic.
Object.defineProperty(globalThis,'store',{get:()=>store});Object.defineProperty(globalThis,'saves',{get:()=>saves,set:v=>saves=v});Object.defineProperty(globalThis,'switches',{get:()=>switches,set:v=>switches=v});Object.defineProperty(globalThis,'deleted',{get:()=>deleted,set:v=>deleted=v});
async function setup(attached=true){
 const w=await reset(); alerts=[];switches=deleted=saves=0;uiFault=false;uiHold=null;moveHook=null;moveEvents.length=0;
 if(attached){const c={zenCatalogVersion:1,zenCatalogId:uuid(900),zenCatalogRevision:1,zenCatalogRequestId:uuid(901),spaces:[space(1),space(2),space(3,'B')]};state.active=true;await fsp.writeFile(authority,JSON.stringify(c));const local=raw();local.zenIndependentCatalog={version:1,zenCatalogId:c.zenCatalogId,zenCatalogRevision:1};await fsp.writeFile(sessionPath,JSON.stringify(local));store=new nsZenSessionManager();await store.readFile();store.onFileRead(structuredClone(browsingState));}
 const els=new Map();doc={documentElement:new Element(),l10n:{async formatValues(xs){return xs.map(x=>x.id);}},getElementById(id){if(!els.has(id)){const e=new Element();doc.documentElement.appendChild(e);els.set(id,e);}return els.get(id);},createXULElement(n){if(n==='zen-workspace')return new Element();assert.equal(n,'zen-workspace-creation');const f=new Form();f.controls={};for(const sel of ['form','title','label','name-wrapper','profile-wrapper','edit-theme-button','name','icon-label','profile','create-button','cancel-button','profiles-popup']){const e=new Element(),wrapper=new Element();f.appendChild(wrapper);wrapper.appendChild(e);f.controls['.zen-workspace-creation-'+sel]=e;}f.controls['.zen-workspace-creation-name'].value='';f.controls['.zen-workspace-creation-create-button'].disabled=true;
 // Match the existing markup's theme-group parent and localized button; not layout or a native frame.
 const themeButton=f.controls['.zen-workspace-creation-edit-theme-button'];f.controls['.zen-workspace-creation-form'].appendChild(themeButton);themeButton.setAttribute('data-l10n-id',Form.markup.match(/class="zen-workspace-creation-edit-theme-button"\s+data-l10n-id="([^"]+)"/)[1]);
 return f;},createElementNS(){return new Element();}};
 doc.documentElement.isConnected=true;
 globalThis.document=doc;w.docShell={treeOwner:{QueryInterface(){return this;},getInterface(){return this;},rollupAllPopups(){}}};w.createUserContextMenu=()=>{};Services.prompt={alert(_w,title,body){alerts.push(body);}};
 globalThis.gBrowser={tabContainer:{arrowScrollbox:doc.getElementById('tabbrowser-arrowscrollbox'),_invalidateCachedTabs(){}},isTab(){return false;}};
 w.gZenWorkspaces=m=manager(w,browsingState.windows[0].spaces);globalThis.gZenWorkspaces=m;globalThis.window=w;windows.splice(0,windows.length,w);Services.wm={getEnumerator(){return windows;}};m.shouldShowContainers=true;
 return {w,c:attached?JSON.parse(fs.readFileSync(authority)):null,els};
}
function currentForm(){return doc.getElementById('tabbrowser-arrowscrollbox').children.flatMap(x=>x.children).find(x=>x instanceof Form&&x.isConnected);}
async function open(){await m.openWorkspaceCreation();return currentForm();}
function clean(f,els){assert.equal(f.isConnected,false);assert.equal(m.creatingWorkspaceId,null);assert.equal(doc.documentElement.hasAttribute('zen-creating-workspace'),false);assert.equal(els.get('zen-sidebar-splitter').style.pointerEvents,'');for(const id of Form.elementsToDisable)assert.equal(els.get(id).hasAttribute('disabled'),false);assert.ok(doc.getElementById('tabbrowser-arrowscrollbox').children.flatMap(x=>x.children).every(x=>!x.hidden));}
// Color now belongs inside the theme group: use a real descendant locator, not flattened children.
function colorControl(f){return f.subtree().find(e=>e.type==='color');}
await check('C00 native sibling insertion preserves parent ordering and connectivity',async()=>{
 const parent=new Element(),button=new Element(),tail=new Element(),color=new Element();parent.isConnected=true;parent.appendChild(button);parent.appendChild(tail);button.after(color);assert.deepEqual(parent.children,[button,color,tail]);assert.equal(color.parentElement,parent);assert.equal(color.parentNode,parent);assert.equal(color.isConnected,true);parent.remove();const detached=new Element(),other=new Element();detached.after(other);assert.equal(other.parentNode,null);assert.equal(other.isConnected,false);
});
await check('C01 draft native color control is visible in the existing theme group beside Edit Theme',async()=>{
 const {els}=await setup(),f=await open();try{
 const color=colorControl(f),button=f.querySelector('.zen-workspace-creation-edit-theme-button'),group=f.querySelector('.zen-workspace-creation-form');assert.ok(color);assert.equal(color.hidden,false,'native color control must not be hidden');assert.equal(color.parentElement,group);assert.equal(color.parentNode,group);assert.equal(button.nextSibling,color);assert.equal(color.isConnected,true);for(let e=color;e;e=e.parentElement)assert.equal(e.hidden,false,'color ancestors are not hidden');assert.equal(color.hasAttribute('hidden'),false);assert.equal(color.hasAttribute('tabindex'),false);assert.equal(color.disabled??false,false);
 }finally{await f.onCancelButtonCommand();clean(f,els);}
});
await check('C02 draft native color control references the existing localized Edit Theme label',async()=>{
 const {els}=await setup(),f=await open();try{
 const color=colorControl(f),button=f.querySelector('.zen-workspace-creation-edit-theme-button'),label=color.getAttribute('aria-labelledby');assert.ok(label,'native color needs an accessible label reference');assert.equal(label,button.id);assert.equal(f.subtree().filter(e=>e.id===label).length,1);assert.equal(button.getAttribute('data-l10n-id'),'zen-workspaces-change-theme');assert.equal(color.hasAttribute('aria-label'),false,'reuse localized label, not a hardcoded translation');
 }finally{await f.onCancelButtonCommand();clean(f,els);}
});
await check('C03 native input preview stays draft-only and Cancel Escape reject late input and command',async()=>{
 for(const mode of ['cancel','escape']){
 const {els}=await setup(),f=await open(),color=colorControl(f),button=f.querySelector('.zen-workspace-creation-edit-theme-button'),group=f.querySelector('.zen-workspace-creation-form'),before=fs.readFileSync(authority),local=fs.readFileSync(sessionPath),spaces=structuredClone(m.getWorkspaces()),original=structuredClone(browsingState),n=children.length;
 color.value='#123abc';await color.emit('input');assert.deepEqual(f.workspaceDraft.theme.gradientColors,[{c:'#123abc',isCustom:true}]);assert.equal(group.style.backgroundColor,'#123abc');assert.deepEqual(m.getWorkspaces(),spaces);assert.deepEqual(browsingState,original);assert.deepEqual(fs.readFileSync(authority),before);assert.deepEqual(fs.readFileSync(sessionPath),local);assert.equal(markerWrites,0);assert.equal(children.length,n);assert.equal(saves,0);assert.equal(switches,0);
 const theme=structuredClone(f.workspaceDraft.theme);if(mode==='escape')await f.emit('keydown',{key:'Escape',preventDefault(){},stopPropagation(){}});else await f.onCancelButtonCommand();color.clicked=false;color.value='#abcdef';await color.emit('input');await button.doCommand();assert.equal(color.clicked,false);assert.deepEqual(f.workspaceDraft.theme,theme);assert.equal(group.style.backgroundColor,'#123abc');assert.deepEqual(fs.readFileSync(authority),before);assert.deepEqual(fs.readFileSync(sessionPath),local);assert.deepEqual(browsingState,original);assert.equal(markerWrites,0);assert.equal(children.length,n);assert.equal(saves,0);assert.equal(switches,0);clean(f,els);
 }
});
await check('M00 modeled move adapter normalizes self invokes descendant fallback then reconnects removed node',async()=>{
 const parent=new Element(),ancestor=new Element(),next=new Element(),form=new Element(),calls=[];parent.isConnected=true;parent.appendChild(ancestor);parent.appendChild(next);ancestor.appendChild(form);
 form.disconnectedCallback=()=>{calls.push('disconnect');form.remove();};form.connectedCallback=()=>calls.push(['connect',form.parentElement,form.isConnected]);
 parent.moveBefore(ancestor,ancestor);assert.deepEqual(parent.children,[ancestor,next]);assert.deepEqual(calls,['disconnect','disconnect',['connect',null,false]]);assert.equal(form.parentNode,null);
 const opted=new Element();opted.connectedMoveCallback=()=>calls.push('move');opted.disconnectedCallback=()=>calls.push('real-remove');ancestor.appendChild(opted);parent.moveBefore(ancestor,null);assert.deepEqual(parent.children,[next,ancestor]);assert.equal(calls.at(-1),'move');opted.remove();assert.equal(calls.at(-1),'real-remove');assert.equal(opted.parentElement,null);
});
for(const mode of ['self-position','ancestor-reorder'])await check((mode==='self-position'?'M01 ':'M02 ')+mode+' native-like publication preserves draft through COMMITTED adoption',async()=>{
 const {c,els}=await setup(),strip=doc.getElementById('tabbrowser-arrowscrollbox'),owner=m.workspaceElement(m.activeWorkspace),n=children.length,errorCount=lifecycleErrors.length;
 if(mode==='ancestor-reorder')strip.moveBefore(owner,null);
 moveEvents.length=0;
 const keys=['tabs','folders','splitViewData','groups','activeZenSpace','selected'],original=JSON.parse(fs.readFileSync(sessionPath)),beforeBrowsing=structuredClone(browsingState);
 for(const key of keys)assert.ok(Object.hasOwn(original,key),'fixture has real disk schema key '+key);
 const tabIds=original.tabs.map(t=>t.zenSyncId),folderIds=original.folders.map(f=>f.id);assert.ok(tabIds.length&&tabIds.every(Boolean));assert.ok(folderIds.length&&folderIds.every(Boolean));
 const f=await open(),id=f.workspaceId,input=f.inputName,listener=m.listener;f.inputName.value='  Move-safe Space  ';await f.inputName.emit('input');await f.onIconCommand({target:f.inputIcon});await iconSelect('🌱');f.onProfilePopupCommand({target:{getAttribute(){return '4';},label:'Container four'}});
 const color=colorControl(f);color.value='#123abc';await color.emit('input');const theme=structuredClone(f.workspaceDraft.theme),snapshots=[];
 const snapshot=()=>({sameForm:currentForm()===f,sameInput:f.inputName===input,owner:m.creatingWorkspaceId,name:f.inputName.value,icon:f.inputIcon.label,container:f.currentProfile,theme:structuredClone(f.workspaceDraft.theme),listener:m.listener===listener,removals:f.removals,switches,canSave:store.canSaveSession});
 const apply=m.applyIndependentCatalogProjection.bind(m);let adopted=null;
 m.applyIndependentCatalogProjection=async recheck=>{const disk=JSON.parse(fs.readFileSync(sessionPath));assert.equal(disk.zenIndependentCatalog.zenCatalogRevision,c.zenCatalogRevision+1,'fresh durable marker precedes native-like publication');await apply(recheck);adopted=snapshot();assert.deepEqual(m.getWorkspaces(),store.getClonedSpaces());};
 moveHook=(el,self)=>{if(el===owner)snapshots.push({self,...snapshot()});};
 const result=await f.onCreateButtonCommand();moveHook=null;const disk=JSON.parse(fs.readFileSync(authority)),local=JSON.parse(fs.readFileSync(sessionPath));
 lifecycleEvidence.push({mode,result,authorityRevision:disk.zenCatalogRevision,marker:local.zenIndependentCatalog,moves:[...moveEvents],snapshots,adopted,reactions:{...f.reactions},canSave:store.canSaveSession,alerts:[...alerts]});
 assert.equal(result.status,'COMMITTED','desired success: publication must not retire its own draft');
 assert.equal(snapshots.length,1);assert.equal(snapshots[0].self,mode==='self-position');
 for(const s of [...snapshots,adopted]){assert.ok(s.sameForm&&s.sameInput&&s.listener);assert.equal(s.owner,id);assert.equal(s.name,'  Move-safe Space  ');assert.equal(s.icon,'🌱');assert.equal(s.container,4);assert.deepEqual(s.theme,theme);assert.equal(s.removals,0);assert.equal(s.switches,0);assert.equal(s.canSave,false);}
 assert.equal(disk.zenCatalogRevision,c.zenCatalogRevision+1);assert.deepEqual(disk.spaces.slice(0,3),c.spaces);assert.equal(disk.spaces.at(-1).uuid,id);assert.equal(disk.spaces.at(-1).name,'Move-safe Space');assert.deepEqual(local.spaces,disk.spaces.filter(s=>s.geckoProfileReference.persistentDescriptor==='owned-node:A'));assert.deepEqual(strip.children.map(e=>e.id),local.spaces.map(s=>s.uuid));
 for(const key of keys){assert.ok(Object.hasOwn(local,key),'persisted schema contains '+key);assert.deepEqual(local[key],original[key],key+' retained in owned source fixture');}assert.deepEqual(local.tabs.map(t=>t.zenSyncId),tabIds);assert.deepEqual(local.folders.map(f=>f.id),folderIds);assert.deepEqual(browsingState,beforeBrowsing);
 assert.equal(children.length,n+1);assert.equal(children.at(-1).actualWait.exitCode,0);assert.equal(store.independentCatalogBusy,false);assert.equal(store.canSaveSession,true);assert.equal(store.canCreateIndependentCatalogSpace,true,'activation slot released');assert.equal(m.activeWorkspace,id);assert.equal(switches,1);assert.equal(f.removals,1);assert.equal(f.reactions.connectedCallback,1);assert.equal(f.reactions.connectedMoveCallback,1);assert.equal(f.reactions.disconnectedCallback,1);assert.equal(lifecycleErrors.length,errorCount);assert.equal(alerts.length,0);clean(f,els);
});
await check('M03 true form or ancestor removal retires draft and ignores stale callbacks',async()=>{
 for(const mode of ['form','ancestor']){
 const {els}=await setup(),before=fs.readFileSync(authority),n=children.length,f=await open();f.inputName.value='removed';await f.onIconCommand({target:f.inputIcon});const staleIcon=iconSelect,color=colorControl(f),theme=structuredClone(f.workspaceDraft.theme),icon=f.inputIcon.label;
 (mode==='form'?f:f.parentElement).remove();assert.equal(f.parentElement,null);assert.equal(f.parentNode,null);assert.equal(f.removals,1);await staleIcon('stale');color.value='#abcdef';await color.emit('input');await f.onProfilePopupCommand({target:{getAttribute(){return '9';},label:'stale'}});await f.onCreateButtonCommand();assert.equal(f.inputIcon.label,icon);assert.deepEqual(f.workspaceDraft.theme,theme);assert.equal(f.currentProfile,0);assert.deepEqual(fs.readFileSync(authority),before);assert.equal(children.length,n);assert.equal(switches,0);assert.equal(m.listener,null);assert.equal(store.canSaveSession,true);clean(f,els);
 }
});
await check('attached shared getter real existing form opens without placeholder persistence',async()=>{
 const {c}=await setup(),n=children.length,before=fs.readFileSync(authority),old=structuredClone(m.getWorkspaces());assert.equal(m.canMutateWorkspaceMetadata,false);
 const f=await open();assert.ok(f,'semantic RED: Create Space must open existing form after independent attach, not silently return');assert.ok(f.inputName.focused);assert.equal(children.length,n);assert.deepEqual(fs.readFileSync(authority),before);assert.deepEqual(m.getWorkspaces(),old);assert.equal(m.activeWorkspace,c.spaces[0].uuid);assert.equal(switches,0);assert.equal(saves,0);
});
await check('draft name icon container then one confirmed actual Task upsert fresh adoption',async()=>{
 const {c,els}=await setup(),original=structuredClone(browsingState),n=children.length;const f=await open();const color=colorControl(f);assert.ok(color);const themeButton=f.querySelector('.zen-workspace-creation-edit-theme-button');assert.equal(themeButton.hasAttribute('command'),false);await themeButton.doCommand();assert.equal(color.clicked,true);color.value='#123abc';await color.emit('input');assert.equal(f.querySelector('.zen-workspace-creation-form').style.backgroundColor,'#123abc');assert.deepEqual(m.getWorkspaces(),c.spaces.slice(0,2));await f.onIconCommand({target:f.inputIcon});await iconSelect('🌱');f.onProfilePopupCommand({target:{getAttribute(){return '4';},label:'Container four'}});f.inputName.value='  My new Space  ';await f.inputName.emit('input');assert.equal(f.createButton.disabled,false);
 const before=fs.readFileSync(authority);assert.equal(await m.openWorkspaceCreation(),false);assert.deepEqual(fs.readFileSync(authority),before);assert.equal(switches,0);
 const p=f.onCreateButtonCommand();const duplicate=f.onCreateButtonCommand();await duplicate;const result=await p;
 assert.equal(result?.status,'COMMITTED');const disk=JSON.parse(fs.readFileSync(authority));assert.equal(disk.spaces.length,4);assert.deepEqual(disk.spaces.slice(0,3),c.spaces);const added=disk.spaces[3];assert.equal(added.name,'My new Space');assert.equal(added.icon,'🌱');assert.equal(added.containerTabId,4);assert.deepEqual(added.theme.gradientColors,[{c:'#123abc',isCustom:true}]);assert.deepEqual(added.geckoProfileReference,c.spaces[0].geckoProfileReference);assert.equal(children.length,n+1);assert.equal(children.at(-1).actualWait.exitCode,0);assert.equal(m.activeWorkspace,added.uuid);assert.equal(switches,1);assert.deepEqual(browsingState,original);assert.deepEqual(JSON.parse(fs.readFileSync(sessionPath)).tabs,original.windows[0].tabs);assert.equal(store.canSaveSession,true);assert.equal(store.canMutateWorkspaceMetadata,false);clean(f,els);
});
await check('Enter routes through the actual input handler to one confirmed create command',async()=>{
 const {els}=await setup(),n=children.length;const f=await open();f.inputName.value='Created with Enter';await f.inputName.emit('input');
 const command=f.createButton.doCommand.bind(f.createButton);let submission;
 f.createButton.doCommand=()=>submission=command();
 await f.inputName.emit('keydown',{key:'Enter',preventDefault(){},stopPropagation(){}});assert.ok(submission);await submission;
 const disk=JSON.parse(fs.readFileSync(authority));assert.equal(disk.spaces.at(-1).name,'Created with Enter');assert.equal(children.length,n+1);assert.equal(m.activeWorkspace,disk.spaces.at(-1).uuid);clean(f,els);
});
await check('Cancel Escape and capability loss always exit without catalog insert delete or switch',async()=>{
 for(const mode of ['cancel','escape','loss']){const {els}=await setup(),before=fs.readFileSync(authority),n=children.length,old=m.activeWorkspace;const f=await open();if(mode==='loss')window.gBrowserInit.delayedStartupFinished=false;if(mode==='escape')await f.emit('keydown',{key:'Escape',preventDefault(){},stopPropagation(){}});else await f.onCancelButtonCommand();clean(f,els);assert.equal(m.activeWorkspace,old);assert.equal(switches,0);assert.equal(deleted,0);assert.equal(children.length,n);assert.deepEqual(fs.readFileSync(authority),before);}
});
await check('no permission before Save closes reports refusal no commit',async()=>{
 const {els}=await setup(),before=fs.readFileSync(authority),n=children.length;const f=await open();f.inputName.value='refused';window.gBrowserInit.delayedStartupFinished=false;await f.onCreateButtonCommand();clean(f,els);assert.equal(children.length,n);assert.deepEqual(fs.readFileSync(authority),before);assert.equal(alerts.length,1);
});
await check('COMMITTED local failure and UNKNOWN retain disk block retry without resend',async()=>{
 for(const mode of ['local','lost','adoption']){const {els}=await setup(),old=m.activeWorkspace;const f=await open();f.inputName.value=mode;if(mode==='local')markerFault=true;if(mode==='lost')state.fault='lost';if(mode==='adoption')uiFault=true;await f.onCreateButtonCommand();clean(f,els);const disk=JSON.parse(fs.readFileSync(authority));assert.equal(disk.spaces.at(-1).name,mode);assert.equal(store.canSaveSession,false);assert.equal(m.activeWorkspace,old);assert.equal(switches,0);assert.equal(alerts.length,1);const n=children.length;assert.equal(await m.openWorkspaceCreation(),false);assert.equal(children.length,n);}
});
await check('legacy normal create retains placeholder/save/switch and cancel path',async()=>{
 const {els}=await setup(false),n=children.length;const f=await open();assert.ok(f);assert.equal(m.getWorkspaces().length,3);assert.equal(switches,1);f.inputName.value='legacy';await f.onCreateButtonCommand();assert.equal(m.getWorkspaceFromId(m.activeWorkspace).name,'legacy');assert.equal(children.length,n);clean(f,els);
});

await check('real read held: busy excludes duplicate create and legacy saver until adoption',async()=>{
 const {els}=await setup(),n=children.length;const f=await open();f.inputName.value='held';let release,entered;const atRead=new Promise(r=>entered=r),hold=new Promise(r=>release=r);let once=false;
 readHook=async p=>{if(p===authority&&!once){once=true;entered();await hold;}};
 const saving=f.onCreateButtonCommand();await atRead;assert.equal(store.independentCatalogBusy,true);assert.equal(store.canSaveSession,false);assert.equal(await m.openWorkspaceCreation(),false);assert.equal((await m.createIndependentCatalogSpace({...f.workspaceDraft,name:'competing'},()=>true)).status,'REFUSED');assert.equal(children.length,n);assert.equal(switches,0);release();await saving;readHook=null;assert.equal(children.length,n+1);clean(f,els);
});
await check('cancel or disconnect while fresh Reader is pending has no authority effect',async()=>{
 for(const mode of ['cancel','disconnect','replace-manager']){const {els}=await setup(),old=m,bytes=fs.readFileSync(authority),n=children.length;const f=await open();f.inputName.value='cancel-held';let release,entered;const atRead=new Promise(r=>entered=r),hold=new Promise(r=>release=r);let once=false;
 readHook=async p=>{if(p===authority&&!once){once=true;entered();await hold;}};const saving=f.onCreateButtonCommand();await atRead;if(mode==='cancel')await f.onCancelButtonCommand();else if(mode==='disconnect')f.remove();else {const replacement=Object.create(old);window.gZenWorkspaces=replacement;globalThis.gZenWorkspaces=replacement;await f.onCancelButtonCommand();}release();assert.equal((await saving).status,'REFUSED');readHook=null;assert.equal(children.length,n);assert.deepEqual(fs.readFileSync(authority),bytes);assert.equal(switches,0);assert.equal(deleted,0);assert.equal(store.canSaveSession,true);assert.equal(old.listener,null);clean(f,els);}
});
await check('cancel during committed local persistence retains new authority blocked no switch',async()=>{
 const {els}=await setup(),n=children.length;const f=await open();f.inputName.value='committed-cancel';let release,entered;const atWrite=new Promise(r=>entered=r),hold=new Promise(r=>release=r);markerHook=async()=>{entered();await hold;};const saving=f.onCreateButtonCommand();await atWrite;assert.equal(children.length,n+1);assert.equal(JSON.parse(fs.readFileSync(authority)).spaces.length,4);await f.onCancelButtonCommand();release();assert.equal((await saving).status,'PARTIAL');assert.equal(switches,0);assert.equal(deleted,0);assert.equal(store.canSaveSession,false);clean(f,els);
});
await check('schema collision and foreign-owner drafts refuse before Task and recover controls',async()=>{
 for(const mode of ['collision','foreign','schema','owner-read']){const {els}=await setup(),bytes=fs.readFileSync(authority),n=children.length;const f=await open();f.inputName.value='invalid';if(mode==='collision'){f.workspaceDraft.uuid=uuid(1);f.setAttribute('workspace-id',uuid(1));m.creatingWorkspaceId=uuid(1);}if(mode==='foreign')f.workspaceDraft.geckoProfileReference.persistentDescriptor='owned-node:B';if(mode==='schema')f.workspaceDraft.theme={type:'not-a-theme'};if(mode==='owner-read')state.getterFault=true;const result=await f.onCreateButtonCommand();state.getterFault=false;assert.equal(result.status,'REFUSED');assert.equal(children.length,n);assert.deepEqual(fs.readFileSync(authority),bytes);assert.equal(switches,0);assert.equal(alerts.length,1);assert.equal(store.canSaveSession,true);clean(f,els);}
});
await check('actual Task peer-revision refusal keeps original local active and no insert',async()=>{
 const {c,els}=await setup(),n=children.length;const f=await open();f.inputName.value='stale';const call=state.subprocess.call;state.subprocess.call=async options=>{c.zenCatalogRevision++;c.zenCatalogRequestId=uuid(850);await fsp.writeFile(authority,JSON.stringify(c));return call(options);};
 try {assert.equal((await f.onCreateButtonCommand()).status,'REFUSED');assert.equal(children.length,n+1);assert.equal(children.at(-1).actualWait.exitCode,11);assert.deepEqual(JSON.parse(fs.readFileSync(authority)),c);assert.equal(switches,0);assert.equal(store.canSaveSession,true);clean(f,els);} finally {state.subprocess.call=call;}
});
await check('legacy cancel switches back and removes only legacy placeholder',async()=>{
 const {els}=await setup(false),old=m.activeWorkspace,n=children.length;const f=await open();const id=f.workspaceId;await f.onCancelButtonCommand();assert.equal(m.activeWorkspace,old);assert.equal(m.getWorkspaceFromId(id),undefined);assert.equal(deleted,1);assert.equal(children.length,n);clean(f,els);
});

for(const child of children){await child.persist();assert.equal(child.actualWait.signal,null);assert.ok(child.stdinClosed);assert.ok(child.eof.stdout&&child.eof.stderr);}
await fsp.writeFile(root+'/create-result.json',JSON.stringify({gate:'SOURCE_FORM_SESSION_CLIENT_ACTUAL_NODE_TASK_OWNED_IO_MODELED_NATIVE_MOVES_NOT_GECKO_OR_INSTALLED_UI',cases,failures,lifecycleEvidence,lifecycleErrors,children:children.map(({waited,persist,...c})=>c)},null,2));
console.log('RESULT '+cases.length+' passed; '+failures.length+' failed');
process.exitCode=failures.length?1:0;
