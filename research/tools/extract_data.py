"""يستخرج داتا XAUUSD M1 المضغوطة من داخل صفحة V16 إلى vault.csv.

كل أدوات البحث بتقرا vault.csv من مجلد التشغيل، فده أول أمر يتنفذ في أي جلسة جديدة:

    cd research/tools && python3 extract_data.py
"""
import base64, gzip, re, os

HTML = os.path.join(os.path.dirname(__file__), '..', '..',
                    'KAKASHI_V16_TV_PARITY_AUDIT.html')

def main(out='vault.csv'):
    with open(HTML, encoding='utf-8') as f:
        for line in f:
            m = re.match(r"const BUILTIN_2026_GZ_B64='([^']*)'", line)
            if not m:
                continue
            raw = gzip.decompress(base64.b64decode(m.group(1)))
            with open(out, 'wb') as g:
                g.write(raw)
            rows = raw.count(b'\n')
            print('%s : %d سطر، %.1f ميجابايت' % (out, rows, len(raw) / 1e6))
            return
    raise SystemExit('BUILTIN_2026_GZ_B64 غير موجود في الصفحة')

if __name__ == '__main__':
    main()
