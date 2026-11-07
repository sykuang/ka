#!/usr/bin/env python3
"""Bounded standalone actual IOUtils bodies; NOT Gecko/generated bindings/LZ4.

Platform stream, allocator, UTF8 and codec are explicitly inert boundaries.
The allocator records requested sizes and refuses >4096, never allocating a
hostile header size. Each compile/run is bounded to 120 seconds. Source-contract
checks connect the three actual public dispatch bodies to these semantic tests.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def definition(source, signature):
    start = source.index(signature)
    opening = source.index('{', start)
    # These owners have no braces inside literals other than balanced diagnostics.
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


PRELUDE = r'''
#include <algorithm>
#include <array>
#include <cassert>
#include <cinttypes>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>
using nsresult = int;
constexpr int NS_OK=0, NS_ERROR_ILLEGAL_INPUT=1, NS_ERROR_FILE_ACCESS_DENIED=2,
 NS_ERROR_FILE_TOO_BIG=3, NS_ERROR_FILE_CORRUPTED=4, NS_ERROR_OUT_OF_MEMORY=5,
 NS_ERROR_UNEXPECTED=6, NS_ERROR_FILE_NOT_FOUND=7, NS_ERROR_FILE_UNKNOWN_TYPE=8,
 PR_RDONLY=0, PR_SEEK_SET=0;
enum PRStatus {PR_FAILURE=-1,PR_SUCCESS=0};
#define NS_FAILED(x) ((x)!=0)
#define MOZ_ASSERT(...) assert((__VA_ARGS__))
#undef MOZ_ASSERT
#define MOZ_ASSERT(x, ...) assert(x)
#define MOZ_RELEASE_ASSERT(x) assert(x)
bool NS_IsMainThread(){return false;}
bool IsFileNotFound(int x){return x==NS_ERROR_FILE_NOT_FOUND;}
std::string operator""_ns(const char* x, size_t n){return std::string(x,n);}
struct nsCString {std::string s; void Append(char c){s+=c;} template<class... A> void AppendPrintf(const char*,A...){s+="hex";} const char* get(){return s.c_str();}};
template<class T> struct Span {
 T* p; size_t n; Span(T* p,size_t n):p(p),n(n){} size_t Length() const{return n;}
 size_t LengthBytes() const{return n*sizeof(T);} T* Elements()const{return p;}
 T* data()const{return p;} T* begin()const{return p;} T* end()const{return p+n;}
 T& at(size_t i)const{return p[i];} Span To(size_t x)const{return {p,x};}
 Span From(size_t x)const{return {p+x,n-x};} Span Last(size_t x)const{return {p+n-x,x};}
};
Span<const uint8_t> AsBytes(Span<const char> x){return {reinterpret_cast<const uint8_t*>(x.p),x.n};}
// Legacy no-digest body checks only. Unsupported crypto must fail, never fake a hash.
// Match nsString's declared surface, not std::u16string's extra range API.
struct nsString {std::u16string value; size_t Length()const{return value.size();} std::u16string_view View()const{return value;} bool EqualsASCII(const char*)const{return false;}};
template<class T,size_t N> struct AutoTArray:std::vector<T>{size_t Length()const{return this->size();}};
constexpr int SEC_OID_SHA256=1, SHA256_LENGTH=32;
struct Digest {int Begin(int){return NS_ERROR_UNEXPECTED;} int Update(Span<const uint8_t>){return NS_ERROR_UNEXPECTED;} template<class T> int End(T&){return NS_ERROR_UNEXPECTED;}};
template<class T> struct Maybe:std::optional<T>{using std::optional<T>::optional; bool isNothing()const{return !*this;}};
struct Nothing {template<class T> operator Maybe<T>() const{return {};}};
namespace dom {template<class T> struct Nullable {std::optional<T> v; Nullable()=default; Nullable(T x):v(x){} bool IsNull()const{return !v;} T Value()const{return *v;}};}
struct Failure {int code;};
template<class E> Failure Err(E x){return {x.code};}
template<class T,class E> struct Result {
 std::optional<T> v; E error; Result(T x):v(std::move(x)),error(0){} Result(Failure f):error(f.code){}
 bool isErr()const{return !v;} T unwrap(){return std::move(*v);} E unwrapErr(){return error;}
 Failure propagateErr(){return {error.code};}
};
struct Counters {int alloc=0,codec=0,reads=0,stats=0,opens=0,seeks=0;uint32_t requested=0;} counts;
struct nsIFile {int IsFile(bool* out){*out=true;return NS_OK;} static constexpr int OS_READAHEAD=0; nsCString HumanReadablePath(){return {"inert-owned-file"};}};
struct InertStreamState {std::vector<uint8_t> bytes; int64_t size=0;int openError=0,statError=0,readError=0,seekError=0;} platform;
// Declared metadata surfaces: nsIFileStreams.idl / nsFileStreams.h / prio.h.
// Compatibility only; this standalone double is NOT compiled in source-only mode.
struct PRFileDesc {};
enum PRFileType {PR_FILE_FILE=1,PR_FILE_DIRECTORY=2,PR_FILE_OTHER=3};
struct PRFileInfo64 {PRFileType type;int64_t size;};
PRStatus PR_GetOpenFileInfo64(PRFileDesc*,PRFileInfo64* info){info->type=PR_FILE_FILE;info->size=platform.size;return platform.statError?PR_FAILURE:PR_SUCCESS;}
int NS_ErrorAccordingToNSPR(){return platform.statError;}
struct nsFileRandomAccessStream {
 PRFileDesc fd; int GetFileDescriptor(PRFileDesc** out){*out=&fd;return NS_OK;}
 size_t pos=0; int Init(nsIFile*,int,int,int){++counts.opens;return platform.openError;}
 int GetSize(int64_t* x){++counts.stats;*x=platform.size;return platform.statError;}
 int Seek(int,int64_t p){++counts.seeks;pos=p;return platform.seekError;}
 int Read(char* dest,uint32_t n,uint32_t* done){++counts.reads;if(platform.readError)return platform.readError;
 *done=std::min<size_t>(n,platform.bytes.size()-std::min(pos,platform.bytes.size()));
 if(*done)std::memcpy(dest,platform.bytes.data()+pos,*done);pos+=*done;return 0;}
};
template<class T> using RefPtr=std::shared_ptr<T>;
template<class T> auto MakeRefPtr(){return std::make_shared<T>();}
namespace LittleEndian {uint32_t readUint32(const uint8_t* p){return uint32_t(p[0])|(uint32_t(p[1])<<8)|(uint32_t(p[2])<<16)|(uint32_t(p[3])<<24);}}
namespace Compression {struct LZ4 {static bool decompress(const char*,size_t,char* out,uint32_t n,size_t* actual){++counts.codec;if(platform.readError)return false;std::memset(out,'a',n);*actual=n;return true;}};}
// Inert validation boundary: tests only ASCII positive / 0xff negative.
bool IsUtf8(Span<const char> s){for(char x:s)if(uint8_t(x)==255)return false;return true;}
class IOUtils {public:
 enum class BufferKind{String,Uint8Array};
 struct IOError {int code;template<class... A> IOError(int c,A...):code(c){} template<class... A> static IOError WithCause(IOError c,A...){return c;}};
 struct JsBuffer {
  std::shared_ptr<std::vector<char>> bytes=std::make_shared<std::vector<char>>();
  static JsBuffer CreateEmpty(BufferKind){return {};}
  static Result<JsBuffer,IOError> Create(BufferKind,uint32_t n){++counts.alloc;counts.requested=n;
   if(n>4096)return Err(IOError(NS_ERROR_OUT_OF_MEMORY));JsBuffer b;b.bytes->resize(n);return b;}
  Span<char> BeginWriting(){return {bytes->data(),bytes->size()};}
  Span<const char> BeginReading()const{return {bytes->data(),bytes->size()};}
  char* Elements(){return bytes->data();} void SetLength(size_t n){bytes->resize(n);}
 };
 static Result<JsBuffer,IOError> ReadSync(nsIFile*,uint64_t,Maybe<uint32_t>,bool,BufferKind,dom::Nullable<uint32_t> = {},dom::Nullable<uint32_t> = {});
 static Result<JsBuffer,IOError> ReadUTF8Sync(nsIFile*,bool,dom::Nullable<uint32_t> = {},dom::Nullable<uint32_t> = {});
 struct MozLZ4 {
  static constexpr std::array<uint8_t,8> MAGIC_NUMBER={'m','o','z','L','z','4','0',0};
  static constexpr size_t HEADER_SIZE=12;
  static Result<JsBuffer,IOError> Decompress(Span<const uint8_t>,BufferKind,dom::Nullable<uint32_t> = {});
 };
};
'''

CASES = r'''
int passed=0,total=0;
void check(std::string name,bool ok){++total;passed+=ok;std::cout<<(ok?"PASS ":"FAIL ")<<name<<" alloc="<<counts.alloc<<" requested="<<counts.requested<<" codec="<<counts.codec<<" read="<<counts.reads<<" stat="<<counts.stats<<"\n";}
void reset(std::vector<uint8_t> bytes={}){counts={};platform={};platform.bytes=bytes;platform.size=bytes.size();}
std::vector<uint8_t> header(uint32_t n){std::vector<uint8_t> b={'m','o','z','L','z','4','0',0};for(int i=0;i<4;i++)b.push_back((n>>(8*i))&255);b.push_back(1);return b;}
int code(Result<IOUtils::JsBuffer,IOUtils::IOError>& r){return r.isErr()?r.unwrapErr().code:0;}
int main(){using K=IOUtils::BufferKind;nsIFile f;
 for(auto size:{uint32_t(9),UINT32_MAX}){auto b=header(size);reset();auto r=IOUtils::MozLZ4::Decompress({b.data(),b.size()},K::String,8);check("header-overcap-"+std::to_string(size),code(r)==NS_ERROR_FILE_TOO_BIG&&counts.alloc==0&&counts.codec==0);}
 for(uint32_t n:{0,7,8}){auto b=header(n);reset();auto r=IOUtils::MozLZ4::Decompress({b.data(),b.size()},K::String,8);check("header-under-exact-"+std::to_string(n),!r.isErr()&&r.unwrap().BeginReading().Length()==n&&counts.alloc==(n?1:0)&&counts.codec==(n?1:0));}
 for(uint32_t n:{0,1}){auto b=header(n);reset();auto r=IOUtils::MozLZ4::Decompress({b.data(),b.size()},K::String,0);check("header-zero-budget-"+std::to_string(n),n?(code(r)==NS_ERROR_FILE_TOO_BIG&&counts.alloc==0&&counts.codec==0):!r.isErr());}
 {auto b=header(8);reset();auto r=IOUtils::MozLZ4::Decompress({b.data(),b.size()},K::String);check("header-uncapped",!r.isErr()&&counts.alloc==1&&counts.codec==1);}
 {auto b=header(8);b[0]=0;reset();auto r=IOUtils::MozLZ4::Decompress({b.data(),b.size()},K::String,0);check("bad-magic-before-cap",code(r)==NS_ERROR_FILE_CORRUPTED&&counts.alloc==0&&counts.codec==0);}
 {auto b=header(8);reset();auto r=IOUtils::MozLZ4::Decompress({b.data(),5},K::String,0);check("short-header",code(r)==NS_ERROR_FILE_CORRUPTED&&counts.alloc==0&&counts.codec==0);}
 for(auto n:{0,7,8,9}){reset(std::vector<uint8_t>(n,'a'));auto r=IOUtils::ReadSync(&f,0,Nothing{},false,K::Uint8Array,8);check("raw-under-exact-over-"+std::to_string(n),n>8?(code(r)==NS_ERROR_FILE_TOO_BIG&&counts.alloc==0&&counts.reads==0):(!r.isErr()&&r.unwrap().BeginReading().Length()==size_t(n)));}
 {reset({'a'});auto r=IOUtils::ReadSync(&f,0,Nothing{},false,K::String,0);check("raw-zero-budget-refuse",code(r)==NS_ERROR_FILE_TOO_BIG&&counts.alloc==0&&counts.reads==0);}
 {reset();auto r=IOUtils::ReadSync(&f,0,Nothing{},false,K::String,0);check("raw-zero-budget-empty",!r.isErr()&&counts.alloc==0&&counts.reads==0);}
 for(uint32_t max:{0,1,100}){reset(std::vector<uint8_t>(9,'a'));auto r=IOUtils::ReadSync(&f,8,Maybe<uint32_t>(max),false,K::String,8);check("whole-file-not-hidden-by-offset-maxBytes-"+std::to_string(max),code(r)==NS_ERROR_FILE_TOO_BIG&&counts.alloc==0&&counts.reads==0);}
 {reset({'a','b'});auto r=IOUtils::ReadSync(&f,0,Maybe<uint32_t>(UINT32_MAX),false,K::String,2);check("capped-maxBytes-cannot-overallocate",!r.isErr()&&counts.requested<=2);}
 {reset({'a','b'});auto r=IOUtils::ReadSync(&f,1,Nothing{},false,K::String,2);check("offset-within-file",!r.isErr()&&r.unwrap().BeginReading().Length()==1&&counts.seeks==1);}
 {reset({'a','b'});auto r=IOUtils::ReadSync(&f,9,Nothing{},false,K::String,2);check("offset-beyond-capped-file",!r.isErr()&&counts.alloc==0);}
 {reset({'a','b'});auto r=IOUtils::ReadSync(&f,0,Maybe<uint32_t>(1),false,K::String);check("legacy-maxBytes-truncation",!r.isErr()&&r.unwrap().BeginReading().Length()==1);}
 {reset({'a'});platform.size=INT64_MAX;auto r=IOUtils::ReadSync(&f,0,Nothing{},false,K::String);check("legacy-size-overflow",code(r)==NS_ERROR_FILE_TOO_BIG&&counts.alloc==0);}
 {reset({'a'});auto r=IOUtils::ReadSync(&f,UINT64_MAX,Nothing{},false,K::String,1);check("offset-overflow",code(r)==NS_ERROR_ILLEGAL_INPUT&&counts.opens==0&&counts.alloc==0);}
 {reset({'a'});platform.statError=88;auto r=IOUtils::ReadSync(&f,0,Maybe<uint32_t>(1),false,K::String,1);check("capped-stat-failclosed-with-maxBytes",code(r)==NS_ERROR_FILE_ACCESS_DENIED&&counts.alloc==0&&counts.reads==0);}
 {reset({'a'});platform.openError=NS_ERROR_FILE_NOT_FOUND;auto r=IOUtils::ReadSync(&f,0,Nothing{},false,K::String,1);check("open-notfound",code(r)==NS_ERROR_FILE_NOT_FOUND&&counts.alloc==0);}
 {reset({'a'});platform.readError=88;auto r=IOUtils::ReadSync(&f,0,Nothing{},false,K::String,1);check("read-status-preserved",code(r)==88);}
 {reset({'a'});platform.seekError=88;auto r=IOUtils::ReadSync(&f,1,Nothing{},false,K::String,1);check("seek-status-preserved",code(r)==88&&counts.alloc==0);}
 {reset({255});auto r=IOUtils::ReadUTF8Sync(&f,false,1,0);check("UTF8-invalid-boundary",code(r)==NS_ERROR_FILE_CORRUPTED);}
 {reset({'a'});auto r=IOUtils::ReadUTF8Sync(&f,false,1,0);check("decompressed-cap-ignored-when-raw",!r.isErr());}
 {reset({'a','b'});auto r=IOUtils::ReadUTF8Sync(&f,false,1,0);check("UTF8-forwards-raw-cap",code(r)==NS_ERROR_FILE_TOO_BIG&&counts.alloc==0&&counts.reads==0);}
 {reset(header(9));auto r=IOUtils::ReadUTF8Sync(&f,true,13,8);check("UTF8-forwards-decoded-cap",code(r)==NS_ERROR_FILE_TOO_BIG&&counts.alloc==1&&counts.codec==0);}
 {reset(header(8));auto r=IOUtils::ReadUTF8Sync(&f,true,13,8);check("UTF8-both-caps-positive",!r.isErr()&&counts.alloc==2&&counts.codec==1);}
 {reset(header(8));platform.readError=0;auto b=platform.bytes;reset();platform.readError=88;auto r=IOUtils::MozLZ4::Decompress({b.data(),b.size()},K::String,8);check("codec-error-preserved",code(r)==NS_ERROR_FILE_CORRUPTED&&counts.codec==1);}
 {reset({'a','b'});auto r=IOUtils::ReadSync(&f,0,Nothing{},false,K::String);check("legacy-uncapped-whole-file",!r.isErr()&&r.unwrap().BeginReading().Length()==2&&counts.alloc==1&&counts.reads==1);}
 {reset({'a','b'});auto r=IOUtils::ReadUTF8Sync(&f,false);check("legacy-uncapped-UTF8",!r.isErr()&&r.unwrap().BeginReading().Length()==2);}
 {reset(header(8));auto r=IOUtils::ReadUTF8Sync(&f,true);check("legacy-uncapped-compressed-UTF8",!r.isErr()&&counts.alloc==2&&counts.codec==1);}
 {reset({'a','b'});platform.statError=88;auto r=IOUtils::ReadSync(&f,0,Maybe<uint32_t>(1),false,K::String);check("legacy-maxBytes-skips-stat",!r.isErr()&&counts.stats==0);}
 {reset({'a'});auto r=IOUtils::ReadSync(&f,0,Maybe<uint32_t>(0),false,K::String,1);check("capped-maxBytes-zero-positive",!r.isErr()&&counts.stats==1&&counts.alloc==0&&counts.reads==0);}
 {auto b=header(8);reset();auto r=IOUtils::MozLZ4::Decompress({b.data(),b.size()},K::String,9);check("header-larger-budget",!r.isErr()&&counts.requested==8&&counts.codec==1);}
 std::cout<<"TOTAL "<<total<<" PASS "<<passed<<"\n";return total==passed?0:1;
}
'''


def source_contracts(source, header, idl):
    """Static source contracts only: no C++ execution, NSS or codec evidence."""
    rows = []
    def check(name, ok):
        rows.append({'name': name, 'status': 'PASS' if ok else 'FAIL'})
    check('nullable-canonical-digest-option', 'DOMString? expectedSHA256 = null;' in idl)
    read = definition(source, 'Result<IOUtils::JsBuffer, IOUtils::IOError> IOUtils::ReadSync(')
    utf8 = definition(source, 'Result<IOUtils::JsBuffer, IOUtils::IOError> IOUtils::ReadUTF8Sync(')
    for name in ('ReadSync', 'ReadUTF8Sync'):
        match = re.search(r'  static Result<[^;]+> ' + name + r'\([^;]+;', header)
        assert match, name + ' declaration missing'
        decl = match.group(0)
        check(name + '-optional-compatible-arg', 'const dom::Nullable<nsString>& aExpectedSHA256 = {}' in decl)
    for name in ('Read', 'ReadUTF8', 'ReadJSON'):
        body = definition(source, 'already_AddRefed<Promise> IOUtils::' + name + '(')
        check(name + '-NSS-before-dispatch', 'EnsureNSSInitializedChromeOrContent()' in body and
              body.index('EnsureNSSInitializedChromeOrContent()') < body.index('WithPromiseAndState(') and
              'if (!nssInitialized)' in body and 'Could not initialize NSS' in body)
        check(name + '-captures-digest', 'expectedSHA256 = aOptions.mExpectedSHA256' in body)
        check(name + '-dispatches-digest-and-budgets', bool(re.search(
            r'Read(?:UTF8)?Sync\([^;]+maxFileBytes\s*,\s*maxDecompressedBytes\s*,\s*expectedSHA256(?:\s*,\s*requireCompleteRead)?\)', body)))
        if name == 'Read':
            guard = body.find('aOptions.mOffset != 0 || !aOptions.mMaxBytes.IsNull()')
            check('reject-prefix-before-public-zero-fastpath', guard >= 0 and guard < body.index('aOptions.mMaxBytes.Value() == 0') and
                  '!aOptions.mExpectedSHA256.IsNull()' in body[:guard])
    check('native-refuses-offset-or-any-maxBytes', 'aOffset != 0 || !aMaxBytes.isNothing()' in read)
    check('canonical-length', 'aExpectedSHA256.Value().Length() != 64' in read)
    check('canonical-iteration-uses-native-string-view',
          'for (char16_t c : aExpectedSHA256.Value().View())' in read)
    check('canonical-lowercase-no-normalization', "c >= '0' && c <= '9'" in read and
          "c >= 'a' && c <= 'f'" in read and not re.search(r'ToLower|ToUpper|Trim\(', read))
    check('validation-before-open', 'aExpectedSHA256.Value().Length()' in read and
          read.index('aExpectedSHA256.Value().Length()') < read.index('stream->Init('))
    check('cap-before-allocation', read.index('streamSize > aMaxFileBytes.Value()') < read.index('JsBuffer::Create('))
    check('short-read-refusal', 'buffer.BeginReading().Length() != bufSize' in read)
    check('EOF-probe-and-size-recheck', 'stream->Read(&extraByte, 1, &extraRead)' in read and
          'stream->GetSize(&finalSize)' in read and 'extraRead != 0 || finalSize != bufSize' in read)
    check('NSS-SHA256-not-new-crypto', 'Digest digest;' in read and 'digest.Begin(SEC_OID_SHA256)' in read)
    check('hash-same-actual-raw-buffer', 'digest.Update(AsBytes(buffer.BeginReading()))' in read)
    check('digest-end-and-exact-comparison', 'digest.End(rawDigest)' in read and
          'aExpectedSHA256.Value().EqualsASCII(hexDigest.get())' in read)
    check('verify-before-decompression', 'digest.Update(' in read and read.index('digest.Update(') < read.index('MozLZ4::Decompress('))
    check('UTF8-forwards-before-validation', bool(re.search(
          r'aMaxFileBytes, aMaxDecompressedBytes, aExpectedSHA256(?:,\s*aRequireCompleteRead)?\)', utf8)) and
          utf8.index('ReadSync(') < utf8.index('IsUtf8('))
    check('digest-mismatch-is-refusal', 'SHA-256 mismatch' in read and 'NS_ERROR_FILE_CORRUPTED' in read)
    # Independent complete/regular contract: source/API evidence, never C++ RED.
    check('complete-default-false-in-inherited-options',
          'boolean requireCompleteRead = false;' in idl and
          'dictionary ReadOptions : ReadUTF8Options' in idl)
    for name in ('ReadSync', 'ReadUTF8Sync'):
        match = re.search(r'  static Result<[^;]+> ' + name + r'\([^;]+;', header)
        assert match, name + ' declaration missing'
        decl = match.group(0)
        check(name + '-complete-default-false', 'bool aRequireCompleteRead = false' in decl)
    for name in ('Read', 'ReadUTF8', 'ReadJSON'):
        body = definition(source, 'already_AddRefed<Promise> IOUtils::' + name + '(')
        check(name + '-captures-and-forwards-complete',
              'requireCompleteRead = aOptions.mRequireCompleteRead' in body and
              bool(re.search(r'expectedSHA256\s*,\s*requireCompleteRead\)', body)))
        if name == 'Read':
            guard = body.find('aOptions.mRequireCompleteRead || !aOptions.mExpectedSHA256.IsNull()')
            check('complete-refuses-prefix-before-public-zero', guard >= 0 and
                  guard < body.index('aOptions.mMaxBytes.Value() == 0'))
    check('complete-refuses-native-prefix-before-open',
          'aRequireCompleteRead || !aExpectedSHA256.IsNull()' in read and
          read.index('aOffset != 0 || !aMaxBytes.isNothing()') < read.index('stream->Init('))
    preflight = read.find('aFile->IsFile(&isFile)')
    check('complete-preflight-kind-before-open-preserves-error', preflight >= 0 and
          preflight < read.index('stream->Init(') and
          'IOError(rv, "Could not check file kind"_ns)' in read and
          'if (!isFile)' in read)
    check('complete-validates-actual-opened-descriptor',
          'stream->GetFileDescriptor(&fd)' in read and
          'PR_GetOpenFileInfo64(fd, &info)' in read and 'info.type != PR_FILE_FILE' in read and
          read.index('PR_GetOpenFileInfo64(fd, &info)') < read.index('JsBuffer::Create('))
    check('complete-independent-short-EOF-size-guard', bool(re.search(
          r'if \(aRequireCompleteRead \|\| !aExpectedSHA256.IsNull\(\)\) \{\s*if \(buffer.BeginReading\(\).Length\(\) != bufSize\)', read)))
    check('complete-hash-remains-conditional', bool(re.search(
          r'if \(!aExpectedSHA256.IsNull\(\)\) \{\s*Digest digest;', read)))
    check('complete-UTF8-forwarding', bool(re.search(r'aExpectedSHA256,\s*aRequireCompleteRead\)', utf8)))
    check('complete-preserves-size-status-with-ordinary-mapping',
          'aRequireCompleteRead ? rv : NS_ERROR_FILE_ACCESS_DENIED' in read)
    # SOURCE/API selection contract from unchanged chrome partial-read matcher:
    # /DataError: .*expectedSHA256 requires a complete read/. Not native execution.
    public = definition(source, 'already_AddRefed<Promise> IOUtils::Read(')
    for name, body, complete, expected, partial, call, end in (
        ('public', public, 'aOptions.mRequireCompleteRead', 'aOptions.mExpectedSHA256',
         'aOptions.mOffset != 0 || !aOptions.mMaxBytes.IsNull()', 'RejectJSPromise(promise,', '); return;'),
        ('native', read, 'aRequireCompleteRead', 'aExpectedSHA256',
         'aOffset != 0 || !aMaxBytes.isNothing()', 'return Err(', ');'),
    ):
        marker = 'if ((' + complete + ' || !' + expected + '.IsNull()) &&'
        guard = definition(body, marker) if marker in body else ''
        selected = (marker + '(' + partial + ')) {' + call + '!' + expected + '.IsNull() ? '
                    'IOError(NS_ERROR_ILLEGAL_INPUT, "expectedSHA256 requires a complete read without offset or maxBytes"_ns) : '
                    'IOError(NS_ERROR_ILLEGAL_INPUT, "Complete reads require no offset or maxBytes"_ns)' + end + '}')
        # Join C++ adjacent literals; require the entire active refusal branch,
        # not a legacy message sitting elsewhere or blaming an absent digest.
        check(name + '-partial-read-diagnostic-selection',
              re.findall(r'"[^"]*"|\S', re.sub(r'"\s*"', '', guard)) ==
              re.findall(r'"[^"]*"|\S', selected))
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cpp', required=True, type=Path)
    parser.add_argument('--header', required=True, type=Path)
    parser.add_argument('--webidl', required=True, type=Path)
    parser.add_argument('--source-only', action='store_true',
                        help='check source contracts only; never construct or run a compiler')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    root = args.output.absolute()
    if Path('/Users/kenkuang/.hermes/projects') not in root.parents or root.exists():
        parser.error('--output must be fresh under ~/.hermes/projects')
    root.mkdir(mode=0o700)
    files = [args.cpp, args.header, args.webidl, Path(__file__)]
    bindings = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    for i, p in enumerate(files):
        (root / ('bound-input-' + str(i))).write_bytes(p.read_bytes())
    source = args.cpp.read_text()
    if args.source_only:
        contracts = source_contracts(source, args.header.read_text(), args.webidl.read_text())
        result = {'mode': 'source-only contracts; NOT native behavior',
                  'bindings': bindings, 'contracts': contracts,
                  'commands': [], 'compiler_constructed': False,
                  'unchanged_inputs': all(hashlib.sha256(p.read_bytes()).hexdigest() == bindings[str(p)] for p in files)}
        result['contracts_passed'] = sum(x['status'] == 'PASS' for x in contracts)
        (root / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
        return int(result['contracts_passed'] != len(contracts) or not result['unchanged_inputs'])
    bodies = []
    adapted = []
    for name in ('ReadSync', 'ReadUTF8Sync', 'MozLZ4::Decompress'):
        sig = 'Result<IOUtils::JsBuffer, IOUtils::IOError> IOUtils::' + name + '(' 
        body = definition(source, sig)
        signature, rest = body.split('{', 1)
        # Old signatures have no budgets. Only the harness signature is extended;
        # the actual old body remains unchanged and ignores the supplied caps.
        if 'aMaxFileBytes' not in signature and name != 'MozLZ4::Decompress':
            signature = signature.rstrip()[:-1] + ', dom::Nullable<uint32_t> aMaxFileBytes, dom::Nullable<uint32_t> aMaxDecompressedBytes) '
            adapted.append(name)
        if name == 'MozLZ4::Decompress' and 'aMaxDecompressedBytes' not in signature:
            signature = signature.rstrip()[:-1] + ', dom::Nullable<uint32_t> aMaxDecompressedBytes) '
            adapted.append(name)
        bodies.append(signature + '{' + rest)
        (root / (name.replace('::', '-') + '.extracted.txt')).write_text(body)
    prelude = PRELUDE
    header = args.header.read_text()
    # Candidate declarations come from the real header, not invented overloads.
    # Only the pre-cap baseline needs the explicitly labelled signature adapter.
    for name in ('ReadSync', 'ReadUTF8Sync', 'Decompress'):
        declaration = re.search(r'  static Result<[^;]+> ' + name + r'\([^;]+;', header).group(0)
        if 'aMaxDecompressedBytes' in declaration:
            prelude = re.sub(r' static Result<[^;]+> ' + name + r'\([^;]+;', lambda _: declaration, prelude, count=1)
    unit = prelude + '\n'.join(bodies) + CASES
    (root / 'actual-body.cpp').write_text(unit)
    contracts = []
    def contract(name, condition):
        contracts.append({'name': name, 'status': 'PASS' if condition else 'FAIL'})
    idl = args.webidl.read_text()
    for name in ('maxFileBytes', 'maxDecompressedBytes'):
        contract('WebIDL-' + name, bool(re.search(r'\[EnforceRange\]\s+unsigned long\?\s+' + name + r'\s*=\s*null;', idl)))
    contract('ReadOptions-inherits-UTF8-options', 'dictionary ReadOptions : ReadUTF8Options' in idl)
    for name in ('Read', 'ReadUTF8', 'ReadJSON'):
        body = definition(source, 'already_AddRefed<Promise> IOUtils::' + name + '(')
        (root / (name + '.frontdoor.txt')).write_text(body)
        for member in ('maxFileBytes', 'maxDecompressedBytes'):
            contract(name + '-captures-' + member, member + ' = aOptions.m' + member[0].upper() + member[1:] in body)
        target = 'ReadSync' if name == 'Read' else 'ReadUTF8Sync'
        contract(name + '-dispatches-both-budgets', bool(re.search(target + r'\([^;]+\bmaxFileBytes\s*,\s*maxDecompressedBytes(?:\s*,\s*expectedSHA256(?:\s*,\s*requireCompleteRead)?)?\s*\)', body)))
        if name == 'Read':
            contract('maxBytes-decompress-incompatibility-retained', 'if (aOptions.mDecompress)' in body and 'mutually exclusive' in body)
            contract('maxBytes-zero-does-not-bypass-file-cap', bool(re.search(r'aOptions.mMaxBytes.Value\(\) == 0\s*&&\s*aOptions.mMaxFileBytes.IsNull\(\)', body)))
    commands = [['/usr/bin/clang++', '-std=c++20', '-O0', str(root / 'actual-body.cpp'), '-o', str(root / 'actual-body')]]
    # Tool-shell TMPDIR can differ from the advertised runtime environment.
    # Pin every compiler/executable child rather than trusting inheritance.
    child_env = {**os.environ, 'TMPDIR': '/Users/kenkuang/.hermes/cache/scratch'}
    compile_result = subprocess.run(commands[0], capture_output=True, text=True, timeout=120, env=child_env)
    (root / 'compile.stdout').write_text(compile_result.stdout)
    (root / 'compile.stderr').write_text(compile_result.stderr)
    result = {'bindings': bindings, 'signature_only_baseline_adapters': adapted,
              'boundaries': 'inert platform stream, bounded recording allocator, inert ASCII/0xff UTF8 validator, inert codec; NOT generated bindings/native MozLZ4/Gecko',
              'contracts': contracts, 'commands': commands, 'compile_exit': compile_result.returncode,
              'child_TMPDIR': child_env['TMPDIR']}
    if compile_result.returncode == 0:
        commands.append([str(root / 'actual-body')])
        run = subprocess.run(commands[-1], capture_output=True, text=True, timeout=120, env=child_env)
        (root / 'native.stdout').write_text(run.stdout)
        (root / 'native.stderr').write_text(run.stderr)
        rows = [line for line in run.stdout.splitlines() if line.startswith(('PASS ', 'FAIL '))]
        result.update(native_exit=run.returncode, native_count=len(rows), native_passed=sum(x.startswith('PASS ') for x in rows))
        print(run.stdout)
    else:
        print(compile_result.stderr)
    result['contracts_passed'] = sum(x['status'] == 'PASS' for x in contracts)
    result['unchanged_inputs'] = all(hashlib.sha256(p.read_bytes()).hexdigest() == bindings[str(p)] for p in files)
    (root / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    return int(compile_result.returncode != 0 or result.get('native_exit') != 0 or result['contracts_passed'] != len(contracts) or not result['unchanged_inputs'])


if __name__ == '__main__':
    raise SystemExit(main())
