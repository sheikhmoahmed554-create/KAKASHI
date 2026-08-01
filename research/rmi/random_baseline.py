"""خط الأساس العشوائي: ماذا تعطي خطة TP130/SL70 عند الدخول بلا أي شرط؟

هذا هو الضابط الذي يقرر إن كان للمؤشر حافة أصلاً. نسبة فوز المؤشر لا تعني شيئاً
حتى تُقارن بنسبة فوز الدخول العشوائي في الفترة نفسها والجهة نفسها — فالسوق
الصاعد وحده يجعل كل قاعدة شراء تبدو عبقرية.

قواعد التنفيذ منسوخة من المؤشر حرفياً:
  الدخول على إغلاق الشمعة • الفحص من الشمعة التالية • التصادم في شمعة واحدة = تُلغى

    python3 random_baseline.py
"""
import csv
import numpy as np

PU = 0.10
TP = 130.0
SL = 70.0
STEP = 7            # نأخذ كل شمعة سابعة — عيّنة كافية إحصائياً وأسرع كثيراً
HORIZON = 6000      # المؤشر لا يحدّ زمن الصفقة؛ هذا سقف عملي

FILES = [('2021', 'm2_2021_utc.csv'), ('2023', 'm2_2023_utc.csv'),
         ('2025', 'm2_2025_utc.csv'), ('2026', 'm2_2026.csv')]


def load(path):
    t, o, h, l, c = [], [], [], [], []
    with open(path) as f:
        for r in csv.DictReader(f):
            t.append(r['time']); o.append(float(r['open']))
            h.append(float(r['high'])); l.append(float(r['low'])); c.append(float(r['close']))
    return t, np.array(h), np.array(l), np.array(c)


def scan(h, l, c, idx, side):
    """1 فوز / 0 خسارة / -1 غير محسوم / -2 مُلغاة (تصادم)."""
    n = len(c)
    out = np.full(len(idx), -1, np.int8)
    held = np.zeros(len(idx), np.int32)
    tpd, sld = TP * PU, SL * PU
    for k in range(len(idx)):
        i = idx[k]
        ep = c[i]
        tpx = ep + tpd if side > 0 else ep - tpd
        slx = ep - sld if side > 0 else ep + sld
        end = min(i + 1 + HORIZON, n)
        for j in range(i + 1, end):
            if side > 0:
                ht, hs = h[j] >= tpx, l[j] <= slx
            else:
                ht, hs = l[j] <= tpx, h[j] >= slx
            if ht and hs:
                out[k] = -2; held[k] = j - i; break
            if ht:
                out[k] = 1; held[k] = j - i; break
            if hs:
                out[k] = 0; held[k] = j - i; break
    return out, held


BE = 100.0 * SL / (TP + SL)
print(f"خطة الاختبار: هدف {TP:.0f} / وقف {SL:.0f} • نقطة التعادل {BE:.2f}%\n")
print(f"{'سنة':>6}{'عيّنة':>9}{'شراء%':>9}{'بيع%':>9}{'كلاهما%':>10}"
      f"{'مُلغاة%':>9}{'غير محسوم':>11}{'بقاء':>8}")

tot = {1: [0, 0], -1: [0, 0]}
per_year = {}
for name, path in FILES:
    t, h, l, c = load(path)
    idx = np.arange(200, len(c) - 1, STEP)
    res = {}
    holds = []
    for side in (1, -1):
        o, hd = scan(h, l, c, idx, side)
        w = int((o == 1).sum()); ls = int((o == 0).sum())
        res[side] = (w, ls, int((o == -2).sum()), int((o == -1).sum()))
        tot[side][0] += w; tot[side][1] += ls
        holds.append(hd[o >= 0].mean() if (o >= 0).any() else 0)
    bw, bl, bskip, bun = res[1]
    sw, sl_, sskip, sun = res[-1]
    buy_wr = 100.0 * bw / max(1, bw + bl)
    sell_wr = 100.0 * sw / max(1, sw + sl_)
    both = 100.0 * (bw + sw) / max(1, bw + bl + sw + sl_)
    skip_pct = 100.0 * (bskip + sskip) / (2 * len(idx))
    per_year[name] = (buy_wr, sell_wr, both)
    print(f"{name:>6}{len(idx):>9,}{buy_wr:>9.2f}{sell_wr:>9.2f}{both:>10.2f}"
          f"{skip_pct:>9.2f}{bun+sun:>11}{np.mean(holds):>8.0f}")

W = tot[1][0] + tot[-1][0]
L = tot[1][1] + tot[-1][1]
all_wr = 100.0 * W / (W + L)
print(f"\n{'الكل':>6}{W+L:>9,}{100.0*tot[1][0]/max(1,sum(tot[1])):>9.2f}"
      f"{100.0*tot[-1][0]/max(1,sum(tot[-1])):>9.2f}{all_wr:>10.2f}")

# ── مقارنة المؤشر بالعشوائي ──────────────────────────────────────────────────
IND = {'2021': (153, 269), '2023': (128, 237), '2025': (459, 830), '2026': (398, 734)}
print(f"\n═══ المؤشر مقابل الدخول العشوائي ═══")
print(f"{'سنة':>6}{'صفقات':>8}{'فوز المؤشر%':>13}{'عشوائي%':>10}{'الزيادة':>9}"
      f"{'σ':>7}{'الصافي':>9}")
gw = gl = 0
gz_num = gz_den = 0.0
for name, (w, ls) in IND.items():
    n = w + ls
    wr = 100.0 * w / n
    rnd = per_year[name][2]
    se = 100.0 * np.sqrt((rnd / 100) * (1 - rnd / 100) / n)
    net = w * TP - ls * SL
    print(f"{name:>6}{n:>8}{wr:>13.2f}{rnd:>10.2f}{wr-rnd:>+9.2f}"
          f"{(wr-rnd)/se:>+7.2f}{net:>+9.0f}")
    gw += w; gl += ls
gn = gw + gl
gwr = 100.0 * gw / gn
gse = 100.0 * np.sqrt((all_wr / 100) * (1 - all_wr / 100) / gn)
gnet = gw * TP - gl * SL
print(f"{'الكل':>6}{gn:>8}{gwr:>13.2f}{all_wr:>10.2f}{gwr-all_wr:>+9.2f}"
      f"{(gwr-all_wr)/gse:>+7.2f}{gnet:>+9.0f}")
print(f"\nالخطأ المعياري على {gn:,} صفقة = ±{gse:.2f} نقطة مئوية")
print(f"الحافة فوق التعادل النظري ({BE:.2f}%) = {gwr-BE:+.2f} نقطة مئوية")
print(f"التوقّع لكل صفقة = {gnet/gn:+.3f} نقطة")
