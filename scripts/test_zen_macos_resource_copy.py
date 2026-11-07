#!/usr/bin/env python3
"""Exercise Gecko's real install manifest without Mach or a browser."""
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "engine"
sys.path[:0] = [str(ENGINE / "python/mozbuild"),
                str(ENGINE / "testing/mozbase/mozfile"),
                str(ENGINE / "testing/mozbase/mozprocess")] + [
    str(p) for p in (ENGINE / "third_party/python").iterdir() if p.is_dir()
]
from mozbuild.action.process_install_manifest import process_manifest
from mozpack.manifests import InstallManifest


def main():
    with tempfile.TemporaryDirectory(prefix="zen-resource-copy-") as temporary:
        root = Path(temporary)
        source = root / "source.mjs"
        source.write_bytes(b"export const value = 1;\n")
        dest = root / "object"
        dest.mkdir()
        output = dest / "actor.mjs"
        manifest = InstallManifest()
        manifest.add_link(str(source), "actor.mjs")
        path = root / "manifest"
        manifest.write(path=str(path))
        track = root / "track"
        process_manifest(str(dest), [str(path)], str(track))
        assert output.is_symlink(), "default symbolic-link policy changed"
        process_manifest(str(dest), [str(path)], str(track), no_symlinks=True)
        assert not output.is_symlink(), "copy mode retained an escaping source link"
        assert output.read_bytes() == source.read_bytes()
        process_manifest(str(dest), [str(path)], str(track), no_symlinks=True)
        assert not output.is_symlink(), "repeat copy restored a source link"
        source.write_bytes(b"export const value = 2;\n")
        os.utime(output, ns=(1, 1))
        process_manifest(str(dest), [str(path)], str(track), no_symlinks=True)
        assert output.read_bytes() == source.read_bytes(), "copy did not synchronize"
        old = root / "unrelated.mjs"
        old.write_bytes(b"leave this source alone\n")
        output.unlink()
        output.symlink_to(old)
        process_manifest(str(dest), [str(path)], str(track), no_symlinks=True)
        assert not output.is_symlink() and output.read_bytes() == source.read_bytes()
        assert old.read_bytes() == b"leave this source alone\n", "copy followed output link"
        output.unlink()
        output.symlink_to(old)
        source.unlink()
        try:
            process_manifest(str(dest), [str(path)], str(track), no_symlinks=True)
        except FileNotFoundError:
            pass
        else:
            raise AssertionError("missing input was accepted")
        assert output.is_symlink() and output.read_bytes() == old.read_bytes()
    assert "mk_add_options NSDISTMODE=copy" in (ROOT / "configs/macos/mozconfig").read_text()
    print("PASS: real manifest copy transition, synchronization, source safety and macOS policy")


if __name__ == "__main__":
    main()
