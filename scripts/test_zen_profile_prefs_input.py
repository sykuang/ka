#!/usr/bin/env python3
"""SOURCE_CONTRACT only: no Gecko/parser/native execution or grammar emulator.

An explicit frozen/owned --root is required. Default execution constructs no
compiler/native/process commands. Checks source bodies and refusal ordering,
not parser outcomes, filesystem atomicity, startup, or effective preferences.
"""
import os
BOOTSTRAP_KEYS = sorted(os.environ)
_ALLOWED = ('HOME', 'PATH', 'TMPDIR', 'PYTHONDONTWRITEBYTECODE')
_ENV = {k: os.environ[k] for k in _ALLOWED}
os.environ.clear()
os.environ.update(_ENV)
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat

PATHS = [
    'src/zen/toolkit/common/cocoa/ZenProfileHost.mm',
    'src/zen/toolkit/common/ZenProfileHostNative.h',
    'src/zen/toolkit/common/ZenCommonUtils.cpp',
    'src/zen/toolkit/common/nsIZenCommonUtils.idl',
    'scripts/test_zen_profile_host_control.py',
]

SECURITY_PATHS = ['src/zen/toolkit/common/ZenProfileHostProtocol.h']


def read_regular(path):
    for component in reversed([path, *path.parents]):
        mode = os.lstat(component).st_mode
        assert stat.S_ISREG(mode) if component == path else stat.S_ISDIR(mode)
    return path.read_bytes()


def body(text, signature):
    start = text.index(signature)
    opening = text.index('{', start + len(signature))
    depth = 0
    for token in re.finditer(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\n]*|/\*[\s\S]*?\*/|[{}]', text[opening:]):
        if token.group() == '{':
            depth += 1
        elif token.group() == '}':
            depth -= 1
            if not depth:
                return text[start:opening + token.end()]
    raise AssertionError('unclosed source body: ' + signature)


