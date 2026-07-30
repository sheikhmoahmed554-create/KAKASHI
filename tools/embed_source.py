#!/usr/bin/env python3
"""يدمج ملف Pine داخل صفحة المختبر (SOURCE_B64) أو يستخرجه منها.

    python3 tools/embed_source.py extract KAKASHI_V16_TV_PARITY_AUDIT.html out.pine
    python3 tools/embed_source.py embed   KAKASHI_V16_TV_PARITY_AUDIT.html indicator/SYR13_R13.pine
"""
import base64
import re
import sys

PATTERN = re.compile(r'(const SOURCE_B64=")([^"]*)(")')


def extract(page_path, pine_path):
    page = open(page_path, encoding='utf-8').read()
    m = PATTERN.search(page)
    if not m:
        sys.exit('SOURCE_B64 غير موجود في ' + page_path)
    src = base64.b64decode(m.group(2)).decode('utf-8')
    open(pine_path, 'w', encoding='utf-8').write(src)
    print('استُخرج %d سطر إلى %s' % (src.count('\n') + 1, pine_path))


def embed(page_path, pine_path):
    page = open(page_path, encoding='utf-8').read()
    if not PATTERN.search(page):
        sys.exit('SOURCE_B64 غير موجود في ' + page_path)
    src = open(pine_path, encoding='utf-8').read()
    blob = base64.b64encode(src.encode('utf-8')).decode('ascii')
    open(page_path, 'w', encoding='utf-8').write(
        PATTERN.sub(lambda m: m.group(1) + blob + m.group(3), page, count=1))
    print('دُمج %d سطر داخل %s' % (src.count('\n') + 1, page_path))
    print('لا تنسَ تحديث SOURCE_BASELINES إذا تغيّر عدد الـ inputs أو الـ functions.')


if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[1] not in ('extract', 'embed'):
        sys.exit(__doc__)
    (extract if sys.argv[1] == 'extract' else embed)(sys.argv[2], sys.argv[3])
