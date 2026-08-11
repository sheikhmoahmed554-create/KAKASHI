"""محفظة قواعد الدخول: نبني محرّك دخول من قواعد لا تتداخل، كل صفقة بسببها.

    PYTHONPATH=research/tools python3 research/tools/escape4.py

القاعدة الواحدة تعطي ٢–٦ صفقات باليوم. المطلوب ٣٠. فالحل ليس تخفيف القاعدة
— تخفيفها يهبط بالنسبة — بل **جمع قواعد مختلفة لا تغطي نفس الشموع**.

الاختيار جشع (greedy) وصادق: في كل جولة نقيس كل مرشّح على الشموع التي **لم**
تغطّها القواعد المختارة بعد، ولا نقبله إلا إذا تجاوز التعادل في ٢٠٢٥-ح٢
و٢٠٢٦ معاً على تلك الشموع الجديدة وحدها. هكذا لا تُحسب قاعدة مرتين، ولا
تختبئ قاعدة ضعيفة خلف قوية.

ثم محاكاة متسلسلة واحدة: صفقة واحدة مفتوحة، دخول عند إغلاق شمعة الدقيقة،
مستويات مجمّدة، وكل صفقة مسجّل معها اسم القاعدة التي فتحتها — «ليش دخلنا».
"""
import itertools
import json

import numpy as np

from escape3 import SPLIT, conditions, features, load, resolve

SETUPS = [(30, 50), (40, 60), (60, 80)]
MIN_BARS = 1500          # للمرشّح قبل الاختيار
MIN_NEW_PER_DAY = 0.4    # لا نضيف قاعدة تعطي أقل من هذا
MAX_RULES = 20
MARGIN = 1.0             # يجب تجاوز التعادل بهذا القدر في النصفين


def quarters(t):
    q = []
    for x in t:
        y, m = int(x[:4]), int(x[5:7])
        q.append(f'{y}-ر{(m - 1) // 3 + 1}')
    return np.array(q)


def sequential(sig_side, res_b, ex_b, res_s, ex_s):
    """محاكاة متسلسلة على كل الشموع. sig_side: ٠ لا شيء، ١ شراء، -١ بيع.

    ترجع فهرس الدخول ونتيجته وجهته — الأساس لكل جدول بعدها.
    """
    n = len(sig_side)
    ent, out, sd = [], [], []
    i = 0
    while i < n:
        s = sig_side[i]
        if s == 0:
            i += 1
            continue
        r = res_b[i] if s == 1 else res_s[i]
        if r < 0:
            i += 1
            continue
        ent.append(i); out.append(int(r)); sd.append(int(s))
        i = int(ex_b[i] if s == 1 else ex_s[i]) + 1
    return np.array(ent, int), np.array(out, int), np.array(sd, int)