def checks(sources):
    mm, header, bridge, idl, old = [sources[p].decode() for p in PATHS]
    prepare = body(mm, 'nsresult PrepareStartupWorker(')
    host = mm.split('@implementation ZenProfileHost\n', 1)[1].split('@end', 1)[0]
    current = body(host, '- (BOOL)workerCurrent')
    bind = body(mm, 'nsresult BindWorker(')
    yield 'real-prepare-qualification-gate', 'CapturePrefsInput(' in prepare and 'ParsePrefsInput(' in prepare
    if 'CapturePrefsInput(' not in mm:
        return
    capture = body(mm, 'static nsresult CapturePrefsInput(')
    read = body(mm, 'static nsresult ReadPrefsRaw(')
    parse = body(mm, 'static nsresult ParsePrefsInput(')
    cap = body(mm, 'static bool PrefsAggregateLimit(')
    collector = mm.split('class PrefsCollector final', 1)[1].split('NS_IMPL_ISUPPORTS(PrefsCollector', 1)[0]
    yield 'required-text-cap-entire-bridge', all('const nsACString& prefsAggregateLimit' in t for t in (prepare, header)) and 'in ACString prefsAggregateLimit' in idl and bridge.count('aPrefsAggregateLimit') == 2
    decimal = body(mm, 'static bool Decimal(')
    yield 'canonical-zero-no-implicit-limit', 'text.EqualsLiteral("0")' in cap and 'Decimal(text, value)' in cap and 'PrefsAggregateLimit(prefsAggregateLimit, &limit)' in prepare and all(x in decimal for x in ('text.IsEmpty()', 'text.Length() > 20', "text.First() == '0'", "c < '0' || c > '9'", 'std::numeric_limits<uint64_t>::max()'))
    yield 'missing-malformed-cap-before-io', prepare.index('PrefsAggregateLimit(') < prepare.index('CloneStartupDirectory(') and 'in ACString prefsAggregateLimit' in idl and '[optional] in ACString prefsAggregateLimit' not in idl
    yield 'aggregate-not-per-file', 'length > limit - total' in read and 'total += length' in read and 'uint64_t total = 0' in capture and capture.index('"prefs.js"') < capture.index('"user.js"') and 'kStartupBytes' not in capture + read
    yield 'zero-present-empty-permitted', 'if (length &&' in read and 'out.present = true' in read and 'if (!file.present) continue' in parse and 'records.IsEmpty' not in parse
    yield 'representability-clone-nul-refusal', 'INT32_MAX' in read and 'sizeof(nsTArrayHeader)' in read and 'sizeof(PrefsRecord)' in collector and 'NS_ERROR_FILE_TOO_BIG' in read
    yield 'descriptor-regular-nonblocking', all(x in read for x in ('openat(', 'O_NOFOLLOW', 'O_NONBLOCK', 'fstat(', 'S_ISREG', 'before.st_dev', 'before.st_ino'))
    yield 'complete-read-eof-and-recheck', all(x in read for x in ('used < length', 'count == 0', 'read(fd, &extra, 1)', 'SamePrefsStat(before, after)', 'close(fd)'))
    yield 'root-directory-path-identity', all(x in capture for x in ('root->GetNativePath', 'O_DIRECTORY', 'O_NOFOLLOW', 'expected.device', 'expected.inode', 'lstat(path.get(), &live)', 'S_ISDIR(live.st_mode)', 'memcmp(path.get(), expected.bytes, expected.length)'))
    yield 'existing-parser-native-private', 'nsIPrefService* service' in parse and 'service->ParsePrefsFromBuffer(file.raw, collector, file.name)' in parse and 'public nsIPrefObserver' in collector
    yield 'irreversible-failure-and-original-error', 'if (NS_SUCCEEDED(error.result)) error.result = rv' in collector and 'OnError(' in collector and 'error.parserSeen = true' in collector and 'error.parser.Assign(message, mozilla::fallible)' in collector
    yield 'typed-ordered-duplicate-byte-copies', all(x in collector for x in ('OnStringPref(', 'OnIntPref(', 'OnBoolPref(', 'strcmp(kind, "User")', 'sticky || locked', 'record.name.Assign(name, mozilla::fallible)', 'record.string.Assign(value, mozilla::fallible)', 'records.AppendElement(std::move(record), mozilla::fallible)'))
    yield 'callbacks-no-external-effects', not any(x in collector for x in ('do_GetService(', 'NotifyControl(', 'ParsePrefsFromBuffer(', 'Observe(', 'SetPref', 'NS_ProcessNextEvent'))
    yield 'normal-return-latch-whole-batch', parse.index('ParsePrefsFromBuffer(') < parse.index('collector->error.result') < parse.index('out.records = std::move(collector->records)')
    yield 'owned-main-thread-reentry-refusal', 'host->prefsPreparing' in prepare and 'nsAutoRetainCocoaObject hold(host)' in prepare and prepare.index('host->prefsPreparing = true') < prepare.index('do_GetService(') and 'NS_IsMainThread()' in body(mm, 'static nsresult Resolve(')
    yield 'qualification-before-publication', prepare.index('CapturePrefsInput(') < prepare.index('ParsePrefsInput(') < prepare.index('host->prefsInput = std::move(input)') < prepare.index('host->startupPrepared = true')
    yield 'original-owned-immutable-preimage', 'std::unique_ptr<const PrefsInputSnapshot> prefsInput' in mm and 'SamePrefsInput(*host->prefsInput, fresh)' in bind and 'prefsInput = ' not in bind
    yield 'actual-pre-bind-consumes-snapshot', all(x in bind for x in ('host->startupPrepared && !host->worker.pid', 'CapturePrefsInput(host->expectedDirectory, host->worker.profile,', 'host->prefsInput->limit, fresh, host->prefsFailure)')) and bind.index('[host workerCurrent]') < bind.index('CapturePrefsInput(') < bind.index('SamePrefsInput(') < bind.index('host->worker.Bind(')
    yield 'pre-bind-owned-reentry-and-lifetime', bind.index('nsAutoRetainCocoaObject hold(host)') < bind.index('CapturePrefsInput(') and bind.index('host->prefsPreparing = true') < bind.index('CapturePrefsInput(') and 'objc_getAssociatedObject(window, &sProfileHostKey) != host' in bind and bind.count('[host workerCurrent]') == 2
    recurring = ''.join(body(host, signature) for signature in ('- (BOOL)workerCurrent', '- (void)tick', '- (void)bootstrap', '- (void)sendQuit'))
    yield 'no-periodic-or-quit-raw-io-or-reparse', not any(x in recurring for x in ('CapturePrefsInput(', 'ReadPrefsRaw(', 'ParsePrefsInput(', 'prefsInput', 'ParsePrefsFromBuffer('))
    yield 'digest-presence-length-identity-and-bytes', all(x in body(mm, 'static bool SamePrefsInput(') for x in ('present', 'raw.Length()', 'sha256', 'device', 'inode', 'memcmp('))
    yield 'services-outside-callbacks-error-after-parse', prepare.index('do_GetService(') < prepare.index('ParsePrefsInput(') < prepare.index('host->prefsFailure = std::move(failure)') < prepare.index('NotifyControl(')
    yield 'legacy-three-calls-explicit-cap', old.count('true,"","0",&parentListener)') == 3 and 'PrefsInputSnapshot' in old and 'CapturePrefsInput(' in old

    yield from cleanup_bind_checks(mm, sources[SECURITY_PATHS[0]].decode())
    yield from startup_metadata_checks(sources)


