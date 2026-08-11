"""جدول الأذونات، مبنيّاً هذه المرة كما يجب: ضبط على نصف واختبار على الآخر.

    PYTHONPATH=research/tools python3 research/tools/engine_cv.py

المحاولة الأولى (`engine_window.py`) بُنيت من بيانات ٢٠٢٦ وحدها ثم قُيّمت على
العيّنة نفسها، فأعطت ٦٤.٠٠٪ ثم انهارت على ١٣ شهراً. الخطأ لم يكن في الفكرة بل
في المنهج، فهذا الملف يصلح المنهج:

  ١ — يقرأ **دفتر صفقات المؤشر الفعلي** على ١٣ شهراً، لا عيّنة سنة.
  ٢ — يقيس كل قاعدة منع في ٢٠٢٥-ح٢ و٢٠٢٦ **منفصلين**.
  ٣ — لا يقبل قاعدة إلا إن وفّرت نقاطاً في النصفين معاً.

والمقياس نقاط لا نسبة. درس التجربة ٠٤٦: قاعدة رفعت النسبة وأنقصت النقاط، وأخرى
أنقصت النسبة وزادت النقاط ألفاً وأربعمئة — لأن الأولى حذفت أرباحاً صغيرة كثيرة
والثانية حذفت خسائر كبيرة قليلة. من ينظر إلى النسبة وحدها يختار الخاسرة.

المرشّح هنا **يمنع فقط**، فأثره يساوي بالضبط مجموع نقاط الصفقات التي يحذفها.
القاعدة النافعة تحذف مجموعاً سالباً — في النصفين.
"""
import csv
import gzip
import itertools
import json

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

PU = 0.1
SPLIT = '2026-01-01'
LEDGER = ['research/results/current/w2a_trades.jsonl',
          'research/results/current/w2c_trades.jsonl']
MIN_CUT = 60          # أقل عدد صفقات محذوفة في كل نصف حتى تُصدَّق القاعدة


def bars(lo, hi):
    t, o, h, l, c, v = [], [], [], [], [], []
    with gzip.open('research/data/vault_utc.csv.gz', 'rt') as f:
        for r in csv.DictReader(f):
            if not (lo <= r['time'][:10] <= hi):
                continue
            t.append(r['time'][:16])
            o.append(float(r['open'])); h.append(float(r['high']))
            l.append(float(r['low'])); c.append(float(r['close'])); v.append(float(r['volume']))
    return t, *(np.array(x) for x in (o, h, l, c, v))


def axes(t, o, h, l, c, v):
    n = len(c)
    pc = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    atr = np.empty(n); atr[0] = tr[0]
    for i in range(1, n):
        atr[i] = tr[i] / 14. + atr[i - 1] * 13 / 14.
    atr /= PU
    A = np.maximum(atr, 1e-9)
    rng = np.maximum(h - l, 1e-9)
    long_atr = np.convolve(atr, np.ones(240) / 240, mode='full')[:n]
    back = np.concatenate([np.full(120, np.nan), c[:-120]])
    hi60 = np.full(n, np.nan); lo60 = np.full(n, np.nan)
    hi60[59:] = sliding_window_view(h, 60).max(1)
    lo60[59:] = sliding_window_view(l, 60).min(1)
    delta = np.diff(c, prepend=c[0])
    ag = np.empty(n); al = np.empty(n); ag[0] = al[0] = 0.
    for i in range(1, n):
        ag[i] = max(delta[i], 0.) / 14. + ag[i - 1] * 13 / 14.
        al[i] = max(-delta[i], 0.) / 14. + al[i - 1] * 13 / 14.
    rsi = 100 - 100 / (1 + ag / np.maximum(al, 1e-12))
    return {
        'السرعة': atr,
        'النظام': atr / np.maximum(long_atr, 1e-9),
        'الاتجاه': ((c - back) / PU) / A,
        'الموضع': 100 * (c - lo60) / np.maximum(hi60 - lo60, 1e-9),
        'الزخم': rsi,
        'مدى الشمعة': (rng / PU) / A,
        'موضع الإغلاق': 100 * (c - l) / rng,
        'الحجم': v / np.maximum(np.convolve(v, np.ones(60) / 60, mode='full')[:n], 1e-9),
        'الساعة': np.array([float(x[11:13]) for x in t]),
    }


CUTS = {
    'السرعة': [0, 12, 18, 25, 35, 1e9],
    'النظام': [0, 0.7, 0.9, 1.1, 1.4, 1e9],
    'الاتجاه': [-1e9, -8, -3, 3, 8, 1e9],
    'الموضع': [0, 15, 35, 65, 85, 101],
    'الزخم': [0, 35, 45, 55, 65, 101],
    'مدى الشمعة': [0, 0.6, 0.9, 1.3, 1e9],
    'موضع الإغلاق': [0, 25, 50, 75, 101],
    'الحجم': [0, 0.55, 0.9, 1.3, 1e9],
    'الساعة': [0, 5, 11, 17, 20, 24],
}


