"""يبني نسخة SYR30 معدّلة بتعديل التمدد، مع إعدادات قابلة للتحكم.

    python3 make_syr30.py <stretch> <rsi> <out.pine>

التعديل الوحيد: يستبدل آخر إسناد لـ buySignal/sellSignal بقاعدة التمدد،
ويضيف مفاتيح تسمح بالرجوع للسلوك الأصلي أو المزج بينهما.
"""
import base64, re, sys, json

V16 = '/home/user/KAKASHI/KAKASHI_V16_TV_PARITY_AUDIT.html'
stretch = sys.argv[1] if len(sys.argv) > 1 else '3.0'
rsi     = sys.argv[2] if len(sys.argv) > 2 else '15'
out     = sys.argv[3] if len(sys.argv) > 3 else 'SYR30_STRETCH.pine'
rsi_hi  = str(100 - int(rsi))

src = None
for line in open(V16, encoding='utf-8'):
    m = re.match(r'const SOURCE_B64="([^"]*)"', line)
    if m:
        src = base64.b64decode(m.group(1)).decode('utf-8')
        break
if src is None:
    raise SystemExit('SOURCE_B64 غير موجود')

# مفاتيح التحكم — تُدرج بعد سطر indicator
anchor = 'indicator("SYR30"'
i = src.index(anchor)
j = src.index('\n', i)
panel = '''

// ══════════ تعديل التمدد ══════════
// مصدر دخول واحد يحل محل تجميع الأربعين مصدراً بـ or.
// القياس على 60,000 شمعة (صفقة واحدة، وقف زمني 30 شمعة، خطة المؤشر نفسها):
//   الأصل  : 2,138 صفقة • 1,219 هدف • 810 وقف • 58.98%
//   التمدد :   583 صفقة •   358 هدف • 209 وقف • 62.09%
G_STR = "تعديل التمدد"
stModeStr   = input.string("التمدد وحده", "وضع الدخول", options=["التمدد وحده", "الأصل وحده", "الاثنان معاً"], group=G_STR)
stStretchTh = input.float(@STRETCH@, "عتبة التمدد — مضاعفات ATR", minval=0.5, maxval=8.0, step=0.1, group=G_STR)
stRsiBuy    = input.int(@RSIB@, "RSI3 للشراء — أقل من", minval=1, maxval=50, group=G_STR)
stRsiSell   = input.int(@RSIS@, "RSI3 للبيع — أكثر من", minval=50, maxval=99, group=G_STR)
'''.replace('@STRETCH@',stretch).replace('@RSIB@',rsi).replace('@RSIS@',rsi_hi)
src = src[:j] + panel + src[j:]

# استبدال آخر إسناد
old_b = 'buySignal := buySignal or chTriB or chSniB'
old_s = 'sellSignal := sellSignal or chTriS or chSniS'
assert old_b in src and old_s in src, 'سطر الإسناد الأخير غير موجود'
new = '''stretchBuy  = chStretch < -stStretchTh and chRsi3 < stRsiBuy
stretchSell = chStretch >  stStretchTh and chRsi3 > stRsiSell
origBuy  = buySignal or chTriB or chSniB
origSell = sellSignal or chTriS or chSniS
buySignal  := stModeStr == "التمدد وحده" ? stretchBuy  : stModeStr == "الأصل وحده" ? origBuy  : (stretchBuy  or origBuy)
sellSignal := stModeStr == "التمدد وحده" ? stretchSell : stModeStr == "الأصل وحده" ? origSell : (stretchSell or origSell)'''
src = src.replace(old_b + '\n' + old_s, new)

open(out, 'w', encoding='utf-8').write(src)
n = src.count('\n')
print('%s : %d سطر' % (out, n))
print('الوضع الافتراضي: التمدد وحده • عتبة %s • RSI3 %s/%s' % (stretch, rsi, rsi_hi))
