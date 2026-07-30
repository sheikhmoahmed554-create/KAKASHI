"""مسح خطط الخروج على إشارات SYR30 الخام، بقيود صاحب المشروع.

    python3 research/tools/plansweep.py signals.json [الخرج.json]

القيود: الهدف ٣٠ فأكثر، والوقف لا يزيد عن الهدف + ٢٠. صفقة واحدة مفتوحة في المرة.
عند تصادم الهدف والوقف في نفس الشمعة يفوز الوقف — نفس قاعدة TradingView المستعملة في lab.py.

تنبيه على المنهج: قواعد التهدئة وما بعد الخسارة داخل المؤشر تعتمد على تاريخ الصفقات،
فهي تتغير مع الخطة ولا تدخل في هذه المحاكاة. الترتيب بين الخطط صالح لأن التقريب
واحد في كل الخطط، لكن الرقم النهائي لأي خطة يُثبَّت بتشغيل المحرك كاملاً.
"""
import csv
import datetime
import json
import sys

PU = 0.1                       # وحدة النقطة = ٠.١٠ دولار
TRAIN_END = datetime.datetime(2026, 5, 1, tzinfo=datetime.timezone.utc).timestamp()
MAX_HOLD = 240                 # أقصى مدة انتظار للحسم بالدقائق


def load_candles(path='research/tools/vault.csv'):
    rows = list(csv.DictReader(open(path)))
    return (
        [datetime.datetime.fromisoformat(r['time']).timestamp() for r in rows],
        [float(r['high']) for r in rows],
        [float(r['low']) for r in rows],
        [float(r['close']) for r in rows],
    )


def simulate(sig_side, t, h, l, c, tp_pts, sl_pts):
    """محاكاة تسلسلية: لا تُفتح صفقة جديدة قبل إغلاق الحالية."""
    tpd, sld = tp_pts * PU, sl_pts * PU
    n = len(c)
    free_at = -1
    out = []
    for i, side in sig_side:
        if i <= free_at or i >= n - 1:
            continue
        entry = c[i]
        if side == 1:
            tp, sl = entry + tpd, entry - sld
        else:
            tp, sl = entry - tpd, entry + sld
        end = min(i + 1 + MAX_HOLD, n)
        won = None
        for j in range(i + 1, end):
            if side == 1:
                if l[j] <= sl:
                    won = False
                    break
                if h[j] >= tp:
                    won = True
                    break
            else:
                if h[j] >= sl:
                    won = False
                    break
                if l[j] <= tp:
                    won = True
                    break
        if won is None:            # لم يُحسم داخل المدة — لا يُحتسب، والصفقة تُغلق
            free_at = end - 1
            continue
        free_at = j
        out.append((t[i], won))
    return out


def stats(trades, tp_pts, sl_pts):
    if not trades:
        return None
    wins = sum(1 for _, w in trades if w)
    net = wins * tp_pts - (len(trades) - wins) * sl_pts
    days = len({datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).date() for ts, _ in trades})
    breakeven = 100.0 * sl_pts / (tp_pts + sl_pts)
    wr = 100.0 * wins / len(trades)
    return {
        'trades': len(trades), 'win_rate': round(wr, 2),
        'breakeven': round(breakeven, 2), 'edge': round(wr - breakeven, 2),
        'net_points': round(net, 1), 'per_trade': round(net / len(trades), 3),
        'per_day': round(len(trades) / days, 1) if days else 0,
    }


def main():
    sig = json.load(open(sys.argv[1]))
    out_path = sys.argv[2] if len(sys.argv) > 2 else 'research/results/plansweep.json'
    t, h, l, c = load_candles()

    buy, sell = set(sig['buy']), set(sig['sell'])
    collisions = buy & sell            # إشارتان في نفس الشمعة — تُتخطى كما يفعل المؤشر
    sig_side = sorted([(i, 1) for i in buy - collisions] + [(i, -1) for i in sell - collisions])
    print(f"{len(sig_side)} إشارة صالحة ({len(collisions)} تصادم مُتخطى)")

    results = []
    for tp in range(30, 65, 5):
        for sl in range(20, tp + 21, 5):
            trades = simulate(sig_side, t, h, l, c, tp, sl)
            train = stats([x for x in trades if x[0] < TRAIN_END], tp, sl)
            test = stats([x for x in trades if x[0] >= TRAIN_END], tp, sl)
            if not train or not test:
                continue
            results.append({'tp': tp, 'sl': sl, 'train': train, 'test': test})
            print(f"TP{tp:>2}/SL{sl:>2}  تدريب {train['win_rate']:>5.2f}% حافة {train['edge']:>+6.2f}  "
                  f"اختبار {test['win_rate']:>5.2f}% حافة {test['edge']:>+6.2f}  "
                  f"{test['per_day']:>5.1f}/يوم  {test['per_trade']:>+7.3f} نقطة/صفقة")

    results.sort(key=lambda r: r['test']['per_trade'], reverse=True)
    json.dump(results, open(out_path, 'w'), ensure_ascii=False, indent=1)
    print('\nأفضل خمس خطط بالتوقّع خارج العينة:')
    for r in results[:5]:
        print(f"  TP{r['tp']}/SL{r['sl']}  {r['test']['win_rate']}%  "
              f"حافة {r['test']['edge']:+}  {r['test']['per_trade']:+} نقطة/صفقة  {r['test']['per_day']}/يوم")


if __name__ == '__main__':
    main()
