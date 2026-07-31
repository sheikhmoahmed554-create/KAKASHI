"""نافذة المحرك: في أي حالة سوق يربح المؤشر، وفي أيها يخسر.

    PYTHONPATH=research/tools python3 research/tools/engine_window.py <الخرج.json>

المحرك ليس مؤشراً إضافياً — هو **جدول أذونات**. يقرأ حالة السوق عند كل شمعة
من أربعة أبعاد مقاسة، ثم يقول للمؤشر: في هذه الحالة يُسمح بالشراء، وفي تلك
يُمنع، وفي ثالثة يُصمت تماماً.

الأبعاد الأربعة، كلها من المفاهيم التي صمدت في الكتالوج:
  السرعة   ATR بالنقاط — هل الحركة تكفي لهدف ٣٠–٦٠؟
  النظام   ATR الحالي ÷ ATR البعيد — انكماش أم توسع؟
  الاتجاه  انحدار ١٢٠ شمعة بمضاعف ATR
  الزخم    موضع السعر في نطاق ٦٠ شمعة — تشبع بيعي أم شرائي؟

الحكم على كل حالة: نتيجة صفقات المؤشر الفعلية التي فُتحت فيها.
"""
import base64
import csv
import datetime
import glob
import gzip
import io
import json
import re
import sys
from collections import defaultdict

import numpy as np

FIELDS = ['entry_time', 'side', 'outcome', 'points', 'target', 'stop',
          'source', 'sc', 'kind', 'ep', 'xt']
MIN_CELL = 60


def page_bars():
    page = open('KAKASHI_V16_TV_PARITY_AUDIT.html', encoding='utf-8').read()
    raw = gzip.decompress(base64.b64decode(
        re.search(r"BUILTIN_2026_GZ_B64='([^']*)'", page).group(1))).decode()
    t, h, l, c = [], [], [], []
    for r in csv.DictReader(io.StringIO(raw)):
        t.append(r['time']); h.append(float(r['high']))
        l.append(float(r['low'])); c.append(float(r['close']))
    return t, np.array(h), np.array(l), np.array(c)


def state_axes(t, h, l, c):
    """الأبعاد الأربعة للحالة، محسوبة على كل شمعة."""
    n = len(c)
    pc = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    atr = np.empty(n); atr[0] = tr[0]
    for i in range(1, n):
        atr[i] = tr[i] / 14. + atr[i - 1] * 13 / 14.
    atr /= 0.1
    A = np.maximum(atr, 1e-9)
    long_atr = np.convolve(atr, np.ones(240) / 240, mode='full')[:n]
    regime = atr / np.maximum(long_atr, 1e-9)
    back = np.concatenate([np.full(120, np.nan), c[:-120]])
    slope = ((c - back) / 0.1) / A
    from numpy.lib.stride_tricks import sliding_window_view
    hi = np.full(n, np.nan); lo = np.full(n, np.nan)
    hi[59:] = sliding_window_view(h, 60).max(1)
    lo[59:] = sliding_window_view(l, 60).min(1)
    pos = 100 * (c - lo) / np.maximum(hi - lo, 1e-9)
    return atr, regime, slope, pos