def cleanup_bind_checks(mm, protocol):
    # SOURCE_CONTRACT: inspect the actual raw gate, never execute/model C++.
    def code(text):
        return re.sub(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\n]*|/\*[\s\S]*?\*/', ' ', text)

    bind = code(body(mm, 'nsresult BindWorker('))
    gates = []
    for match in re.finditer(r'\bif\s*\(([^{};]*)\)\s*\{', bind):
        block = body(bind, match.group().rsplit('{', 1)[0].rstrip())
        if 'CapturePrefsInput(' in block and 'SamePrefsInput(' in block:
            gates.append((match.group(1), block))
    condition, gate = gates[0] if len(gates) == 1 else ('', '')
    terms = [re.sub(r'\s+', '', term) for term in condition.split('&&')]
    normal = {'host->startupPrepared', '!host->worker.pid'}
    allowed = normal | {'!cleanupOnly', '!host->worker.cleanupOnly'}
    conjunction = len(gates) == 1 and len(terms) == len(set(terms)) and normal <= set(terms) <= allowed
    yield 'normal-first-bind-raw-gate-conjunction', conjunction
    yield 'direct-cleanup-excluded-from-actual-raw-gate', conjunction and '!cleanupOnly' in terms
    yield 'latched-cleanup-excluded-from-actual-raw-gate', conjunction and '!host->worker.cleanupOnly' in terms
    yield 'normal-raw-refusal-still-before-pid-adoption', conjunction and bind.index('[host workerCurrent]') < bind.index(gate) < bind.index('host->worker.Bind(') and all(x in gate for x in ('if (NS_FAILED(rv)) return rv;', 'if (!SamePrefsInput(*host->prefsInput, fresh))', 'return PrefsRefuse(host->prefsFailure, NS_ERROR_FILE_CORRUPTED);'))
    worker = code(body(protocol, 'struct WorkerBinding'))
    adoption = body(worker, 'bool Bind(')
    yield 'cleanup-binding-monotonic-once-only-register-refusal', all(x in adoption for x in ('!prepared || pid || child <= 1 || child > INT32_MAX', 'pid = child; cleanupOnly |= cleanup; return true;')) and 'cleanupOnly = true;' in body(worker, 'void Tighten(') and 'if (cleanupOnly || !owner' in body(worker, 'bool Register(') and 'host->worker.Tighten();' in code(body(mm, 'nsresult CleanupWorker(')) and 'ownedPID == uint32_t(getpid()) || !host->worker.Bind(ownedPID, cleanupOnly)' in bind
    host = code(mm.split('@implementation ZenProfileHost\n', 1)[1].split('@end', 1)[0])
    control = code(mm.split('@implementation ZenProfileControl\n', 1)[1].split('@end', 1)[0])
    receive = body(host, '- (void)receive')
    getter = code(body(mm, 'nsresult GetAuthenticatedStartupBinding('))
    start = code(body(mm, 'nsresult StartSource('))
    connect = code(body(mm, 'nsresult ConnectSource('))
    yield 'cleanup-no-snapshot-frame-source-or-new-attachment', getter.index('if (sStartupControl->cleanupOnly) return NS_ERROR_NOT_AVAILABLE;') < getter.index('out = sStartupControl->startupExpectation;') and receive.index('worker.cleanupOnly || ![self workerCurrent]') < receive.index('Consume(') and start.index('control->cleanupOnly ||') < start.index('root->StartStagingObservation(') and connect.index('GetAuthenticatedStartupBinding(expectation)') < connect.index('control->attached = true;') and '!host->worker.cleanupOnly &&' in code(body(mm, 'nsresult Admit('))
    handle = body(control, '- (void)handle:')
    retire = body(control, '- (void)retire')
    yield 'preattach-terminal-attached-normal-quit-owner-preserved', 'if (p.cleanupOnly) {\n      cleanupOnly = true;\n      if (!attached) { [self retire]; return; }' in handle and '(!startup || attached)' in retire and 'if (ControlLayout<QuitRecord>' in handle and 'NotifyControl(callback,' in handle and 'callbackActive = true;' in handle and 'quit.Complete(p.request, QuitStatus::NotAvailable)' in handle
    hello = body(host, '- (void)control:')
    yield 'cleanup-hello-audit-and-control-identity-preserved', all(x in hello for x in ('!worker.pid || audit != worker.pid || p.pid != worker.pid', '!ChildOfCurrentProcess(worker.pid)', '!ControlEndpointAlive(p.control.name)', 'worker.owner != p.owner || worker.control != p.control.name', '!candidate.Register(p.identity, audit, p.profile, p.owner, token)'))



