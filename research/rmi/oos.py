"""الاختبار الحاسم: هل يصمد المصدر خارج السنوات التي اختير عليها؟

قِسنا ٤١ تركيبة، فواحدة أو اثنتان ستبدوان جيدتين بالصدفة وحدها. الطريقة الوحيدة
للتفريق هي ترك سنة كاملة خارج الاختيار ثم القياس عليها — وهي الطريقة نفسها التي
أسقطت فكرة تبديل الإعدادات حسب نوع السوق سابقاً.

يُقاس أيضاً تجميع أفضل المصادر معاً، لأن مصدرين ضعيفين قد يجتمعان على شيء، وقد
يلغي أحدهما الآخر.
"""
import itertools
import json

import numpy as np

import comb

YEARS = comb.YEARS
TOP = ['Rsi', 'M4c', 'Bb', 'Brt', 'Mis', 'Adx', 'Fib', 'Smb']


def agg(DATA, cfg, years):
    rs = {y: comb.run(DATA[y], cfg) for y in years}
    if any(r is None for r in rs.values()):
        return None
    w = sum(r['wins'] for r in rs.values())
    l = sum(r['losses'] for r in rs.values())
    n = w + l
    net = sum(r['net'] for r in rs.values())
    lift = sum(r['lift'] * r['trades'] for r in rs.values()) / n
    se = 100.0 * np.sqrt(0.35 * 0.65 / n)
    return {'trades': n, 'win_rate': 100.0 * w / n, 'net': net, 'per_trade': net / n,
            'lift': lift, 'sigma': lift / se,
            'pos_years': sum(1 for r in rs.values() if r['net'] > 0)}


def main():
    DATA = {y: comb.load(y) for y in YEARS}

    print("═══ كل سنة على حدة — خط الأساس مقابل أفضل المصادر ═══")
    print(f"{'التركيبة':>14}" + "".join(f"{y:>11}" for y in YEARS) + f"{'المجموع':>11}")
    cfgs = [('RMI وحده', {})] + [(f'+ {s}', {s: 'Source'}) for s in TOP]
    for name, cfg in cfgs:
        nets = [comb.run(DATA[y], cfg)['net'] for y in YEARS]
        print(f"{name:>14}" + "".join(f"{v:>11.0f}" for v in nets) + f"{sum(nets):>11.0f}")

    print("\n═══ ترك سنة خارج الاختيار: يُختار الأفضل على ثلاث ويُقاس على الرابعة ═══")
    print(f"{'المتروكة':>10}{'المختار':>9}{'تدريب σ':>10}{'تدريب/صفقة':>12}"
          f"{'اختبار/صفقة':>13}{'اختبار صافي':>13}{'أساس السنة':>12}{'الفرق':>10}")
    tot_pick = tot_base = 0.0
    picks = []
    for held in YEARS:
        tr = [y for y in YEARS if y != held]
        best, best_v = None, None
        for s in TOP:
            a = agg(DATA, {s: 'Source'}, tr)
            if a and (best_v is None or a['per_trade'] > best_v['per_trade']):
                best, best_v = s, a
        t = comb.run(DATA[held], {best: 'Source'})
        b = comb.run(DATA[held], {})
        tot_pick += t['net']; tot_base += b['net']
        picks.append(best)
        print(f"{held:>10}{best:>9}{best_v['sigma']:>10.2f}{best_v['per_trade']:>12.3f}"
              f"{t['per_trade']:>13.3f}{t['net']:>13.0f}{b['net']:>12.0f}"
              f"{t['net']-b['net']:>+10.0f}")
    print(f"\n  مجموع السنوات المتروكة: المصدر المختار {tot_pick:+,.0f} • "
          f"الأساس {tot_base:+,.0f} • الفرق {tot_pick-tot_base:+,.0f}")
    print(f"  المصادر المختارة: {', '.join(picks)}"
          f"{'  — ثابت' if len(set(picks)) == 1 else '  — غير ثابت، وهذا وحده علامة ضجيج'}")

    print("\n═══ تثبيت RSI: أداؤه في كل سنة مقابل الأساس ═══")
    print(f"{'سنة':>7}{'صفقات':>8}{'/يوم':>7}{'فوز%':>8}{'عشوائي%':>10}{'زيادة':>8}"
          f"{'صافي':>9}{'أساس':>9}{'الفرق':>9}")
    for y in YEARS:
        r = comb.run(DATA[y], {'Rsi': 'Source'})
        b = comb.run(DATA[y], {})
        rnd = np.mean(comb.RND[y])
        print(f"{y:>7}{r['trades']:>8}{r['per_day']:>7.1f}{r['win_rate']:>8.2f}{rnd:>10.2f}"
              f"{r['lift']:>+8.2f}{r['net']:>9.0f}{b['net']:>9.0f}{r['net']-b['net']:>+9.0f}")

    print("\n═══ تجميع المصادر: هل تتراكم أم تتنافى؟ ═══")
    print(f"{'التركيبة':>22}{'صفقات':>8}{'/يوم':>7}{'فوز%':>8}{'زيادة':>8}{'σ':>7}"
          f"{'صافي':>9}{'موجبة':>7}")
    combos = [('Rsi',), ('Rsi', 'M4c'), ('Rsi', 'Mis'), ('Rsi', 'M4c', 'Mis'),
              ('Rsi', 'Brt'), ('Rsi', 'M4c', 'Brt'), ('Rsi', 'Adx'),
              ('Rsi', 'M4c', 'Mis', 'Adx')]
    rows = []
    for cb in combos:
        cfg = {s: 'Source' for s in cb}
        a = agg(DATA, cfg, YEARS)
        rows.append((cb, a))
        print(f"{'+'.join(cb):>22}{a['trades']:>8}{a['per_day'] if 'per_day' in a else 0:>7}"
              .replace('     0', '      ') +
              f"{a['win_rate']:>8.2f}{a['lift']:>+8.2f}{a['sigma']:>+7.2f}"
              f"{a['net']:>9.0f}{a['pos_years']:>7}")

    print("\n═══ ترك سنة على أفضل تجميع ═══")
    print(f"{'المتروكة':>10}{'المختار':>26}{'اختبار/صفقة':>13}{'اختبار صافي':>13}{'أساس':>10}{'الفرق':>10}")
    tp = tb = 0.0
    for held in YEARS:
        tr = [y for y in YEARS if y != held]
        best, bv = None, None
        for cb in combos:
            a = agg(DATA, {s: 'Source' for s in cb}, tr)
            if a and (bv is None or a['per_trade'] > bv['per_trade']):
                best, bv = cb, a
        t = comb.run(DATA[held], {s: 'Source' for s in best})
        b = comb.run(DATA[held], {})
        tp += t['net']; tb += b['net']
        print(f"{held:>10}{'+'.join(best):>26}{t['per_trade']:>13.3f}{t['net']:>13.0f}"
              f"{b['net']:>10.0f}{t['net']-b['net']:>+10.0f}")
    print(f"\n  المجموع خارج العيّنة: التجميع {tp:+,.0f} • الأساس {tb:+,.0f} • "
          f"الفرق {tp-tb:+,.0f}")

    json.dump({'note': 'volume is zero in 2021/2023/2025, so the Vol source is 2026-only'},
              open('oos_note.json', 'w'))


if __name__ == '__main__':
    main()
