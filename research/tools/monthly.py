"""تفصيل شهري لمحاسبة المؤشر نفسها — يجيب على «أي رقم أصدّق؟».

    python3 monthly.py own_full.json [offset]

offset = فهرس الشمعة الأولى في النافذة داخل vault.csv (للنوافذ المقصوصة من الذيل).
سجل الصفقة: [entryBar, exitBar, side, isWin, target, stop, sourceCode]
"""
import json, csv, sys, numpy as np
R = list(csv.DictReader(open('vault.csv')))
d = json.load(open(sys.argv[1]))
off = int(sys.argv[2]) if len(sys.argv) > 2 else (len(R) - d['bars'])
log = d['log']
print('%s — %d صفقة، النافذة تبدأ عند الشمعة %d (%s)'
      % (sys.argv[1], len(log), off, R[off]['time'][:10]))
print()
by = {}
for eb, xb, side, win, tgt, stp, src in log:
    i = off + int(eb)
    if i >= len(R): continue
    mo = R[i]['time'][:7]
    a = by.setdefault(mo, [0, 0, 0.0, [], [], [0, 0], [0, 0]])
    a[0] += 1; a[1] += win
    a[2] += tgt if win else -stp
    a[3].append(tgt); a[4].append(stp)
    k = 0 if side > 0 else 1
    a[5][k] += 1; a[6][k] += win

print('%-9s %7s %6s %6s %8s %8s %8s %9s %8s' %
      ('الشهر', 'صفقات', 'ربح', 'خسارة', 'نسبة%', 'م.هدف', 'م.وقف', 'صافي', 'تعادل%'))
print('─' * 78)
T = W = 0; NET = 0.0; AT = []; AS = []
for mo in sorted(by):
    n, w, net, tg, st, sides, swin = by[mo]
    at, as_ = np.mean(tg), np.mean(st)
    print('%-9s %7d %6d %6d %7.2f%% %8.1f %8.1f %+9.0f %7.2f%%'
          % (mo, n, w, n - w, 100 * w / n, at, as_, net, 100 * as_ / (at + as_)))
    T += n; W += w; NET += net; AT += tg; AS += st
at, as_ = np.mean(AT), np.mean(AS)
print('─' * 78)
print('%-9s %7d %6d %6d %7.2f%% %8.1f %8.1f %+9.0f %7.2f%%'
      % ('الكل', T, W, T - W, 100 * W / T, at, as_, NET, 100 * as_ / (at + as_)))
print()
wrs = [100 * by[m][1] / by[m][0] for m in sorted(by) if by[m][0] >= 30]
if len(wrs) > 1:
    print('تذبذب النسبة الشهرية: من %.2f%% إلى %.2f%%  (المدى %.2f نقطة مئوية، الانحراف %.2f)'
          % (min(wrs), max(wrs), max(wrs) - min(wrs), np.std(wrs)))
print()
print('حسب الجهة:')
bt = sum(by[m][5][0] for m in by); bw = sum(by[m][6][0] for m in by)
st_ = sum(by[m][5][1] for m in by); sw = sum(by[m][6][1] for m in by)
if bt: print('  شراء : %d صفقة | %d ربح | %.2f%%' % (bt, bw, 100 * bw / bt))
if st_: print('  بيع  : %d صفقة | %d ربح | %.2f%%' % (st_, sw, 100 * sw / st_))
