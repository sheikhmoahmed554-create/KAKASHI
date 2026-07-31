"""من أين تأتي الصفقات فعلاً؟ تفصيل حسب `tradeEntrySourceCode` الذي يسجّله المؤشر.

بعد أن ثبت أن `tradeSide` و`sfBlock` و`useResearchGate` و`minVotes` كلها بلا أثر —
لأن أربعين مصدر إشارة تُدمج بـOR في آخر الملف فتبتلع كل ترشيح سابق — يصبح السؤال:
أي مصدر يصنع الصفقات، وأيها يصنع الربح؟

    python3 bysource.py own_fixboth.json [offset]
"""
import json, csv, sys, numpy as np
R = list(csv.DictReader(open('vault.csv')))
d = json.load(open(sys.argv[1]))
off = int(sys.argv[2]) if len(sys.argv) > 2 else (len(R) - d['bars'])
DAYS = len(set(r['time'][:10] for r in R[off:]))

NAMES = {1: 'M1 OWN', 2: 'M1 SAME', 3: 'M1 TAKE', 4: 'POC+BRK',
         5: 'TREND VOTE', 6: 'SCHOOL FUSION', 0: 'BASE 999'}

agg = {}
for eb, xb, side, win, tgt, stp, src in d['log']:
    k = int(src) if int(src) in NAMES else 0
    for key in ((k, 'الكل'), (k, 'شراء' if side > 0 else 'بيع')):
        a = agg.setdefault(key, [0, 0, 0.0, [], []])
        a[0] += 1; a[1] += win; a[2] += tgt if win else -stp
        a[3].append(tgt); a[4].append(stp)

print('%s — %d صفقة، %d يوم تداول' % (sys.argv[1], len(d['log']), DAYS))
print()
print('%-16s %-6s %7s %7s %8s %8s %8s %9s %9s %8s' %
      ('المصدر', 'جهة', 'صفقات', '/يوم', 'ربح', 'نسبة%', 'تعادل%', 'صافي', 'لكل صفقة', 'حصة%'))
print('─' * 96)
TOT = len(d['log'])
for k in sorted(NAMES, key=lambda x: -agg.get((x, 'الكل'), [0])[0]):
    if (k, 'الكل') not in agg: continue
    for side in ('الكل', 'شراء', 'بيع'):
        if (k, side) not in agg: continue
        n, w, net, tg, st = agg[(k, side)]
        at, as_ = np.mean(tg), np.mean(st)
        print('%-16s %-6s %7d %7.1f %8d %7.2f%% %7.2f%% %+9.0f %+9.2f %7.1f%%' %
              (NAMES[k] if side == 'الكل' else '', side, n, n / DAYS, w,
               100 * w / n, 100 * as_ / (at + as_), net, net / n, 100 * n / TOT))
    print()