def bucket(x, edges, names):
    out = np.full(len(x), '—', dtype=object)
    for i, (a, b) in enumerate(zip(edges[:-1], edges[1:])):
        out[(x >= a) & (x < b)] = names[i]
    return out


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else 'research/results/engine.json'
    t, h, l, c = page_bars()
    atr, regime, slope, pos = state_axes(t, h, l, c)
    idx = {datetime.datetime.fromisoformat(x).timestamp(): i for i, x in enumerate(t)}

    speed = bucket(atr, [0, 15, 25, 40, 1e9], ['بطيء', 'متوسط', 'سريع', 'عنيف'])
    reg = bucket(regime, [0, 0.8, 1.2, 1e9], ['انكماش', 'عادي', 'توسع'])
    trend = bucket(slope, [-1e9, -3, 3, 1e9], ['هابط', 'عرضي', 'صاعد'])
    momo = bucket(pos, [0, 25, 75, 101], ['تشبع بيعي', 'وسط', 'تشبع شرائي'])

    seen = {}
    for p in sorted(glob.glob('research/results/seg/base_s*_trades.json.gz')):
        for r in json.loads(gzip.open(p).read()):
            d = dict(zip(FIELDS, r))
            seen[d['entry_time']] = d
    rows = []
    for d in seen.values():
        ts = datetime.datetime.fromisoformat(d['entry_time'].replace('Z', '+00:00')).timestamp()
        i = idx.get(ts)
        if i is None:
            continue
        rows.append((i, 1 if d['outcome'] == 'WIN' else 0,
                     float(d['points'] or 0), d['side']))
    bars = np.array([r[0] for r in rows])
    win = np.array([r[1] for r in rows])
    pts = np.array([r[2] for r in rows])
    sd = np.array([r[3] for r in rows])
    base = 100.0 * win.mean()
    print(f'{len(rows)} صفقة • نسبة الربح العامة {base:.2f}%\n')

    def table(axis, name, arr):
        print(f'### حسب {name}\n')
        print(f"{name:<16}{'فتح':>7}{'ربح':>7}{'خسر':>7}{'النسبة':>9}{'نقاط/صفقة':>12}")
        res = {}
        for k in sorted(set(axis[bars])):
            m = axis[bars] == k
            if m.sum() < MIN_CELL:
                continue
            w = int(win[m].sum())
            res[k] = {'trades': int(m.sum()), 'wins': w, 'losses': int(m.sum()) - w,
                      'win_rate': round(100.0 * w / m.sum(), 2),
                      'per_trade': round(float(pts[m].mean()), 3)}
            print(f"{k:<16}{m.sum():>7}{w:>7}{int(m.sum()) - w:>7}"
                  f"{100.0 * w / m.sum():>8.2f}%{pts[m].mean():>+12.2f}")
        print()
        return res

    rep = {'baseline_win_rate': round(base, 2), 'trades': len(rows), 'axes': {}}
    for nm, arr in (('السرعة', speed), ('النظام', reg), ('الاتجاه', trend), ('الزخم', momo)):
        rep['axes'][nm] = table(arr, nm, arr)

    # الجدول المركّب: السرعة × الاتجاه × الجهة — قلب المحرك
    print('### جدول الأذونات: السرعة × الاتجاه × الجهة\n')
    print(f"{'السرعة':<10}{'الاتجاه':<10}{'الجهة':<7}{'فتح':>7}{'ربح':>7}{'خسر':>7}{'النسبة':>9}{'الحكم':>12}")
    perm = {}
    for s in ('بطيء', 'متوسط', 'سريع', 'عنيف'):
        for tr_ in ('هابط', 'عرضي', 'صاعد'):
            for side in ('BUY', 'SELL'):
                m = (speed[bars] == s) & (trend[bars] == tr_) & (sd == side)
                if m.sum() < MIN_CELL:
                    continue
                w = int(win[m].sum())
                wr = 100.0 * w / m.sum()
                verdict = 'مسموح' if wr >= base + 1 else 'ممنوع' if wr <= base - 1 else 'محايد'
                perm[f'{s}|{tr_}|{side}'] = {'trades': int(m.sum()), 'wins': w,
                                             'losses': int(m.sum()) - w,
                                             'win_rate': round(wr, 2), 'verdict': verdict}
                print(f"{s:<10}{tr_:<10}{side:<7}{m.sum():>7}{w:>7}{int(m.sum()) - w:>7}"
                      f"{wr:>8.2f}%{verdict:>12}")
    rep['permissions'] = perm
    json.dump(rep, open(out_path, 'w'), ensure_ascii=False, indent=1)
    ok = sum(1 for v in perm.values() if v['verdict'] == 'مسموح')
    no = sum(1 for v in perm.values() if v['verdict'] == 'ممنوع')
    print(f'\n{len(perm)} حالة • {ok} مسموحة • {no} ممنوعة → {out_path}')


if __name__ == '__main__':
    main()
