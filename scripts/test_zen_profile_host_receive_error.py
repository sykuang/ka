#!/usr/bin/env python3
"""Compile/run the complete production receive method in a no-UI fixture.

Usage: /usr/bin/python3 -B scripts/test_zen_profile_host_receive_error.py OUTPUT_DIR
Optional --source permits an immutable pre-fix replay. Only OUTPUT_DIR is written.
This is a result-adapter regression with real kernel resources, not a naturally
occurring BODY_ERROR or native host/dispatch/window lifecycle test.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--source", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    source = args.source or root / "src/zen/toolkit/common/cocoa/ZenProfileHost.mm"
    fixture = Path(__file__).with_suffix(".mm")
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    text = source.read_text()
    start = text.index("- (void)receive {")
    end = text.index("\n- (void)dealloc", start)
    method = text[start:end]
    template = fixture.read_text()
    assert template.count("// ACTUAL_RECEIVE_METHOD") == 1
    generated = out / "receive-extracted.mm"
    generated.write_text(template.replace("// ACTUAL_RECEIVE_METHOD", method))
    env = dict(os.environ, TMPDIR="/Users/kenkuang/.hermes/cache/scratch")
    compiler = subprocess.check_output(["/usr/bin/xcrun", "--find", "clang++"], text=True).strip()
    inputs = [source, fixture, Path(__file__), root / "src/zen/toolkit/common/ZenProfileHostProtocol.h"]
    hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    versions = {"interpreter": sys.version, "executable": sys.executable,
                "compiler": subprocess.check_output([compiler, "--version"], text=True)}
    command = [compiler, "-std=c++17", "-Wall", "-Wextra", "-Werror",
               "-I" + str(root / "src/zen/toolkit/common"), str(generated),
               "-framework", "Foundation", "-framework", "QuartzCore", "-o", str(out / "receive")]
    records = []
    for cmd in [command, [str(out / "receive")]]:
        result = subprocess.run(cmd, text=True, capture_output=True, env=env, cwd=root)
        records.append(dict(command=cmd, cwd=str(root), exit=result.returncode,
                            stdout=result.stdout, stderr=result.stderr))
        print(result.stdout, end="")
        print(result.stderr, end="", file=sys.stderr)
        if result.returncode:
            break
    after = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    receipt = dict(versions=versions, hashes=hashes, afterHashes=after,
                   inputsUnchanged=hashes == after, records=records,
                   generatedSHA256=hashlib.sha256(generated.read_bytes()).hexdigest(),
                   classification="Real successful kernel transfer; injected receive result only. No UI lifecycle or natural shortage claim.")
    (out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return records[-1]["exit"] if hashes == after else 2


if __name__ == "__main__":
    sys.exit(main())