def main():
    rows = []
    for p in LEDGER:
        for ln in open(p):
            ln = ln.strip()
            if ln:
                rows.append(json.loads(ln))
    rows.sort(key=lambda r: r[0])
    t, o, h, l, c, v = bars(rows[0][0][:10], rows[-1][0][:10])
    idx = {x: i for i, x in enumerate(t)}
    F = axes(t, o, h, l, c, v)

    bi, sd, pts, hf = [], [], [], []
    miss = 0
    for r in rows:
        # الخزنة تكتب «٢٠٢٥-٠٧-٠١ ٠٠:٠٥» والدفتر يكتبها بصيغة ISO — نوحّدهما
        k = r[0][:16].replace('T', ' ')
        i = idx.get(k)
        if i is None:
            miss += 1
            continue
        bi.append(i); sd.append(1 if r[1] == 'BUY' else -1)
        pts.append(float(r[3] or 0)); hf.append(1 if r[0][:10] >= SPLIT else 0)
    bi = np.array(bi); sd = np.array(sd); pts = np.array(pts); hf = np.array(hf)
    n1, n2 = int((hf == 0).sum()), int((hf == 1).sum())
    p1, p2 = pts[hf == 0].sum(), pts[hf == 1].sum()
    w1 = 100.0 * (pts[hf == 0] > 0).mean(); w2 = 100.0 * (pts[hf == 1] > 0).mean()
    print(f'{len(bi)} صفقة ({miss} بلا شمعة مطابقة)\n'
          f'٢٠٢٥-ح٢: {n1} صفقة • {w1:.2f}٪ • {p1:+.0f} نقطة\n'
          f'٢٠٢٦:    {n2} صفقة • {w2:.2f}٪ • {p2:+.0f} نقطة\n')

    # كل قاعدة: امنع هذه الجهة عندما يقع هذا البُعد في هذه الشريحة
    cands = []
    for name, edges in CUTS.items():
        x = F[name][bi]
        for a, b in zip(edges[:-1], edges[1:]):
            m = (x >= a) & (x < b) & np.isfinite(x)
            for side, sname in ((1, 'شراء'), (-1, 'بيع')):
                cands.append((f'امنع ال{sname} عند {name} [{a:g}→{b:g}]', m & (sd == side)))

    def score(mask):
        a, b = mask & (hf == 0), mask & (hf == 1)
        return int(a.sum()), int(b.sum()), pts[a].sum(), pts[b].sum()

    passed = []
    for nm, m in cands:
        ka, kb, pa, pb = score(m)
        if ka < MIN_CUT or kb < MIN_CUT or pa >= 0 or pb >= 0:
            continue
        passed.append({'rule': nm, 'cut_h2': ka, 'cut_26': kb,
                       'saved_h2': round(-pa, 1), 'saved_26': round(-pb, 1),
                       'saved': round(-(pa + pb), 1)})
    passed.sort(key=lambda r: -min(r['saved_h2'], r['saved_26']))
    print(f'### قواعد مفردة نافعة في النصفين معاً: {len(passed)} من {len(cands)}\n')
    print(f"{'القاعدة':<46}{'تحذف ٢٥':>9}{'توفّر':>9}{'تحذف ٢٦':>9}{'توفّر':>9}")
    for r in passed[:25]:
        print(f"{r['rule'][:45]:<46}{r['cut_h2']:>9}{r['saved_h2']:>9.0f}"
              f"{r['cut_26']:>9}{r['saved_26']:>9.0f}")

    # ثم الأزواج: قاعدتان معاً على بُعدين مختلفين
    print('\n### أزواج (بُعدان مختلفان، نفس الجهة)\n')
    pairs = []
    byname = {nm: m for nm, m in cands}
    top = [r['rule'] for r in passed[:14]]
    for a, b in itertools.combinations(top, 2):
        if a.split(' عند ')[0] != b.split(' عند ')[0]:
            continue                                  # الجهة نفسها فقط
        if a.split(' عند ')[1].split(' [')[0] == b.split(' عند ')[1].split(' [')[0]:
            continue                                  # لا يجتمع بُعد مع نفسه
        m = byname[a] & byname[b]
        ka, kb, pa, pb = score(m)
        if ka < MIN_CUT or kb < MIN_CUT or pa >= 0 or pb >= 0:
            continue
        pairs.append({'rule': a + '  +  ' + b.split(' عند ')[1],
                      'cut_h2': ka, 'cut_26': kb,
                      'saved_h2': round(-pa, 1), 'saved_26': round(-pb, 1)})
    pairs.sort(key=lambda r: -min(r['saved_h2'], r['saved_26']))
    print(f"{'القاعدة':<62}{'تحذف ٢٥':>9}{'توفّر':>9}{'تحذف ٢٦':>9}{'توفّر':>9}")
    for r in pairs[:15]:
        print(f"{r['rule'][:61]:<62}{r['cut_h2']:>9}{r['saved_h2']:>9.0f}"
              f"{r['cut_26']:>9}{r['saved_26']:>9.0f}")

    # المحصّلة: اتحاد أفضل القواعد المفردة، بلا تكرار حذف
    print('\n### الاتحاد التراكمي — كل قاعدة تُضاف تُقاس على ما تبقّى\n')
    print(f"{'بعد إضافة':<46}{'المتبقي ٢٥':>11}{'نقاط ٢٥':>10}{'المتبقي ٢٦':>11}{'نقاط ٢٦':>10}")
    blocked = np.zeros(len(bi), bool)
    chosen = []
    for r in passed:
        m = byname[r['rule']] & ~blocked
        ka, kb, pa, pb = score(m)
        if ka < MIN_CUT or kb < MIN_CUT or pa >= 0 or pb >= 0:
            continue
        blocked |= byname[r['rule']]
        chosen.append(r['rule'])
        ra, rb = ~blocked & (hf == 0), ~blocked & (hf == 1)
        print(f"{r['rule'][:45]:<46}{int(ra.sum()):>11}{pts[ra].sum():>+10.0f}"
              f"{int(rb.sum()):>11}{pts[rb].sum():>+10.0f}")
    json.dump({'baseline': {'h2_2025': [n1, round(p1, 1)], '2026': [n2, round(p2, 1)]},
               'singles': passed, 'pairs': pairs, 'chosen': chosen},
              open('research/results/engine_cv.json', 'w'), ensure_ascii=False, indent=1)
    print('\n→ research/results/engine_cv.json')


if __name__ == '__main__':
    main()
