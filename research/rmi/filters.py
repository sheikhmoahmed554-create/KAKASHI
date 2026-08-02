"""البحث عن أفضل فلتر يعمل مع المؤشر، مصنَّفاً بعائلات.

الفلتر لا يفتح صفقات، بل يمنعها. فالسؤال ليس «كم ربح» بل: هل ما بقي بعد المنع
أفضل مما كان بما يكفي ليعوّض الصفقات الضائعة؟ ولذلك يُقاس بثلاثة أشياء معاً:
الزيادة فوق العشوائي، والتوقّع لكل صفقة، وكم صفقة بقيت.

يُمسح كل فلتر مفرداً ثم كل زوج ثم الثلاثيات الواعدة، ويُختبر الأفضل خارج
السنوات التي اختير عليها — لأن مسح مئات التركيبات يضمن أن تبدو إحداها ممتازة
بالصدفة وحدها.

    python3 filters.py
"""
import itertools
import json

import numpy as np

import comb

YEARS = comb.YEARS

# تصنيف المصادر بعائلات، فالسؤال «أي نوع نظام يفيد» لا «أي متغيّر»
FAMILY = {
    'ارتداد وانعكاس': ['Bb', 'Kw', 'Vfx', 'Mtx', 'Lux', 'Aa', 'Rsi'],
    'تتبّع ترند':     ['Ma', 'Ichi', 'Sar', 'Adx', 'Macd', 'M4c', 'Qqe'],
    'كنس سيولة':      ['Str', 'Brt', 'Sr', 'Smb'],
    'زخم وضغط':       ['Mis', 'Sqz', 'Fib', 'Pivot', 'Vol'],
}
FAM_OF = {s: f for f, ss in FAMILY.items() for s in ss}


def agg(DATA, cfg, years):
    rs = {y: comb.run(DATA[y], cfg) for y in years}
    if any(r is None for r in rs.values()):
        return None
    w = sum(r['wins'] for r in rs.values())
    l = sum(r['losses'] for r in rs.values())
    n = w + l
    if n == 0:
        return None
    net = sum(r['net'] for r in rs.values())
    lift = sum(r['lift'] * r['trades'] for r in rs.values()) / n
    se = 100.0 * np.sqrt(0.35 * 0.65 / n)
    return {'trades': n, 'win_rate': 100.0 * w / n, 'net': net, 'per_trade': net / n,
            'lift': lift, 'sigma': lift / se,
            'pos_years': sum(1 for r in rs.values() if r['net'] > 0),
            'per_day': float(np.mean([r['per_day'] for r in rs.values()]))}


