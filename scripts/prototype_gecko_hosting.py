#!/usr/bin/env python3
"""Local real-Gecko IOSurface hosting gate. No synthetic producer or screenshot transport.

First copy scripts/prototype_gecko_layer_{sender,protocol}.h into engine/gfx/layers/
and scripts/prototype_gecko_{native_input,layer_protocol}.h into engine/widget/cocoa/,
apply scripts/prototype_gecko_layer_hook.patch inside engine/, and rebuild Gecko:
  python3 scripts/prototype_gecko_hosting.py --profiles 1
  python3 scripts/prototype_gecko_hosting.py --profiles 2
Input uses AppKit NSEvents and authenticated native-widget IPC, not WebDriver input actions.
Visible ASCII QA requires installed tesseract; captured pixels are not transport.
OS Chinese IME, key-equivalent routing and hover remain separate gates.
"""
import argparse
import contextlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import queue
import secrets
import shutil
import subprocess
import tempfile
import threading
import time

import prototype_profile_hosting as probe

# Observe with Marionette, but never let it supply the input being tested.
_FORBIDDEN_INPUT = {'WebDriver:PerformActions', 'WebDriver:ReleaseActions', 'WebDriver:ElementSendKeys',
                    'WebDriver:ElementClick', 'WebDriver:ElementClear', 'WebDriver:SendAlertText'}
_observer_request = probe.request

def native_observer_request(client, name, params=None):
    assert name not in _FORBIDDEN_INPUT, f'WebDriver input forbidden in native gate: {name}'
    assert name != 'WebDriver:NewWindow', 'openTab can implicitly activate an inactive worker; use profile tab helpers'
    if name == 'WebDriver:SwitchToWindow':
        assert params.get('focus') is False, 'Observer must not request OS focus'
    return _observer_request(client, name, params)

probe.request = native_observer_request