def startup_metadata_checks(sources):
    # SOURCE_CONTRACT only: these are text/order checks, not C++ execution.
    protocol = sources[SECURITY_PATHS[0]].decode()
    mm = sources[PATHS[0]].decode()
    prepare = body(mm, 'nsresult PrepareStartupWorker(')
    yield 'startup-metadata-required-fixed-record', all(x in protocol for x in (
        'struct StartupPrefsFile', 'uint32_t present = 0;',
        'uint64_t length = 0, device = 0, inode = 0;', 'uint8_t sha256[32]{};',
        'uint32_t prefsSupplied = 0;', 'uint64_t prefsAggregateLimit = 0;',
        'StartupPrefsFile prefsFiles[2];'))
    if 'struct StartupPrefsFile' not in protocol:
        return
    valid = body(protocol, 'inline bool ValidStartupExpectation(')
    same = body(protocol, 'inline bool SameStartupExpectation(')
    yield 'startup-metadata-explicit-cap-no-default', 'e.prefsSupplied != 1' in valid and 'uint64_t total = 0' in valid and 'file.length > e.prefsAggregateLimit - total' in valid and 'total > e.prefsAggregateLimit' in valid and 'total += file.length' in valid
    yield 'startup-metadata-canonical-absent-present-empty', all(x in valid for x in ('file.present > 1', '!file.present', 'file.length || file.device || file.inode', 'for (uint8_t byte : file.sha256)', 'if (byte) return false;', '!file.inode', 'file.length > uint64_t(INT32_MAX)')) and 'if (!file.length)' not in valid
    yield 'startup-metadata-every-duplicate-field', all(x in same for x in ('ValidStartupExpectation(a)', 'ValidStartupExpectation(b)', 'a.prefsSupplied != b.prefsSupplied', 'a.prefsAggregateLimit != b.prefsAggregateLimit', 'a.prefsFiles[i]', 'b.prefsFiles[i]', 'x.present != y.present', 'x.length != y.length', 'x.device != y.device', 'x.inode != y.inode', 'memcmp(x.sha256, y.sha256, sizeof(x.sha256))')) and 'memcmp(&a' not in same
    fill = prepare[prepare.index('expectation.prefsSupplied = 1'):prepare.index('if (NS_FAILED(rv)) {')]
    yield 'startup-metadata-same-qualified-snapshot', all(x in fill for x in ('input->limit', 'input->files[i]', 'expectation.prefsFiles[i]', 'file.present', 'file.raw.Length()', 'file.device', 'file.inode', 'file.sha256.Length() != sizeof(metadata.sha256)', 'memcpy(metadata.sha256, file.sha256.BeginReading(), sizeof(metadata.sha256))', 'if (file.present)')) and 'CapturePrefsInput' not in fill
    yield 'startup-metadata-prepare-validates-after-fill-before-publish', prepare.index('ValidStartupSelection(expectation)') < prepare.index('CapturePrefsInput(') < prepare.index('ParsePrefsInput(') < prepare.index('expectation.prefsSupplied = 1') < prepare.index('ValidStartupExpectation(expectation)') < prepare.index('host->prefsInput = std::move(input)') < prepare.index('host->startupPrepared = true')
    host = mm.split('@implementation ZenProfileHost\n', 1)[1].split('@end', 1)[0]
    control = mm.split('@implementation ZenProfileControl\n', 1)[1].split('@end', 1)[0]
    handle = body(control, '- (void)handle:')
    yield 'startup-metadata-existing-wire-child-getter-consumer', 'p.expectation = startupExpectation;' in body(host, '- (void)bootstrap') and handle.index('!ValidStartupExpectation(p.expectation)') < handle.index('!SameStartupExpectation(startupExpectation, p.expectation)') < handle.index('if (!bootstrapped)') < handle.index('startupExpectation = p.expectation') and 'out = sStartupControl->startupExpectation;' in body(mm, 'nsresult GetAuthenticatedStartupBinding(') and 'GetAuthenticatedStartupBinding(expectation)' in body(mm, 'nsresult ConnectSource(')
    yield 'startup-metadata-new-startup-abi-old-control-size-preserved', 'kStartupVersion = 3, kStartupBytes = 4096' in protocol and 'kControlVersion = 1, kProfilePathBytes = 4096' in protocol and 'h->msgh_size != sizeof(Record)' in body(protocol, 'inline bool StartupLayout(') and 'p.version == kStartupVersion' in body(protocol, 'inline bool StartupLayout(')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    sources = {p: read_regular(args.root / p) for p in PATHS + SECURITY_PATHS}
    events = [{'id': name, 'pass': bool(ok)} for name, ok in checks(sources)]
    result = {'classification': 'SOURCE_CONTRACT', 'nativeParserExecuted': False,
              'bootstrapKeyNames': BOOTSTRAP_KEYS, 'activeKeyNames': sorted(os.environ),
              'inputs': {p: hashlib.sha256(raw).hexdigest() for p, raw in sources.items()},
              'events': events, 'pass': all(e['pass'] for e in events)}
    print(json.dumps(result, indent=2))
    return 0 if result['pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