def main():
    DATA = {y: comb.load(y) for y in YEARS}
    base = agg(DATA, {}, YEARS)
    print(f"╔══ خط الأساس ══╗")
    print(f"  {base['trades']:,} صفقة • {base['per_day']:.1f}/يوم • فوز {base['win_rate']:.2f}% • "
          f"صافي {base['net']:+,.0f} • {base['per_trade']:+.3f}/صفقة • "
          f"زيادة {base['lift']:+.2f} ({base['sigma']:+.2f}σ)")
    print("\nالفلتر يمنع ولا يضيف، فالحكم عليه: هل بقي أقل وأفضل بما يكفي؟\n")

    SRC = comb.SOURCES
    singles = []
    for s in SRC:
        a = agg(DATA, {s: 'Filter'}, YEARS)
        if a and a['trades'] >= 300:
            a['name'] = s
            a['keep'] = 100.0 * a['trades'] / base['trades']
            singles.append(a)

    def show(title, rows, n=15):
        print(f"\n═══ {title} ═══")
        print(f"{'الفلتر':>18}{'العائلة':>16}{'صفقات':>8}{'أبقى%':>7}{'/يوم':>6}"
              f"{'فوز%':>7}{'زيادة':>8}{'σ':>7}{'/صفقة':>8}{'موجبة':>7}")
        for r in rows[:n]:
            fam = FAM_OF.get(r['name'].split('+')[0], '—') if '+' not in r['name'] else 'مركّب'
            print(f"{r['name']:>18}{fam:>16}{r['trades']:>8}{r['keep']:>7.0f}"
                  f"{r['per_day']:>6.1f}{r['win_rate']:>7.2f}{r['lift']:>+8.2f}"
                  f"{r['sigma']:>+7.2f}{r['per_trade']:>+8.3f}{r['pos_years']:>7}")

    show("فلاتر مفردة — مرتّبة بالتوقّع لكل صفقة", sorted(singles, key=lambda r: -r['per_trade']))

    print(f"\n═══ متوسط أداء كل عائلة كفلتر ═══")
    print(f"{'العائلة':>16}{'عدد':>6}{'متوسط الزيادة':>15}{'متوسط /صفقة':>14}{'أفضل عضو':>12}")
    for fam, members in FAMILY.items():
        ms = [r for r in singles if r['name'] in members]
        if not ms:
            continue
        best = max(ms, key=lambda r: r['per_trade'])
        print(f"{fam:>16}{len(ms):>6}{np.mean([r['lift'] for r in ms]):>+15.2f}"
              f"{np.mean([r['per_trade'] for r in ms]):>+14.3f}{best['name']:>12}")

    # ── أزواج الفلاتر ────────────────────────────────────────────────────────
    print(f"\nمسح {len(SRC)*(len(SRC)-1)//2} زوجاً…", flush=True)
    pairs = []
    for a, b in itertools.combinations(SRC, 2):
        r = agg(DATA, {a: 'Filter', b: 'Filter'}, YEARS)
        if r and r['trades'] >= 300:
            r['name'] = f'{a}+{b}'
            r['keep'] = 100.0 * r['trades'] / base['trades']
            r['members'] = (a, b)
            pairs.append(r)
    show("أزواج الفلاتر — بالتوقّع", sorted(pairs, key=lambda r: -r['per_trade']), 12)
    show("أزواج الفلاتر — بالزيادة فوق العشوائي", sorted(pairs, key=lambda r: -r['sigma']), 12)

    # ── ثلاثيات من أفضل الأزواج ──────────────────────────────────────────────
    top_pairs = sorted(pairs, key=lambda r: -r['per_trade'])[:12]
    seeds = set()
    for r in top_pairs:
        seeds |= set(r['members'])
    trips = []
    for combo in itertools.combinations(sorted(seeds), 3):
        r = agg(DATA, {x: 'Filter' for x in combo}, YEARS)
        if r and r['trades'] >= 300:
            r['name'] = '+'.join(combo)
            r['keep'] = 100.0 * r['trades'] / base['trades']
            r['members'] = combo
            trips.append(r)
    show(f"ثلاثيات ({len(trips)} تركيبة) — بالتوقّع", sorted(trips, key=lambda r: -r['per_trade']), 10)

    # ── الحكم: ترك سنة خارج الاختيار ────────────────────────────────────────
    pool = singles + pairs + trips
    print(f"\n═══ الحكم — يُختار أفضل فلتر على ثلاث سنوات ويُقاس على الرابعة ═══")
    print(f"  المجموعة المرشَّحة: {len(pool)} تركيبة")
    print(f"{'المتروكة':>10}{'المختار':>20}{'تدريب/صفقة':>13}{'اختبار/صفقة':>13}"
          f"{'اختبار صافي':>13}{'أساس':>10}{'الفرق':>10}")
    tp = tb = 0.0
    picks = []
    for held in YEARS:
        tr = [y for y in YEARS if y != held]
        best, bv = None, None
        for r in pool:
            names = r['name'].split('+')
            a = agg(DATA, {x: 'Filter' for x in names}, tr)
            if a and a['trades'] >= 225 and (bv is None or a['per_trade'] > bv['per_trade']):
                best, bv = names, a
        t = agg(DATA, {x: 'Filter' for x in best}, [held])
        b = agg(DATA, {}, [held])
        tp += t['net']; tb += b['net']
        picks.append('+'.join(best))
        print(f"{held:>10}{'+'.join(best):>20}{bv['per_trade']:>13.3f}"
              f"{t['per_trade']:>13.3f}{t['net']:>13.0f}{b['net']:>10.0f}"
              f"{t['net']-b['net']:>+10.0f}")
    print(f"\n  المجموع خارج العيّنة: الفلتر {tp:+,.0f} • بلا فلتر {tb:+,.0f} • "
          f"الفرق {tp-tb:+,.0f}")
    print(f"  المختار في كل مرة: {', '.join(picks)}"
          f"{'   — ثابت' if len(set(picks)) == 1 else '   — غير ثابت'}")

    json.dump([{k: (float(v) if isinstance(v, (int, float, np.floating)) else v)
                for k, v in r.items() if k != 'members'} for r in pool],
              open('filter_report.json', 'w'), indent=1, ensure_ascii=False)
    print("\nكُتب filter_report.json")


if __name__ == '__main__':
    main()