class Page(probe.Page):
    def do_GET(self):
        body = b'''<!doctype html><meta charset="utf-8"><title>REAL Gecko hosting probe</title>
<style>body{margin:0;background:#223355;color:white;font:18px sans-serif}#bar{position:absolute;top:15px;left:0;width:80px;height:30px;background:#ffb900;pointer-events:none}button{position:absolute;left:140px;top:120px;width:280px;height:100px;font:24px sans-serif}pre{position:absolute;top:270px;left:10px;width:500px;white-space:pre-wrap;font:12px monospace}</style>
<body data-probe-frames="0" data-probe-clicks="0" data-probe-trusted="false"><div id="bar"></div><button id="tap">REAL DOM: 0 clicks</button><input id="edit" style="position:absolute;left:140px;top:230px;width:280px;height:36px;font:24px monospace"><pre id="state">waiting</pre>
<script>window.probeFrames=0;window.probeClicks=0;window.probeTrusted=null;
function animate(){window.probeFrames++;document.body.dataset.probeFrames=String(window.probeFrames);document.querySelector('#bar').style.transform='translateX('+(window.probeFrames%300)+'px)';requestAnimationFrame(animate)}requestAnimationFrame(animate);
document.addEventListener('click',event=>{document.body.dataset.probeLastClickTrusted=String(event.isTrusted);document.body.dataset.probeClickEvents=String(Number(document.body.dataset.probeClickEvents||0)+1);document.body.dataset.probeLastClickTarget=event.target.id});
for(const name of ['compositionstart','compositionupdate','compositionend'])document.addEventListener(name,event=>{document.body.dataset[name]=String(Number(document.body.dataset[name]||0)+1);document.body.dataset[name+'Trusted']=String(event.isTrusted)});
const edit=document.querySelector('#edit');edit.addEventListener('keydown',event=>{document.body.dataset.probeKeyTrusted=String(event.isTrusted)});edit.addEventListener('input',event=>{document.body.dataset.probeInputTrusted=String(event.isTrusted)});
document.querySelector('#tap').addEventListener('click',event=>{window.probeClicks++;window.probeTrusted=event.isTrusted;document.body.dataset.probeClicks=String(window.probeClicks);document.body.dataset.probeTrusted=String(event.isTrusted);event.currentTarget.textContent='REAL DOM: '+window.probeClicks+' clicks';document.body.style.background=window.probeClicks%2?'#196e33':'#223355'});</script>'''
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Host:
    def __init__(self, binary, service, token, work):
        self.queue = queue.Queue()
        self.work = work
        self.log = (work / 'host-stderr.log').open('w')
        self.process = subprocess.Popen([str(binary), '--service', service, '--token', str(token)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True, bufsize=1,
            env={**os.environ, 'ZEN_GECKO_LAYER_ARTIFACTS': str(work)})
        assert self.process.stdin is not None and self.process.stdout is not None
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        try:
            self.window = self.wait('ready')['window_number']
        except BaseException:
            self.close()
            raise

    def read(self):
        assert self.process.stdout is not None
        with (self.work / 'host-events.jsonl').open('w') as log:
            for line in self.process.stdout:
                log.write(line)
                log.flush()
                try:
                    self.queue.put(json.loads(line))
                except ValueError:
                    self.queue.put({'event': 'error', 'message': 'Invalid host JSONL'})
        self.queue.put({'event': 'error', 'message': 'Host stdout closed'})

    def send(self, op, **fields):
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps({'op': op, **fields}) + '\n')
        self.process.stdin.flush()

    def wait(self, event, predicate=lambda value: True, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            broker = getattr(self, 'space_broker', None)
            if broker:
                broker.poll()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                value = self.queue.get(timeout=min(0.05, remaining) if broker else remaining)
            except queue.Empty:
                if broker:
                    continue
                break
            if time.monotonic() >= deadline:
                break
            if broker:
                broker.received(value)
            if value.get('event') == 'error':
                if value.get('kind') == 'frame_rejected' and value.get('reason') == 'pid_or_slot':
                    continue  # Worker can paint before Marionette returns its PID for registration.
                raise RuntimeError(value)
            if value.get('event') == event and predicate(value):
                if time.monotonic() >= deadline:
                    break
                return value
        raise TimeoutError(f'No host {event}; see {self.work / "host-events.jsonl"}')

    def status(self):
        self.send('status')
        status = self.wait('status', lambda value: 'action' not in value)
        assert status['window_number'] == self.window, status
        assert status['host_visible_windows'] == 1, status
        assert status['source_visible_windows'] == [], status
        return status

    def close(self):
        try:
            if self.process.poll() is None:
                self.send('quit')
                self.process.wait(timeout=5)
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait()
            self.reader.join(timeout=2)
            self.log.close()


def viewport_rect(client):
    return probe.script(client, '''
const r = Services.wm.getMostRecentWindow('navigator:browser').gBrowser.selectedBrowser.getBoundingClientRect();
return {x:r.x,y:r.y,width:r.width,height:r.height};''', chrome=True)


def glyphs_match(data, expected, work):
    if expected.isascii():
        recognized = subprocess.run(['tesseract', 'stdin', 'stdout', '--psm', '7'], input=data,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=5)
        return recognized.stdout.decode().strip() == expected
    # QA only: system Vision supports Chinese; installed Tesseract has English data only.
    qa = work / 'glyph-qa'
    binary = qa / 'native-host'
    if not binary.exists():
        qa.mkdir(exist_ok=True)
        source = qa / 'native-text-ocr.m'
        source.write_text(r'''#import <Cocoa/Cocoa.h>
#import <Vision/Vision.h>
int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc != 2) return 2;
    NSData *image = [NSFileHandle.fileHandleWithStandardInput readDataToEndOfFile];
    VNRecognizeTextRequest *request = [VNRecognizeTextRequest new];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.recognitionLanguages = @[@"zh-Hant", @"en-US"];
    request.usesLanguageCorrection = NO;
    request.usesCPUOnly = YES; // QA avoids measured 27s GPU initialization; CPU probe was under 0.5s.
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithData:image options:@{}];
    NSError *error = nil;
    if (![handler performRequests:@[request] error:&error]) return 3;
    VNRecognizedTextObservation *line = request.results.firstObject;
    NSString *actual = [line topCandidates:1].firstObject.string;
    // Never print recognized/user text. Only compare the known fixture.
    puts([actual isEqual:[NSString stringWithUTF8String:argv[1]]] ? "MATCH" : "NO_MATCH");
    return 0;
  }
}
''')
        probe.compile_native_host(qa, source)
    checked = subprocess.run([str(binary), expected], input=data, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=True, timeout=5)
    return checked.stdout.strip() == b'MATCH'


def snapshot(host, work, name, client, profile, clicks, expected_input=None):
    from PIL import Image, ImageCms
    import io

    viewport = viewport_rect(client)
    edit = probe.script(client, """
const e=document.querySelector('#edit'),r=e.getBoundingClientRect(),s=getComputedStyle(e);
const c=document.createElement('canvas').getContext('2d');c.font=s.font;
return {x:r.x+parseFloat(s.borderLeftWidth)+parseFloat(s.paddingLeft), y:r.y+4,
  width:c.measureText(arguments[0]).width, height:r.height-8};
""", [expected_input]) if expected_input is not None else None
    slot = {'A': 0, 'B': 1}[profile]
    color = {'A': (255, 185, 0), 'B': (0, 215, 255)}[profile]
    expected_body = (25, 110, 51) if clicks % 2 else (34, 51, 85)
    # Fence actual display state, not just receipt: CA/WindowServer presentation can lag a commit.
    for attempt in range(3):
        status = host.status()
        if attempt:
            baseline = status['slots'][slot]['frame_counter']
            host.wait('frame', lambda value: value.get('slot') == slot and value.get('frame_counter', 0) > baseline)
        suffix = f'-retry-{attempt}' if attempt else ''
        path = work / f'{name}{suffix}.png'
        host.send('snapshot', path=str(path))
        captured = host.wait('snapshot', lambda value: value.get('path') == str(path))
        assert captured['window_number'] == host.window and captured['own_process_only'] is True and path.is_file(), captured
        # QA reads only the displayed host PNG; pixels are never sent back as browser content.
        with Image.open(path) as source:
            image = source.convert('RGB')
            if source.info.get('icc_profile'):
                # Compare CSS sRGB, not device-profile encoded channel values.
                image = ImageCms.profileToProfile(image, ImageCms.ImageCmsProfile(io.BytesIO(source.info['icc_profile'])), ImageCms.createProfile('sRGB'), outputMode='RGB')
        assert image is not None
        top = image.height - status['height'] + viewport['y']
        # The native chrome's startup white fade changes luminance; A/B color ranges stay disjoint.
        bar = []
        for x in range(int(viewport['x']), int(viewport['x'] + viewport['width'])):
            pixel = image.getpixel((x, int(top + 30)))
            assert isinstance(pixel, tuple)
            if all(abs(actual - expected) <= 100 for actual, expected in zip(pixel, color)):
                bar.append(x)
        body = image.getpixel((int(viewport['x'] + viewport['width'] - 20), int(top + viewport['height'] - 20)))
        assert isinstance(body, tuple)
        # An sRGB -> display ICC -> sRGB 8-bit round trip can differ by one LSB.
        input_pixels_match = True
        input_bounds = None
        if edit is not None:
            # Installed OCR is QA only. Crop before the caret; never log recognized/user text.
            input_bounds = (int(viewport['x']+edit['x']), int(top+edit['y']),
                int(viewport['x']+edit['x']+edit['width'])-1, int(top+edit['y']+edit['height']))
            crop = image.crop(input_bounds)
            data = io.BytesIO(); crop.resize((crop.width*3,crop.height*3)).save(data, format='PNG')
            input_pixels_match = glyphs_match(data.getvalue(), expected_input, work)
        if len(bar) >= 70 and all(abs(a - b) <= 2 for a, b in zip(body, expected_body)) and input_pixels_match:
            return {'capture': 'HOST_PIXEL_GATES_PASS', 'path': str(path), 'profile': profile, 'bar_x': bar[0], 'body_rgb': body, 'colorspace': 'sRGB', 'body_tolerance_lsb': 2, 'input_glyphs_verified': edit is not None, 'input_bounds': input_bounds}
    raise AssertionError(('host profile/position/DOM pixels', name, profile, str(work)))


def stats(client):
    return probe.script(client, 'return {frames: Number(document.body.dataset.probeFrames), clicks: Number(document.body.dataset.probeClicks), clickEvents: Number(document.body.dataset.probeClickEvents||0), trusted: document.body.dataset.probeTrusted === "true", width: innerWidth, height: innerHeight};')


def click(host, client, slot, selector="#tap"):
    assert host.status()["slots"][slot]["native_input"], "Native receiver handshake missing"
    offset = viewport_rect(client)
    point = probe.script(client, '''const r=document.querySelector(arguments[0]).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};''', [selector])
    previous = stats(client)
    before = previous['clicks']
    host.send('click', x=offset['x'] + point['x'], y=offset['y'] + point['y'])
    event = host.wait('click', lambda value: value.get('slot') == slot)
    assert event['window_number'] == host.window, event
    x, y = round(event['x'] - offset['x']), round(event['y'] - offset['y'])
    assert abs(x - point['x']) <= 1 and abs(y - point['y']) <= 1, (event, point, offset)
    native = host.wait('native_input', lambda value: value.get('slot') == slot and value.get('kind') == 2)
    assert native['status'] == 0, native
    assert native['pid'] == host.status()['slots'][slot]['allowed_pid'], native
    after = probe.script(client, '''
const [before,selector,eventsBefore,done] = arguments;const end = Date.now()+3000;
function poll(){const clicks=Number(document.body.dataset.probeClicks);const focused=document.activeElement.matches(selector);
const trusted=document.body.dataset.probeLastClickTrusted==='true';const fresh=Number(document.body.dataset.probeClickEvents)>eventsBefore && document.body.dataset.probeLastClickTarget===selector.slice(1);
if(((selector==='#tap'?clicks>before:focused) && trusted && fresh) || Date.now()>end){done({clicks,focused,trusted,fresh});return;}
setTimeout(poll,20);}poll();''', [before, selector, previous['clickEvents']], asynchronous=True)
    assert after['clicks'] == before + (selector == '#tap') and after['trusted'] is True and after['fresh'] is True, after
    if selector != '#tap':
        assert after['focused'], after
    return {'host_event': event, 'dom': after}


def type_key(host, client, slot, text, key_code, expected):
    owning = host.status()
    assert owning['active_slot'] == slot and owning['host_key_window'] and owning['host_app_active'], owning
    host.send('key', text=text, key_code=key_code)
    native = host.wait('native_input', lambda value: value.get('slot') == slot and value.get('kind') == 11)
    assert native['status'] == 0, native
    state = probe.script(client, """
const [expected,done]=arguments;const end=Date.now()+3000;
function poll(){const e=document.querySelector('#edit');const matches=e.value===expected;
if(matches || Date.now()>end){done({matches,focus:document.activeElement===e,documentFocus:document.hasFocus(),
keyTrusted:document.body.dataset.probeKeyTrusted==='true',inputTrusted:document.body.dataset.probeInputTrusted==='true'});return;}
setTimeout(poll,20);}poll();""", [expected], asynchronous=True)
    assert all(state.values()), state
    actual = host.status()
    assert actual['host_key_window'] and actual['host_app_active'] and native['pid'] == actual['slots'][slot]['allowed_pid'], actual
    return state


def exercise_os_ime(host, a, b, work, binary, result):
    # No direct mark/insert controls in this gate: only physical-key fixtures through AppKit/OS IME.
    result['os_chinese_ime'] = 'FAIL'
    host.send('text', action='source')
    before = host.wait('input_source')
    assert before['selected'] == before['system_selected'] == 'com.apple.keylayout.US' and before['client_owner'], before
    try:
        host.send('text', action='enable', enabled=True)
        assert host.wait('text_client')['enabled']
        host.send('text', action='source', source_id='com.apple.inputmethod.TCIM.Zhuyin')
        selected = host.wait('input_source')
        assert selected['selected'] == selected['system_selected'] == 'com.apple.inputmethod.TCIM.Zhuyin' and selected['client_owner'], selected
        # Carbon Events.h physical positions: ANSI 5/J/Slash, Space, Return.
        for code in (0x17,0x26,0x2c,0x31,0x24):
            host.send('key', text='', key_code=code, quartz=True)
            host.wait('text_key', lambda v: v.get('key_code') == code)
            host.wait('text_key_up', lambda v: v.get('key_code') == code)
        observed = probe.script(a,"""
const done=arguments[arguments.length-1],end=Date.now()+3000;
function poll(){const d=document.body.dataset;if(document.querySelector('#edit').value==='ac中' || Date.now()>end){done({matches:document.querySelector('#edit').value==='ac中',start:Number(d.compositionstart)>0,update:Number(d.compositionupdate)>0,end:Number(d.compositionend)>0,trusted:d.compositionstartTrusted==='true'&&d.compositionupdateTrusted==='true'&&d.compositionendTrusted==='true'});return;}setTimeout(poll,20);}poll();
""", asynchronous=True)
        assert all(observed.values()), observed
        host.send('text', action='source')
        after = host.wait('input_source')
        assert after['marked_callbacks']>before['marked_callbacks'] and after['insert_callbacks']>before['insert_callbacks'], after
        assert after['rect_callbacks']>before['rect_callbacks'] and after['last_rect_on_host'], after
        assert probe.script(b,"return document.querySelector('#edit').value==='b' && !document.hasFocus();")
        result['snapshots']['os_ime_commit'] = snapshot(host, work, 'host-os-ime-commit', a, 'A', 2, expected_input='ac中')
        result['os_chinese_ime'] = {'scope':'OS_APPLE_ZHUYIN_MARK_COMMIT_PIXELS_NOT_CANDIDATE_UI','dom':observed,'before':before,'after':after}
    finally:
        # Independent utility mode restores even if the host main loop/client has failed.
        restored = subprocess.run([str(binary),'--restore-us'],capture_output=True,text=True,timeout=10)
        result['input_source_restore'] = json.loads(restored.stdout)
        assert restored.returncode == 0 and result['input_source_restore']['selected']=='com.apple.keylayout.US', result['input_source_restore']
        host.send('text', action='enable', enabled=False)
        assert not host.wait('text_client')['enabled']


def prepare_spaces(client, shared, own):
    info = probe.script(client, """
const [shared,own,done]=arguments;
(async()=>{try{
 const w=Services.wm.getMostRecentWindow('navigator:browser'),m=w.gZenWorkspaces;
 await m.promiseInitialized;
 const old=m.getWorkspaces();
 let spaces=shared;
 if(!spaces){
  const a={...old[0],name:'Space A',icon:'A',containerTabId:0,geckoProfileKey:'A'};m.saveWorkspace(a);
  const b=await m.createAndSaveWorkspace('Space B','B',true);b.geckoProfileKey='B';m.saveWorkspace(b);
  spaces=[a,b];
 }else{
  for(const s of spaces)m.saveWorkspace({...s});
  for(const s of old)if(!spaces.some(x=>x.uuid===s.uuid))await m.removeWorkspace(s.uuid);
 }
 const end=Date.now()+3000;
 while(spaces.some(s=>!m.workspaceElement(s.uuid))&&Date.now()<end)await new Promise(r=>w.setTimeout(r,20));
 await m.changeWorkspaceWithID(spaces[own].uuid);
 w.__spaceCommands=[];
 w.addEventListener('command',e=>{
  const b=e.target.closest?.('zen-workspace-icons toolbarbutton[zen-workspace-id]');
  if(b)w.__spaceCommands.push({id:b.getAttribute('zen-workspace-id'),trusted:e.isTrusted});
 },true);
 done({spaces:m.getWorkspaces(),active:m.activeWorkspace,pid:Services.appinfo.processID,profile:Services.dirsvc.get('ProfD',Ci.nsIFile).path});
}catch(e){done({error:String(e)});}})();
""", args=(shared,own),chrome=True,asynchronous=True)
    assert 'error' not in info and len(info['spaces'])==2, info
    assert info['active']==info['spaces'][own]['uuid'], info
    return info


class SpaceProfileBroker:
    # ponytail: one in-flight transition in this single-window prototype; no multi-window broker.
    def __init__(self, host, clients, setup):
        self.host,self.clients,self.setup=host,clients,setup
        self.active=0
        self.pending=None
        self.routes=[]
        self.ids=[s['uuid'] for s in setup[0]['spaces']]
        assert len(set(self.ids))==2 and len({s['profile'] for s in setup})==2
        for slot,client in enumerate(clients):
            info=probe.script(client,"""
const w=Services.wm.getMostRecentWindow('navigator:browser'),m=w.gZenWorkspaces;
const own=arguments[0],s={original:m.changeWorkspace,queue:[],resolvers:new Map(),seq:0};
w.__profileSpaceRoute=s;
m.changeWorkspace=function(space,...args){
 if(space?.uuid===own)return s.original.call(this,space,...args);
 const command=w.__spaceCommands.pop();
 if(!space || !command?.trusted || command.id!==space.uuid || s.resolvers.size>=64)throw new Error('Untrusted/overflow Space route');
 const seq=++s.seq;
 s.queue.push({id:space.uuid,seq,trusted:command.trusted,from:m.activeWorkspace,profile:Services.dirsvc.get('ProfD',Ci.nsIFile).path});
 return new Promise(resolve=>s.resolvers.set(seq,()=>resolve(space)));
};
return {active:m.activeWorkspace,spaces:m.getWorkspaces().map(x=>({id:x.uuid,profile:x.geckoProfileKey})),icons:[...w.document.querySelectorAll('zen-workspace-icons toolbarbutton[zen-workspace-id]')].map(b=>b.getAttribute('zen-workspace-id'))};
""",args=(self.ids[slot],),chrome=True)
            assert info['active']==self.ids[slot] and info['icons']==self.ids,info
            assert [v['profile'] for v in info['spaces']]==['A','B'],info
        host.space_broker=self

    def poll(self):
        if self.pending:
            return
        source=self.active
        req=probe.script(self.clients[source],"return Services.wm.getMostRecentWindow('navigator:browser').__profileSpaceRoute.queue.shift()||null;",chrome=True)
        if not req:
            return
        assert req['trusted'] and req['from']==self.ids[source] and req['profile']==self.setup[source]['profile'],req
        target=self.ids.index(req['id'])
        assert target!=source,req
        self.pending={'source':source,'target':target,'request':req}
        self.host.send('select',slot=target)

    def received(self,event):
        if not self.pending or event.get('event')!='status' or event.get('action')!='select':
            return
        item=self.pending
        assert event['active_slot']==item['target'],event
        probe.script(self.clients[item['source']],"const s=Services.wm.getMostRecentWindow('navigator:browser').__profileSpaceRoute,r=s.resolvers.get(arguments[0]);if(!r)throw new Error('Unknown Space ack');s.resolvers.delete(arguments[0]);r();return true;",args=(item['request']['seq'],),chrome=True)
        self.active=item['target']
        self.routes.append({**item,'native_ack':True,'window_number':event['window_number']})
        self.pending=None

    def close(self):
        self.host.space_broker=None
        for client in self.clients:
            probe.script(client,"const w=Services.wm.getMostRecentWindow('navigator:browser');w.gZenWorkspaces.changeWorkspace=w.__profileSpaceRoute.original;delete w.__profileSpaceRoute;return true;",chrome=True)


def exercise_spaces(host, clients, setup, work, result):
    result['spaces_profiles']='FAIL'
    broker=SpaceProfileBroker(host,clients,setup)
    bindings=[{'space_id':broker.ids[i],'name':s['spaces'][i]['name'],'profile_key':chr(65+i),'profile_path':s['profile'],'pid':s['pid']} for i,s in enumerate(setup)]
    (work/'space-profile-bindings.json').write_text(json.dumps(bindings,indent=2))
    observed=[]
    try:
        blocked=probe.script(clients[0],"const done=arguments[arguments.length-1],w=Services.wm.getMostRecentWindow('navigator:browser');w.gZenWorkspaces.changeWorkspaceWithID(arguments[0]).then(()=>done(false),()=>done(true));",args=(broker.ids[1],),chrome=True,asynchronous=True)
        assert blocked and broker.active==0 and not broker.pending
        result['snapshots']['spaces_A_before']=snapshot(host,work,'host-space-A-before',clients[0],'A',2,expected_input='ac')
        for target,key,code,expected,token in [(1,'d',2,'bd',0),(0,'e',14,'ace',2)]:
            source=broker.active
            rect=probe.script(clients[source], """
const w=Services.wm.getMostRecentWindow('navigator:browser');
const b=w.document.querySelector('zen-workspace-icons toolbarbutton[zen-workspace-id="'+arguments[0]+'"]');
const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height};
""",args=(broker.ids[target],),chrome=True)
            assert rect['width']>0 and rect['height']>0,rect
            host.send('click',x=rect['x'],y=rect['y'])
            host.wait('status',lambda v:v.get('action')=='select' and v.get('active_slot')==target,timeout=5)
            host.wait('native_input',lambda v:v.get('slot')==target and v.get('kind')==100)
            click(host,clients[target],target,'#edit')
            type_key(host,clients[target],target,key,code,expected)
            actual=probe.script(clients[target],"const w=Services.wm.getMostRecentWindow('navigator:browser');return{space:w.gZenWorkspaces.activeWorkspace,profile:Services.dirsvc.get('ProfD',Ci.nsIFile).path,pid:Services.appinfo.processID,tab_space:w.gBrowser.selectedTab.getAttribute('zen-workspace-id'),profile_key:w.gZenWorkspaces.getActiveWorkspace().geckoProfileKey,icon:w.document.querySelector('zen-workspace-icons toolbarbutton[active]').getAttribute('zen-workspace-id')};",chrome=True)
            assert actual['space']==actual['icon']==actual['tab_space']==broker.ids[target] and actual['profile_key']==chr(65+target) and actual['profile']==setup[target]['profile'] and actual['pid']==setup[target]['pid'],actual
            inactive=probe.script(clients[source],"return {value:document.querySelector('#edit').value,inactive:!document.hasFocus()};")
            assert inactive=={'value':'ac' if source==0 else 'bd','inactive':True},inactive
            observed.append({'active':actual,'inactive':inactive})
            result['snapshots']['spaces_'+chr(65+target)]=snapshot(host,work,'host-space-'+chr(65+target),clients[target],chr(65+target),token,expected_input=expected)
        states=[probe.script(c,"return JSON.parse(document.querySelector('#state').textContent);") for c in clients]
        assert states[0]['cookie']!=states[1]['cookie'] and states[0]['nonce']!=states[1]['nonce']
        assert states[0]['extensionId']==states[1]['extensionId']==probe.ADDON_ID
        assert [v['sentinel'] for v in states]==['A','B']
        assert len(broker.routes)==2 and all(v['native_ack'] and v['request']['trusted'] and v['window_number']==host.window for v in broker.routes)
        result['spaces_profiles']={'scope':'REAL_ZEN_SPACE_UI_TO_TWO_GECKO_PROFILES_LOCAL_BROKER','bindings':bindings,'routes':broker.routes,'same_extension_distinct_runtime_cookie_storage':True,'native_A_B_A':True,'direct_script_route_blocked':blocked,'observed':observed,'states':states}
    finally:
        broker.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profiles', type=int, choices=(1, 2), default=1)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--text-client', action='store_true', help='Native composition API bridge gate; NOT real OS IME')
    mode.add_argument('--os-ime', action='store_true', help='Requires explicit permission: temporarily select Apple Zhuyin, restore US')
    mode.add_argument('--spaces', action='store_true', help='Real Zen Space A/B UI bound to distinct Gecko profiles')
    args = parser.parse_args()
    if (args.os_ime or args.spaces) and args.profiles != 2:
        parser.error("--os-ime/--spaces requires --profiles 2")
    work = Path(tempfile.mkdtemp(prefix='zen-gecko-hosting-', dir=probe.SCRATCH))
    print(f'REAL GECKO HOSTING artifacts: {work}', flush=True)
    result: dict = {'real_gecko_hosting': 'FAIL', 'cross_profile_move': 'NOT_RUN', 'input_bridge': 'AppKit NSEvent -> authenticated Mach IPC -> Gecko NSWindow/ChildView', 'native_keyboard': 'NOT_RUN', 'os_chinese_ime': 'NOT_RUN', 'worker_native_widgets': 'offscreen backing widgets requested; OS onscreen list asserted at gates'}
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    spec = importlib.util.spec_from_file_location('upstream_marionette_transport', probe.TRANSPORT)
    assert spec is not None and spec.loader is not None
    transport = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transport)
    try:
        binary = probe.compile_native_host(work, probe.ROOT / 'scripts/prototype_gecko_layer_host.m')
        service = f'local.zen-gecko-layer.{secrets.token_hex(8)}'
        token = secrets.randbits(63) or 1
        archive = work / 'probe.xpi'
        probe.make_addon(archive)
        with contextlib.ExitStack() as stack:
            host = Host(binary, service, token, work)
            stack.callback(host.close)
            clients, initial = [], []
            space_setup = []
            url = f'http://127.0.0.1:{server.server_port}/probe'
            for slot in range(args.profiles):
                client, caps = stack.enter_context(probe.backend(chr(65 + slot), work, transport, headless=False,
                    env_extra={'ZEN_GECKO_LAYER_SERVICE': service, 'ZEN_GECKO_LAYER_TOKEN': str(token), 'ZEN_GECKO_LAYER_SLOT': str(slot), 'MOZ_APP_NO_DOCK': '1', 'ZEN_GECKO_LAYER_HOST_PID': str(host.process.pid)}))
                clients.append(client)
                result.setdefault('marionette_focus_testmode_before', []).append(probe.script(client, "return Services.prefs.getBoolPref('focusmanager.testmode', false);", chrome=True))
                # Native focus must be real widget activation, not Marionette's focus-test bypass.
                probe.script(client, "Services.prefs.setBoolPref('focusmanager.testmode', false); return true;", chrome=True)
                host.send('allow', slot=slot, pid=caps['moz:processID'])
                probe.request(client, 'WebDriver:SetWindowRect', {'width': 800, 'height': 600})
                if args.spaces:
                    space_setup.append(prepare_spaces(client, space_setup[0]['spaces'] if space_setup else None, slot))
                    assert space_setup[-1]['pid']==caps['moz:processID'] and Path(space_setup[-1]['profile']).resolve()==Path(caps['moz:profile']).resolve()
                    probe.select_profile_tab(client, probe.new_profile_tab(client))
                probe.install(client, archive)
                probe.page_probe(client, url, chr(65 + slot))
                initial.append(probe.page_probe(client, url))
            host.send('select', slot=0)
            frame = host.wait('frame', lambda value: value.get('slot') == 0 and value.get('surface_count', 0) > 0)
            before = stats(clients[0])
            host_before = host.status()
            host.send('activate')
            deadline = time.monotonic() + 5
            while True:
                focused = host.status()
                if focused['host_key_window'] and focused['host_app_active']:
                    break
                if time.monotonic() >= deadline:
                    result['initial_host_focus_unavailable'] = True
                    break  # Diagnostic only; type_key still hard-requires real host key/active state.
                time.sleep(0.05)
            animation_start = snapshot(host, work, 'host-animation-start', clients[0], 'A', 0)
            time.sleep(1)
            after = stats(clients[0])
            host_after = host.status()
            assert after['frames'] > before['frames'] + 5, (before, after)
            assert host_after['slots'][0]['frame_counter'] > host_before['slots'][0]['frame_counter'] + 5, (host_before, host_after)
            result['first_frame'] = frame
            result['animation'] = {'before': before, 'after': after, 'host_before': host_before['slots'][0], 'host_after': host_after['slots'][0]}
            result['snapshots'] = {'animation_start': animation_start, 'before_click': snapshot(host, work, 'host-before-click', clients[0], 'A', 0)}
            assert abs(result['snapshots']['before_click']['bar_x'] - animation_start['bar_x']) > 5, result['snapshots']
            result['first_click'] = click(host, clients[0], 0)
            result['status_before_resize'] = host.status()
            host.wait('frame', lambda value: value.get('slot') == 0 and value.get('frame_counter', 0) > result['status_before_resize']['slots'][0]['frame_counter'])
            result['snapshots']['after_click'] = snapshot(host, work, 'host-after-click', clients[0], 'A', 1)
            before_resize = stats(clients[0])
            resize_baseline = host.status()['slots'][0]['frame_counter']
            host.send('resize', width=900, height=650)
            resize = host.wait('resize', lambda value: value.get('width') == 900)
            assert resize['window_number'] == host.window, resize
            probe.request(clients[0], 'WebDriver:SetWindowRect', {'width': 900, 'height': 650})
            host.wait('frame', lambda value: value.get('slot') == 0 and value.get('surface_count', 0) > 0 and value.get('frame_counter', 0) > resize_baseline)
            after_resize = stats(clients[0])
            assert after_resize['width'] > before_resize['width'] and after_resize['height'] > before_resize['height'], (before_resize, after_resize)
            result['click_after_resize'] = click(host, clients[0], 0)
            result['status_after_resize'] = host.status()
            result['snapshots']['after_resize'] = snapshot(host, work, 'host-after-resize', clients[0], 'A', 2)
            click(host, clients[0], 0, '#edit')
            result['keyboard_A'] = type_key(host, clients[0], 0, 'a', 0, 'a')
            result['snapshots']['keyboard_first_A'] = snapshot(host, work, 'host-keyboard-first-A', clients[0], 'A', 2, expected_input='a')
            result['native_keyboard'] = 'ASCII_PASS'
            result['real_gecko_hosting'] = 'PASS'
            if args.profiles == 2:
                result['cross_profile_move'] = 'FAIL'
                a, b = clients
                probe.request(b, 'WebDriver:SetWindowRect', {'width': 900, 'height': 650})
                host.send('select', slot=1)
                host.wait('status', lambda value: value.get('action') == 'select' and value.get('active_slot') == 1)
                baseline = host.status()['slots'][1]['frame_counter']
                host.wait('frame', lambda value: value.get('slot') == 1 and value.get('frame_counter', 0) > baseline)
                result['snapshots']['native_B_ready'] = snapshot(host, work, 'host-native-B-ready', b, 'B', 0)
                click(host, b, 1, '#edit')
                result['keyboard_B'] = type_key(host, b, 1, 'b', 11, 'b')
                inactive_a = probe.script(a, "return {unchanged:document.querySelector('#edit').value==='a', inactive:!document.hasFocus()};")
                assert all(inactive_a.values()), inactive_a
                result['snapshots']['keyboard_B'] = snapshot(host, work, 'host-keyboard-B', b, 'B', 0, expected_input='b')
                host.send('select', slot=0)
                host.wait('status', lambda value: value.get('action') == 'select' and value.get('active_slot') == 0)
                host.wait('native_input', lambda value: value.get('slot') == 0 and value.get('kind') == 100)
                result['keyboard_back_A'] = type_key(host, a, 0, 'c', 8, 'ac')
                assert probe.script(b, "return document.querySelector('#edit').value==='b' && !document.hasFocus();")
                result['native_profile_focus'] = 'A_B_A_PASS'
                result['snapshots']['keyboard_A'] = snapshot(host, work, 'host-keyboard-back-A', a, 'A', 2, expected_input='ac')
                if args.spaces:
                    exercise_spaces(host, clients, space_setup, work, result)
                if args.os_ime:
                    exercise_os_ime(host, a, b, work, binary, result)
                if args.text_client:
                    result['composition_api_bridge'] = 'FAIL'
                    host.send('text', action='query')
                    geometry = host.wait('text_state')
                    assert geometry['selected_start'] == 2 and geometry['caret'][3] > 0, geometry
                    assert geometry['caret_on_host'] and all(abs(x-y)<0.1 for x,y in zip(geometry['caret'],geometry['client_rect_roundtrip'])), geometry
                    edit_geometry = probe.script(a,"""
const e=document.querySelector('#edit'),r=e.getBoundingClientRect(),s=getComputedStyle(e),c=document.createElement('canvas').getContext('2d');c.font=s.font;
return {x:r.x+parseFloat(s.borderLeftWidth)+parseFloat(s.paddingLeft)+c.measureText('ac').width,top:r.top,bottom:r.bottom};
""")
                    viewport = viewport_rect(a)
                    assert abs(geometry['caret'][0]-viewport['x']-edit_geometry['x'])<=2, geometry
                    assert viewport['y']+edit_geometry['top']<=geometry['caret'][1] and geometry['caret'][1]+geometry['caret'][3]<=viewport['y']+edit_geometry['bottom'], geometry
                    host.send('text', action='mark', text='ㄓ')
                    host.wait('native_input', lambda v: v.get('kind') == 102 and v.get('status') == 0)
                    marked = probe.script(a, """
const done=arguments[arguments.length-1],end=Date.now()+3000;
function poll(){const d=document.body.dataset;if(document.querySelector('#edit').value==='acㄓ' || Date.now()>end){done({matches:document.querySelector('#edit').value==='acㄓ',start:Number(d.compositionstart)>0,update:Number(d.compositionupdate)>0,trusted:d.compositionstartTrusted==='true'&&d.compositionupdateTrusted==='true'});return;}setTimeout(poll,20);}poll();
""", asynchronous=True)
                    assert all(marked.values()), marked
                    host.send('text', action='query')
                    preedit = host.wait('text_state')
                    assert preedit['marked_length'] == 1, preedit
                    host.send('text', action='insert', text='中')
                    host.wait('native_input', lambda v: v.get('kind') == 103 and v.get('status') == 0)
                    committed = probe.script(a, """
const done=arguments[arguments.length-1],end=Date.now()+3000;
function poll(){const d=document.body.dataset;if(document.querySelector('#edit').value==='ac中' || Date.now()>end){done({matches:document.querySelector('#edit').value==='ac中',end:Number(d.compositionend)>0,trusted:d.compositionendTrusted==='true'});return;}setTimeout(poll,20);}poll();
""", asynchronous=True)
                    assert all(committed.values()), committed
                    assert probe.script(b,"return document.querySelector('#edit').value==='b' && !document.hasFocus();")
                    result['composition_api_bridge'] = {'scope':'NATIVE_API_BRIDGE_NOT_OS_IME','marked':marked,'committed':committed,'caret':geometry['caret']}
                    result['snapshots']['composition_commit'] = snapshot(host, work, 'host-composition-api-commit', a, 'A', 2, expected_input='ac中')
                    host.send('text', action='mark', text='ㄨ')
                    host.wait('native_input', lambda v: v.get('kind') == 102 and v.get('status') == 0)
                    host.send('text', action='unmark')
                    host.wait('native_input', lambda v: v.get('kind') == 104 and v.get('status') == 0)
                    ended = probe.script(a, """
const done=arguments[arguments.length-1],end=Date.now()+3000;
function poll(){const d=document.body.dataset;if(Number(d.compositionend)>=2 || Date.now()>end){done({matches:document.querySelector('#edit').value==='ac中ㄨ',ended:Number(d.compositionend)>=2,trusted:d.compositionendTrusted==='true'});return;}setTimeout(poll,20);}poll();
""", asynchronous=True)
                    assert all(ended.values()), ended
                    host.send('text', action='query')
                    assert not host.wait('text_state')['marked']
                    # Switching profiles must resolve A's pending marked text before B receives focus/input.
                    host.send('text', action='mark', text='ㄥ')
                    host.wait('native_input', lambda v: v.get('kind') == 102 and v.get('status') == 0)
                    host.send('select', slot=1)
                    host.wait('native_input', lambda v: v.get('slot') == 1 and v.get('kind') == 100 and v.get('status') == 0)
                    switched = probe.script(a, """
const done=arguments[arguments.length-1],end=Date.now()+3000;
function poll(){const d=document.body.dataset;if(Number(d.compositionend)>=3 || Date.now()>end){done({matches:document.querySelector('#edit').value==='ac中ㄨㄥ',ended:Number(d.compositionend)>=3,trusted:d.compositionendTrusted==='true',blurred:!document.hasFocus()});return;}setTimeout(poll,20);}poll();
""", asynchronous=True)
                    assert all(switched.values()), switched
                    assert probe.script(b,"return document.querySelector('#edit').value==='b' && document.hasFocus();")
                    host.send('select', slot=0)
                    host.wait('native_input', lambda v: v.get('slot') == 0 and v.get('kind') == 100 and v.get('status') == 0)
                    host.send('text', action='query')
                    assert not host.wait('text_state')['marked']
                    result['composition_api_bridge'].update({'unmark':ended,'switch_while_marked':switched,'client_caret':geometry})

                # GET-only reload: real single host selection follows the destination backend.
                probe.request(a, 'Marionette:SetContext', {'value': 'content'})
                source_a = probe.request(a, 'WebDriver:GetWindowHandle', {})['value']
                control_a = probe.new_profile_tab(a)
                probe.select_profile_tab(a, control_a)
                probe.page_probe(a, url)
                probe.select_profile_tab(a, source_a)
                moved = probe.reopen_profile_page(a, b)
                assert moved['url'] == url and moved['probe']['cookie'] == 'profile_probe=B' and moved['probe']['sentinel'] == 'B' and moved['probe']['nonce'] == initial[1]['nonce'], moved
                assert moved['source_handle'] not in probe.request(a, 'WebDriver:GetWindowHandles', {})
                probe.request(b, 'WebDriver:SetWindowRect', {'width': 900, 'height': 650})
                host.send('select', slot=1)
                selected_b = host.wait('status', lambda value: value.get('action') == 'select' and value.get('active_slot') == 1)
                host.wait('frame', lambda value: value.get('slot') == 1 and value.get('surface_count', 0) > 0 and value.get('frame_counter', 0) > selected_b['slots'][1]['frame_counter'])
                result['click_in_B'] = click(host, b, 1)
                result['status_B'] = host.status()
                assert result['status_B']['active_slot'] == 1
                host.wait('frame', lambda value: value.get('slot') == 1 and value.get('frame_counter', 0) > result['status_B']['slots'][1]['frame_counter'])
                result['snapshots']['B'] = snapshot(host, work, 'host-in-B', b, 'B', 1)
                background_a = probe.page_probe(a, url)
                assert background_a['nonce'] == initial[0]['nonce'] and background_a['heartbeat'] > initial[0]['heartbeat'] and background_a['sentinel'] == 'A' and background_a['cookie'] == 'profile_probe=A' and background_a['senderUrl'] == url, background_a
                result['background_A_while_host_B'] = background_a
                returned = probe.reopen_profile_page(b, a)
                assert returned['url'] == url and returned['probe']['cookie'] == 'profile_probe=A' and returned['probe']['sentinel'] == 'A' and returned['probe']['nonce'] == initial[0]['nonce'], returned
                assert returned['source_handle'] not in probe.request(b, 'WebDriver:GetWindowHandles', {})
                assert initial[0]['nonce'] != initial[1]['nonce']
                host.send('select', slot=0)
                selected_a = host.wait('status', lambda value: value.get('action') == 'select' and value.get('active_slot') == 0)
                host.wait('frame', lambda value: value.get('slot') == 0 and value.get('surface_count', 0) > 0 and value.get('frame_counter', 0) > selected_a['slots'][0]['frame_counter'])
                result['click_back_in_A'] = click(host, a, 0)
                result['status_back_A'] = host.status()
                assert result['status_back_A']['active_slot'] == 0
                host.wait('frame', lambda value: value.get('slot') == 0 and value.get('frame_counter', 0) > result['status_back_A']['slots'][0]['frame_counter'])
                result['snapshots']['back_A'] = snapshot(host, work, 'host-back-A', a, 'A', 1)
                result['cross_profile_move'] = 'PASS'
                result['moves'] = {'A_to_B': moved, 'B_to_A': returned}
    except Exception as error:
        result['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        server.shutdown()
        server.server_close()
        for name in ('A', 'B'):
            shutil.rmtree(work / name, ignore_errors=True)
        result['disposable_profiles_removed'] = all(not (work / name).exists() for name in ('A', 'B'))
        (work / 'result.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2), flush=True)


if __name__ == '__main__':
    main()