def main():
    t, o, h, l, c, v = load()
    n = len(c)
    F = features(t, o, h, l, c, v)
    C = conditions(F)
    ok = (np.arange(n) > 300) & np.isfinite(F['pos']) & np.isfinite(F['slope'])
    for k in C:
        C[k] = C[k] & ok
    half = np.array([1 if x[:10] >= SPLIT else 0 for x in t], np.int8)
    qs = quarters(t)
    d1 = len({x[:10] for x in t if x[:10] < SPLIT})
    d2 = len({x[:10] for x in t if x[:10] >= SPLIT})
    names = list(C)
    combos = ([(x,) for x in names]
              + list(itertools.combinations(names, 2))
              + list(itertools.combinations(names, 3)))
    masks = []
    for cb in combos:
        m = C[cb[0]].copy()
        for k in cb[1:]:
            m &= C[k]
        if m.sum() >= MIN_BARS:
            masks.append((' + '.join(cb), m))
    print(f'{n} شمعة • ٢٠٢٥-ح٢ {d1} يوم • ٢٠٢٦ {d2} يوم • {len(masks)} مرشّح\n')

    report = {}
    for tp, sl in SETUPS:
        be = 100.0 * sl / (tp + sl)
        rb, eb = resolve(h, l, c, tp, sl, 1)
        rs, es = resolve(h, l, c, tp, sl, -1)
        print(f'\n{"="*104}\n### هدف {tp} • ستوب {sl} • التعادل {be:.1f}٪\n')

        covered = np.zeros(n, bool)
        chosen = []
        for _ in range(MAX_RULES):
            best = None
            for name, m in masks:
                new = m & ~covered
                if new.sum() < MIN_BARS // 3:
                    continue
                for side, sname, r_ in ((1, 'شراء', rb), (-1, 'بيع', rs)):
                    a = new & (r_ >= 0) & (half == 0)
                    b = new & (r_ >= 0) & (half == 1)
                    na, nb = int(a.sum()), int(b.sum())
                    if na < 120 or nb < 120:
                        continue
                    wa = 100.0 * r_[a].mean()
                    wb = 100.0 * r_[b].mean()
                    if min(wa, wb) < be + MARGIN:
                        continue
                    if na / d1 < MIN_NEW_PER_DAY or nb / d2 < MIN_NEW_PER_DAY:
                        continue
                    # نرتّب بالنقاط المتوقعة اليومية من الشموع الجديدة وحدها
                    wr = (wa * na + wb * nb) / (na + nb) / 100.0
                    ev = wr * tp - (1 - wr) * sl
                    score = ev * (na + nb) / (d1 + d2)
                    if best is None or score > best[0]:
                        best = (score, name, side, sname, m, wa, wb, na, nb)
            if best is None:
                break
            _, name, side, sname, m, wa, wb, na, nb = best
            chosen.append({'rule': name, 'side': sname, 's': side, 'mask': m,
                           'new_h2': [na, round(wa, 2)], 'new_26': [nb, round(wb, 2)]})
            covered |= m
            print(f"+ {name[:56]:<58}{sname:>5}  جديد {na:>5}/{nb:<5}  "
                  f"{wa:>6.2f}٪ / {wb:>6.2f}٪")

        if not chosen:
            print('لا قاعدة تجاوزت الشرط')
            continue

        # إشارة موحّدة: أول قاعدة بالأولوية هي صاحبة الشمعة
        sig = np.zeros(n, np.int8)
        who = np.full(n, -1, int)
        for i, r in enumerate(chosen):
            take = (sig == 0) & r['mask']
            sig[take] = r['s']
            who[take] = i
        ent, out, sd = sequential(sig, rb, eb, rs, es)
        hf = half[ent]
        print(f'\n#### المحفظة كاملة — {len(chosen)} قاعدة\n')
        print(f"{'الفترة':<14}{'فتح':>8}{'ربح':>7}{'خسر':>7}{'النسبة':>9}{'/يوم':>7}{'صافي نقاط':>12}")
        rows = {}
        for lbl, m, days in (('٢٠٢٥-ح٢', hf == 0, d1), ('٢٠٢٦', hf == 1, d2),
                             ('الكل', np.ones(len(ent), bool), d1 + d2)):
            k = int(m.sum()); w = int(out[m].sum())
            net = w * tp - (k - w) * sl
            rows[lbl] = {'trades': k, 'wins': w, 'losses': k - w,
                         'win_rate': round(100.0 * w / max(k, 1), 2),
                         'per_day': round(k / days, 1), 'net_points': int(net)}
            print(f"{lbl:<14}{k:>8}{w:>7}{k - w:>7}{100.0 * w / max(k, 1):>8.2f}٪"
                  f"{k / days:>7.1f}{net:>12}")

        print(f'\n#### الثبات ربعاً بربع\n')
        print(f"{'الربع':<12}{'فتح':>8}{'ربح':>7}{'خسر':>7}{'النسبة':>9}{'/يوم':>7}")
        qrep = {}
        for q in sorted(set(qs)):
            m = qs[ent] == q
            k = int(m.sum())
            if k < 30:
                continue
            w = int(out[m].sum())
            dq = len({x[:10] for x, qq in zip(t, qs) if qq == q})
            qrep[q] = {'trades': k, 'wins': w, 'losses': k - w,
                       'win_rate': round(100.0 * w / k, 2), 'per_day': round(k / dq, 1)}
            print(f"{q:<12}{k:>8}{w:>7}{k - w:>7}{100.0 * w / k:>8.2f}٪{k / dq:>7.1f}")

        print(f'\n#### من أين جاءت الصفقات — «ليش دخلنا»\n')
        print(f"{'القاعدة':<58}{'الجهة':>6}{'فتح':>7}{'ربح':>7}{'خسر':>7}{'النسبة':>9}")
        att = {}
        for i, r in enumerate(chosen):
            m = who[ent] == i
            k = int(m.sum())
            if not k:
                continue
            w = int(out[m].sum())
            att[r['rule'] + ' | ' + r['side']] = {
                'trades': k, 'wins': w, 'losses': k - w,
                'win_rate': round(100.0 * w / k, 2)}
            print(f"{r['rule'][:57]:<58}{r['side']:>6}{k:>7}{w:>7}{k - w:>7}"
                  f"{100.0 * w / k:>8.2f}٪")
        report[f'{tp}/{sl}'] = {
            'breakeven': round(be, 2),
            'rules': [{kk: vv for kk, vv in r.items() if kk != 'mask'} for r in chosen],
            'totals': rows, 'quarters': qrep, 'attribution': att}
        json.dump(report, open('research/results/escape4.json', 'w'),
                  ensure_ascii=False, indent=1)
    print('\n→ research/results/escape4.json')


if __name__ == '__main__':
    main()
