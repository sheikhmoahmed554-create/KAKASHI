"""Render the regime map as a standalone SVG/HTML page for eyeball verification."""
import pandas as pd

COLORS = {
    "TREND_UP":   "#20d17a",
    "TREND_DOWN": "#ff5968",
    "RANGE":      "#46a5ff",
    "VOLATILE":   "#ffd45a",
}
AR = {
    "TREND_UP":   "ترند صاعد",
    "TREND_DOWN": "ترند هابط",
    "RANGE":      "رينج",
    "VOLATILE":   "تذبذب عنيف",
}

h = pd.read_csv("regime_h1.csv", parse_dates=["time"]).set_index("time")
seg = pd.read_csv("regime_segments.csv")

W, H, PADL, PADR, PADT, PADB = 1400, 460, 62, 16, 18, 46
n = len(h)
lo, hi = h["low"].min(), h["high"].max()
span = hi - lo
lo -= span * 0.04
hi += span * 0.04

X = lambda i: PADL + i * (W - PADL - PADR) / max(1, n - 1)
Y = lambda p: PADT + (hi - p) * (H - PADT - PADB) / (hi - lo)

pos = {t: i for i, t in enumerate(h.index)}
bands, ticks = [], []
for _, s in seg.iterrows():
    a = pos[pd.Timestamp(s["start"], tz="UTC")]
    b = pos[pd.Timestamp(s["end"], tz="UTC")]
    x0, x1 = X(a), X(b)
    c = COLORS[s["regime"]]
    bands.append(f'<rect x="{x0:.1f}" y="{PADT}" width="{max(1,x1-x0):.1f}" '
                 f'height="{H-PADT-PADB}" fill="{c}" opacity="0.13"/>')
    bands.append(f'<rect x="{x0:.1f}" y="{H-PADB+4}" width="{max(1,x1-x0):.1f}" '
                 f'height="10" fill="{c}" opacity="0.85"/>')

prev = None
for i, t in enumerate(h.index):
    key = (t.year, t.month)
    if key != prev:
        prev = key
        ticks.append(f'<line x1="{X(i):.1f}" y1="{PADT}" x2="{X(i):.1f}" y2="{H-PADB}" '
                     f'stroke="#2b3a4f" stroke-dasharray="3 4"/>')
        ticks.append(f'<text x="{X(i)+4:.1f}" y="{H-PADB+30}" fill="#8fa0b6" '
                     f'font-size="11">{t:%b}</text>')

grid = []
for k in range(6):
    p = hi - k * (hi - lo) / 5
    y = Y(p)
    grid.append(f'<line x1="{PADL}" y1="{y:.1f}" x2="{W-PADR}" y2="{y:.1f}" stroke="#1e2a3b"/>')
    grid.append(f'<text x="6" y="{y+4:.1f}" fill="#8fa0b6" font-size="11">{p:,.0f}</text>')

pts = " ".join(f"{X(i):.1f},{Y(p):.1f}" for i, p in enumerate(h['close']))
line = f'<polyline points="{pts}" fill="none" stroke="#eef4ff" stroke-width="1.35"/>'

tot = h["regime"].value_counts()
legend = "".join(
    f'<span class="lg"><i style="background:{COLORS[k]}"></i>{AR[k]} — '
    f'{tot.get(k,0)/24:.1f} يوم ({100*tot.get(k,0)/len(h):.0f}%)</span>'
    for k in ["TREND_UP", "TREND_DOWN", "RANGE", "VOLATILE"]
)

rows = "".join(
    f'<tr><td><b style="color:{COLORS[s.regime]}">{AR[s.regime]}</b></td>'
    f'<td>{s.start}</td><td>{s.end}</td><td>{s.days}</td>'
    f'<td class="{"up" if s.move_pts>=0 else "dn"}">{s.move_pts:+.0f}</td>'
    f'<td>{s.hi_lo_pts:.0f}</td><td>{s.capture:.2f}</td>'
    f'<td>{s.avg_atr:.1f}</td><td>{s.avg_adx:.0f}</td></tr>'
    for s in seg.itertuples()
)

html = f"""<title>KAKASHI — خريطة أنواع السوق 2026</title>
<style>
body{{margin:0;background:#070b11;color:#f4f7fb;font-family:-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;direction:rtl}}
.wrap{{max-width:1460px;margin:auto;padding:16px}}
h1{{font-size:20px;margin:0 0 4px}} .sub{{color:#91a1b6;font-size:12px;margin-bottom:14px}}
.card{{background:#101722;border:1px solid #29374b;border-radius:14px;padding:12px;margin-bottom:12px}}
.lg{{display:inline-flex;align-items:center;gap:6px;margin-left:16px;font-size:12px;color:#c8d6e8}}
.lg i{{width:12px;height:12px;border-radius:3px;display:inline-block}}
svg{{width:100%;height:auto;display:block}}
table{{width:100%;border-collapse:collapse;font-size:12px}}
th,td{{padding:6px 8px;border-bottom:1px solid #202c3c;text-align:center;white-space:nowrap}}
th{{background:#192435;position:sticky;top:0}}
.scroll{{overflow:auto;max-height:460px;border:1px solid #29374b;border-radius:11px}}
.up{{color:#20d17a;font-weight:700}} .dn{{color:#ff5968;font-weight:700}}
.note{{font-size:12px;color:#ffe08a;background:#2a210d;border:1px solid #6d5520;border-radius:10px;padding:10px;line-height:1.7}}
</style>
<div class="wrap">
<h1>خريطة أنواع السوق — XAUUSD 2026</h1>
<div class="sub">{h.index[0]:%Y-%m-%d} → {h.index[-1]:%Y-%m-%d} • {n:,} شمعة H1 • مبنية من 192,081 شمعة M1</div>
<div class="card">
  <div style="margin-bottom:8px">{legend}</div>
  <svg viewBox="0 0 {W} {H}">
    <rect width="{W}" height="{H}" fill="#080d14"/>
    {''.join(bands)}{''.join(grid)}{''.join(ticks)}{line}
  </svg>
</div>
<div class="card">
  <div class="note">
   <b>capture</b> = صافي الحركة ÷ كامل المدى. قريب من 1 يعني حركة نظيفة باتجاه واحد، قريب من 0 يعني ذهاب وإياب بدون نتيجة.<br>
   لاحظ مقطع 30 يناير → 9 فبراير: المدى 743 نقطة والصافي 33 نقطة فقط (capture 0.04) ومتوسط ATR 69.6 مقابل ~20 الطبيعي — هذا التعريف الحقيقي للتذبذب العنيف.
  </div>
</div>
<div class="card"><div class="scroll"><table>
<tr><th>النوع</th><th>من</th><th>إلى</th><th>أيام</th><th>الحركة</th><th>المدى</th><th>capture</th><th>ATR</th><th>ADX</th></tr>
{rows}
</table></div></div>
</div>"""

open("regime_map.html", "w").write(html)
print("wrote regime_map.html", len(html), "bytes")
