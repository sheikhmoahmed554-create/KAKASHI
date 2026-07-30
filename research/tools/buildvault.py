"""يوحّد كل ملفات الداتا في خزنة واحدة بتوقيت UTC حقيقي.

    python3 research/tools/buildvault.py <ملف> [<ملف> ...]

المشكلة التي يحلّها: الملفات تأتي بتوقيتات مختلفة، ولا واحد منها UTC فعلاً.
  • ملفات HistData (DAT_MT_...)   → توقيت نيويورك (ET)
  • ملف السيرفر (XAUUSD_M1_...)   → ET + ٧ ساعات، رغم أن ترويسته تقول +00:00

التوقيت لا يُفترض، يُستنتج من بنية السوق: الذهب يغلق ١٧:٠٠ ET ويفتح ١٨:٠٠ ET،
فآخر شمعة قبل الانقطاع اليومي تقع في الساعة ١٦ بتوقيت نيويورك. نقيس هذه الساعة
في كل ملف ونستنتج إزاحته، ثم نحوّل الجميع إلى UTC حقيقي بقواعد التوقيت الصيفي
الأمريكي — لأن السوق نفسه يتبعها.
"""
import bisect
import collections
import csv
import datetime
import gzip
import sys

ET_BREAK_HOUR = 16          # آخر شمعة قبل الانقطاع اليومي، بتوقيت نيويورك


def dst_bounds(year):
    """التوقيت الصيفي الأمريكي: من ثاني أحد في مارس إلى أول أحد في نوفمبر."""
    d = datetime.datetime(year, 3, 1)
    d += datetime.timedelta(days=(6 - d.weekday()) % 7 + 7)      # ثاني أحد
    start = d.replace(hour=2)
    d = datetime.datetime(year, 11, 1)
    d += datetime.timedelta(days=(6 - d.weekday()) % 7)          # أول أحد
    return start, d.replace(hour=2)


def et_to_utc(naive):
    """يحوّل وقت نيويورك إلى UTC مع مراعاة التوقيت الصيفي."""
    a, b = dst_bounds(naive.year)
    return naive + datetime.timedelta(hours=4 if a <= naive < b else 5)


def read_rows(path):
    """يقرأ الصيغتين: HistData بلا ترويسة، والصيغة ذات الترويسة."""
    out = []
    with open(path, newline='') as f:
        head = f.readline()
        f.seek(0)
        if head.lower().startswith('time,'):
            for r in csv.DictReader(f):
                t = datetime.datetime.fromisoformat(r['time']).replace(tzinfo=None)
                out.append([t, float(r['open']), float(r['high']), float(r['low']),
                            float(r['close']), float(r.get('volume') or 0),
                            float(r.get('spread') or 0)])
        else:
            for row in csv.reader(f):
                if len(row) < 6:
                    continue
                t = datetime.datetime.strptime(row[0] + ' ' + row[1], '%Y.%m.%d %H:%M')
                out.append([t, float(row[2]), float(row[3]), float(row[4]),
                            float(row[5]), float(row[6]) if len(row) > 6 else 0.0, 0.0])
    out.sort(key=lambda x: x[0])
    return out


def detect_offset(rows):
    """يستنتج إزاحة الملف عن توقيت نيويورك من ساعة الانقطاع اليومي."""
    hours = collections.Counter()
    for a, b in zip(rows, rows[1:]):
        gap = (b[0] - a[0]).total_seconds() / 60
        if 30 <= gap <= 180:
            hours[a[0].hour] += 1
    if not hours:
        return 0, 0
    top, n = hours.most_common(1)[0]
    return (top - ET_BREAK_HOUR) % 24, n


def main(paths):
    merged = {}
    for p in paths:
        rows = read_rows(p)
        off, n = detect_offset(rows)
        off = off - 24 if off > 12 else off
        span = f'{rows[0][0]:%Y-%m-%d} → {rows[-1][0]:%Y-%m-%d}'
        print(f'{p.split("/")[-1]:<44} {len(rows):>7} شمعة  {span}  '
              f'إزاحة عن ET: {off:+d} ساعة (من {n} انقطاع)')
        for r in rows:
            et = r[0] - datetime.timedelta(hours=off)
            merged[int(et_to_utc(et).replace(tzinfo=datetime.timezone.utc).timestamp())] = r[1:]

    keys = sorted(merged)
    print(f'\n{len(keys)} شمعة فريدة بعد الدمج وإزالة التكرار')
    out = 'research/data/vault_utc.csv.gz'
    with gzip.open(out, 'wt', newline='') as f:
        w = csv.writer(f)
        w.writerow(['time', 'open', 'high', 'low', 'close', 'volume', 'spread'])
        for k in keys:
            t = datetime.datetime.fromtimestamp(k, datetime.timezone.utc)
            w.writerow([t.strftime('%Y-%m-%d %H:%M:%S+00:00')] + merged[k])

    # تحقق: ساعة الانقطاع اليومي بعد التحويل يجب أن تتبع ٢١ صيفاً و٢٢ شتاءً
    hours = collections.Counter()
    for a, b in zip(keys, keys[1:]):
        if 1800 <= b - a <= 10800:
            hours[datetime.datetime.fromtimestamp(a, datetime.timezone.utc).hour] += 1
    print('ساعة آخر شمعة قبل الانقطاع اليومي بتوقيت UTC:', dict(hours.most_common(4)))
    print('(المتوقع ٢٠ صيفاً و٢١ شتاءً: آخر شمعة تبدأ ١٦:٥٩ نيويورك، أي قبل إغلاق ١٧:٠٠ بدقيقة)')

    years = collections.Counter(datetime.datetime.fromtimestamp(k, datetime.timezone.utc).year
                                for k in keys)
    print('\nالتغطية:', dict(sorted(years.items())))
    print(f'→ {out}')


if __name__ == '__main__':
    main(sys.argv[1:])
