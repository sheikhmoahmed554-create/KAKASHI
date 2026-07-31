"""يبني SYR30_GATEFIX.pine من مصدر المؤشر مع إصلاح البوابة.

الخلل: `allowLong/allowShort` (مفتاح Trade Side) و`sfBlock` (مرشّح الجلسة والتذبذب)
يُطبّقان عند السطرين ٢٤٣١ و٢٤٧٧، ثم يأتي **٢١ إسناد OR** بعدهما فيتجاوزهما تماماً.
الإصلاح: إعادة تطبيق البوابتين بعد آخر إسناد OR وقبل `canEnterLong`.

    python3 make_gatefix.py
"""
import re, base64, os

HTML = '/home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html'
OUT = '/home/user/KAKASHI/SYR30_GATEFIX.pine'

s = open(HTML, encoding='utf-8', errors='replace').read()
m = re.search(r"SOURCE_B64\s*=\s*['\"]([A-Za-z0-9+/=]+)['\"]", s)
src = base64.b64decode(m.group(1)).decode('utf-8')

ANCHOR = ("buySignal := buySignal or chTriB or chSniB\n"
          "sellSignal := sellSignal or chTriS or chSniS")
assert src.count(ANCHOR) == 1, 'المرساة غير فريدة'

FIX = ANCHOR + """

// ══ إصلاح البوابة ══════════════════════════════════════════════════════════
// مفتاح Trade Side ومرشّح الجلسة/التذبذب كانا يُطبَّقان عند السطرين ٢٤٣١ و٢٤٧٧،
// ثم تتجاوزهما ٢١ إسناد OR لاحقاً (مدارس ch*) فيدخلان صفقات ممنوعة.
// إعادة تطبيقهما هنا — بعد آخر مصدر إشارة وقبل قرار الدخول — تصلح الاثنين.
buySignal  := buySignal  and allowLong  and not sfBlock
sellSignal := sellSignal and allowShort and not sfBlock
// ═══════════════════════════════════════════════════════════════════════════"""

out = src.replace(ANCHOR, FIX)
assert out != src
open(OUT, 'w', encoding='utf-8').write(out)
n = len(out.split('\n'))
print('اتكتب %s — %d سطر (%+d)' % (OUT, n, n - len(src.split('\n'))))
print('الإصدار:', [l for l in out.split('\n')[:5] if '@version' in l])
