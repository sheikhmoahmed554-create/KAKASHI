#!/usr/bin/env python3
"""Pull the Pine engine and the bar data back out of a KAKASHI HTML build.

The KAKASHI apps ship three base64 payloads inline: the Pine interpreter
(CORE_B64), the embedded indicator source (SOURCE_B64, absent from V16), and a
gzipped CSV of XAUUSD M1 bars (BUILTIN_2026_GZ_B64). The Node harness in this
folder needs the first and the third as plain files.

    python3 tools/extract.py KAKASHI_V16_TV_PARITY_AUDIT.html tools/work
"""
import base64
import gzip
import pathlib
import re
import sys


def extract(html_path: str, out_dir: str) -> None:
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    src = pathlib.Path(html_path).read_text(encoding="utf-8", errors="replace")

    core = re.search(r"CORE_B64\s*=\s*['\"]([A-Za-z0-9+/=]+)['\"]", src)
    if core:
        js = base64.b64decode(core.group(1)).decode("utf-8", errors="replace")
        (out / "core_v16.js").write_text(js)
        print(f"core_v16.js         {len(js):>12,} bytes")
    else:
        print("CORE_B64 not found", file=sys.stderr)

    pine = re.search(r"SOURCE_B64\s*=\s*['\"]([A-Za-z0-9+/=]+)['\"]", src)
    if pine:
        p = base64.b64decode(pine.group(1)).decode("utf-8", errors="replace")
        (out / "embedded_indicator.pine").write_text(p)
        print(f"embedded_indicator  {len(p):>12,} bytes")

    gz = re.search(r"BUILTIN_2026_GZ_B64\s*=\s*['\"]([A-Za-z0-9+/=]+)['\"]", src)
    if gz:
        raw = gzip.decompress(base64.b64decode(gz.group(1)))
        (out / "xauusd_m1_2026.csv").write_bytes(raw)
        rows = raw.count(b"\n")
        print(f"xauusd_m1_2026.csv  {len(raw):>12,} bytes  ({rows:,} rows)")
    else:
        print("BUILTIN_2026_GZ_B64 not found (older build?)", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    extract(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "tools/work")
