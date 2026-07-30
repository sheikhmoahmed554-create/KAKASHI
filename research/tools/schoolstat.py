"""يقيس كل مدرسة من مدارس SYR30 التسع وحدها.

    python3 schoolstat.py schools6m.json [tp] [sl]

يقرأ إشارات المدارس من ناتج schools.mjs (صيغة [رقم الشمعة, الجهة])
والأسعار من vault.csv. يفتح صفقة عند إغلاق كل شمعة إشارة ويقيس النتيجة.
"""
import json, csv, math, sys

PU = 0.1
NAMES = {
    'finalS06': 'الزخم Momentum',
    'finalS09': 'بولنجر+كلتنر (شراء فقط)',
    'finalS11': 'QQE + Vortex',
    'finalS12': 'Balance Reset ★جديدة',
    'finalS17': 'Dead Auction ★جديدة',
    'finalS18': 'Ichimoku',
    'finalS19': 'Side Pack / 331',
    'finalS22': 'السيولة Liquidity',
    'finalS23': 'Asia Break-Retest ★جديدة',
}
ORDER = ['finalS06','finalS09','finalS11','finalS12','finalS17',
         'finalS18','finalS19','finalS22','finalS23']

path = sys.argv[1] if len(sys.argv) > 1 else 'schools6m.json'
TP = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0
SL = float(sys.argv[3]) if len(sys.argv) > 3 else 50.0

R = list(csv.DictReader(open('vault.csv')))
H = [float(r['high']) for r in R]
L = [float(r['low']) for r in R]
C = [float(r['close']) for r in R]
N = len(R)

d = json.load(open(path))
sig = d['sig']

def sim(i0, buy, maxbars=240):
    """الوقف له الأولوية عند لمس الاثنين في نفس الشمعة — مثل TradingView."""
    ep = C[i0]
    tp = ep + (TP * PU if buy else -TP * PU)
    sl = ep - (SL * PU if buy else -SL * PU)
    for i in range(i0 + 1, min(i0 + 1 + maxbars, N)):
        if (L[i] <= sl) if buy else (H[i] >= sl):
            return 0
        if (H[i] >= tp) if buy else (L[i] <= tp):
            return 1
    return None

BE = 100 * SL / (TP + SL)
print('خطة الاختبار: هدف %g / وقف %g   •   نقطة التعادل %.1f%%' % (TP, SL, BE))
print('كل مدرسة تُقاس وحدها: صفقة عند إغلاق أول شمعة في كل سلسلة إشارة.\n')
print('%-28s %9s %8s %9s %10s %11s' % ('المدرسة', 'إشارات', 'فوز%', 'الحافة', 'الصافي', 'لكل صفقة'))
print('─' * 80)

rows = []
for k in ORDER:
    ev = sig.get(k, [])
    if not ev:
        print('%-28s %9d   ⛔ لا تُطلق أي إشارة' % (NAMES[k], 0))
        continue
    w = l = 0
    sides = {'BUY': [0, 0], 'SELL': [0, 0]}
    for i, s in ev:
        if i >= N - 1:
            continue
        r = sim(i, s > 0)
        if r is None:
            continue
        key = 'BUY' if s > 0 else 'SELL'
        sides[key][0] += 1
        sides[key][1] += r
        w += r
        l += 1 - r
    n = w + l
    if n < 20:
        print('%-28s %9d   عيّنة أصغر من أن تُقاس' % (NAMES[k], n))
        continue
    wr = 100 * w / n
    net = w * TP - l * SL
    se = math.sqrt(BE / 100 * (1 - BE / 100) / n) * 100
    rows.append((k, n, wr, wr - BE, net, net / n, se, sides))
    print('%-28s %9d %7.1f%% %+8.1f %10.0f %+10.2f' % (NAMES[k], n, wr, wr - BE, net, net / n))

print('─' * 80)
if not rows:
    raise SystemExit('\nلا توجد مدرسة واحدة قابلة للقياس.')

print('\nالتفصيل حسب الجهة:')
print('%-28s %-24s %-24s' % ('المدرسة', 'شراء', 'بيع'))
for k, n, wr, edge, net, exp, se, sides in rows:
    cells = []
    for side in ('BUY', 'SELL'):
        cnt, won = sides[side]
        cells.append('%5d إشارة  %5.1f%%' % (cnt, 100 * won / cnt) if cnt >= 20
                     else '%5d إشارة    —' % cnt)
    print('%-28s %-24s %-24s' % (NAMES[k], cells[0], cells[1]))

print('\nالدلالة الإحصائية (انحراف الحافة عن الصفر):')
for k, n, wr, edge, net, exp, se, sides in sorted(rows, key=lambda x: -x[3]):
    z = edge / se
    tag = 'حقيقية' if abs(z) >= 2.5 else ('محتملة' if abs(z) >= 1.8 else 'ضمن الضوضاء')
    print('  %-28s حافة %+6.1f  خطأ معياري %.2f  →  %+6.2f σ  %s'
          % (NAMES[k], edge, se, z, tag))
