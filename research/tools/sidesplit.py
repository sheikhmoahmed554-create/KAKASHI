"""شراء مقابل بيع، شهراً بشهر — هل تفوّق البيع حقيقي أم مجرد سوق هابط؟

مصيدة انحياز الاتجاه (مسجّلة في السجل): إن كان الذهب هابطاً في الفترة فكل قاعدة بيع
تبدو عبقرية. العلاج: مقارنة نتيجة المؤشر بخط أساس «ادخل بيعاً على كل شمعة» في نفس
الشهر وبنفس الخطة. الفائض على خط الأساس هو المهارة الحقيقية.

    python3 sidesplit.py own_full.json [offset]
"""
import json, csv, sys, numpy as np
PU = 0.1
R = list(csv.DictReader(open('vault.csv')))
H = np.array([float(r['high']) for r in R]); L = np.array([float(r['low']) for r in R])
C = np.array([float(r['close']) for r in R]); N = len(R)
d = json.load(open(sys.argv[1]))
off = int(sys.argv[2]) if len(sys.argv) > 2 else (N - d['bars'])

# ── نتيجة المؤشر مفصولة بالجهة والشهر ──
by = {}
for eb, xb, side, win, tgt, stp, src in d['log']:
    i = off + int(eb)
    if i >= N: continue
    mo = R[i]['time'][:7]
    k = 'شراء' if side > 0 else 'بيع'
    a = by.setdefault(mo, {}).setdefault(k, [0, 0, 0.0, [], []])
    a[0] += 1; a[1] += win; a[2] += tgt if win else -stp
    a[3].append(tgt); a[4].append(stp)

# ── خط الأساس: كل شمعة، نفس الخطة المتوسطة، وقف زمني ٣٠ شمعة ──
AT = np.mean([t for m in by for k in by[m] for t in by[m][k][3]])
AS = np.mean([s for m in by for k in by[m] for s in by[m][k][4]])


def base_win(buy, tp, sl, maxb=30):
    ep = C
    tpp = ep + (tp * PU if buy else -tp * PU)
    slp = ep - (sl * PU if buy else -sl * PU)
    kind = np.zeros(N, np.int8)
    for k in range(1, maxb + 1):
        j = np.minimum(np.arange(N) + k, N - 1)
        alive = kind == 0
        hs = (L[j] <= slp) if buy else (H[j] >= slp)
        ht = (H[j] >= tpp) if buy else (L[j] <= tpp)
        s = alive & hs; t = alive & ht & ~hs
        kind[s] = 2; kind[t] = 1
    return kind


KB = base_win(True, AT, AS); KS = base_win(False, AT, AS)
mo_all = np.array([r['time'][:7] for r in R])
# نفس مرشّح الصلاحية المستخدم في البحث: خارج ساعة الإغلاق وبلا فجوات
import datetime as _dt
_hr = np.array([int(r['time'][11:13]) for r in R])
_ts = np.array([_dt.datetime.fromisoformat(r['time']).timestamp() for r in R])
VALID = (_hr < 22) & ~np.concatenate([[True], np.diff(_ts) > 300])

print('خطة القياس: هدف %.1f / وقف %.1f  →  نقطة التعادل %.2f%%' % (AT, AS, 100 * AS / (AT + AS)))
print()
print('%-9s %-6s %7s %6s %8s %9s %10s %9s' %
      ('الشهر', 'جهة', 'صفقات', 'ربح', 'نسبة%', 'صافي', 'خط الأساس%', 'الفائض'))
print('─' * 74)
tot = {'شراء': [0, 0, 0.0, []], 'بيع': [0, 0, 0.0, []]}
for mo in sorted(by):
    sel = mo_all == mo
    for k in ('شراء', 'بيع'):
        if k not in by[mo]: continue
        n, w, net, tg, st = by[mo][k]
        kk = KB if k == 'شراء' else KS
        b = kk[sel & VALID]
        bw = (b == 1).sum(); bl = (b == 2).sum()
        bwr = 100 * bw / max(bw + bl, 1)
        wr = 100 * w / n
        print('%-9s %-6s %7d %6d %7.2f%% %+9.0f %9.2f%% %+8.2f' %
              (mo, k, n, w, wr, net, bwr, wr - bwr))
        t = tot[k]; t[0] += n; t[1] += w; t[2] += net; t[3].append(wr - bwr)
    print()
print('─' * 74)
for k in ('شراء', 'بيع'):
    n, w, net, ex = tot[k]
    if not n: continue
    kk = KB if k == 'شراء' else KS
    bw = ((kk == 1) & VALID).sum(); bl = ((kk == 2) & VALID).sum()
    bwr = 100 * bw / max(bw + bl, 1)
    print('%-9s %-6s %7d %6d %7.2f%% %+9.0f %9.2f%% %+8.2f   (فائض موجب في %d من %d شهر)'
          % ('الكل', k, n, w, 100 * w / n, net, bwr, 100 * w / n - bwr,
             sum(1 for x in ex if x > 0), len(ex)))
