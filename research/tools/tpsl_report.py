"""تقرير مرئي: خريطة الهدف/الوقف الكاملة ومنحنى المقايضة بين نسبة الفوز والربح."""
import json

import numpy as np

g = json.load(open('research/results/tpsl_grid_2026.json'))
ok = [r for r in g if r['unresolved'] <= 0.02 * (r['trades'] + r['unresolved'])]
BASE_WR, BASE_NET, BASE_PT = 60.70, 7740, 1.198      # خط الأساس تسلسلياً

TPS = sorted({r['tp'] for r in ok})
SLS = sorted({r['sl'] for r in ok})
W = {(r['tp'], r['sl']): r for r in ok}

# ── منحنى المقايضة: أعلى نسبة فوز عند كل حد أدنى للربح ───────────────────────
curve = []
for floor in range(0, 15500, 500):
    c = [r for r in ok if r['net_points'] >= floor]
    if not c:
        break
    b = max(c, key=lambda r: r['win_rate'])
    curve.append((floor, b))

# ── الخريطة الحرارية ────────────────────────────────────────────────────────
CW, CH = 9, 7
PADL, PADT = 46, 26
gw, gh = len(SLS) * CW, len(TPS) * CH


def color(net):
    if net is None:
        return '#0b111a'
    x = max(-1.0, min(1.0, net / 12000.0))
    if x >= 0:
        return f'rgb({int(8+20*(1-x))},{int(40+170*x)},{int(50+70*x)})'
    return f'rgb({int(40+180*-x)},{int(30*(1+x))},{int(45+40*-x)})'


cells = []
for i, tp in enumerate(TPS):
    for j, sl in enumerate(SLS):
        r = W.get((tp, sl))
        if not r:
            continue
        cells.append(
            f'<rect x="{PADL+j*CW}" y="{PADT+i*CH}" width="{CW}" height="{CH}" '
            f'fill="{color(r["net_points"])}"><title>هدف {tp} / وقف {sl}\n'
            f'فوز {r["win_rate"]}%  تعادل {r["breakeven"]}%  حافة {r["edge"]:+}\n'
            f'صافي {r["net_points"]}  ({r["per_trade"]}/صفقة)</title></rect>')

marks = []
for tp, sl, lbl, col in [(46, 119, 'أعلى فوز رابح', '#ffd45a'),
                         (60, 54, 'أعلى ربح', '#46a5ff'),
                         (30, 50, 'المؤشر الآن', '#ffffff')]:
    if tp in TPS and sl in SLS:
        x = PADL + SLS.index(sl) * CW + CW / 2
        y = PADT + TPS.index(tp) * CH + CH / 2
        marks.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="5" fill="none" '
                     f'stroke="{col}" stroke-width="2"/>')

ax = []
for j, sl in enumerate(SLS):
    if sl % 10 == 0:
        ax.append(f'<text x="{PADL+j*CW+CW/2:.0f}" y="{PADT+gh+13}" fill="#8fa0b6" '
                  f'font-size="9" text-anchor="middle">{sl}</text>')
for i, tp in enumerate(TPS):
    if tp % 10 == 0:
        ax.append(f'<text x="{PADL-6}" y="{PADT+i*CH+CH/2+3:.0f}" fill="#8fa0b6" '
                  f'font-size="9" text-anchor="end">{tp}</text>')

heat = f'''<svg viewBox="0 0 {PADL+gw+16} {PADT+gh+34}">
<rect width="{PADL+gw+16}" height="{PADT+gh+34}" fill="#080d14"/>
<text x="{PADL}" y="16" fill="#c8d6e8" font-size="11">الوقف (نقطة) ←</text>
<text x="12" y="{PADT-8}" fill="#c8d6e8" font-size="11">الهدف</text>
{''.join(cells)}{''.join(marks)}{''.join(ax)}</svg>'''

# ── منحنى المقايضة ──────────────────────────────────────────────────────────
CWW, CHH, PL, PR, PT, PB = 900, 330, 56, 60, 20, 40
xs = [c[0] for c in curve]
ys = [c[1]['win_rate'] for c in curve]
x0, x1 = 0, max(xs)
y0, y1 = min(ys) - 2, max(ys) + 2
PX = lambda v: PL + (v - x0) * (CWW - PL - PR) / (x1 - x0)
PY = lambda v: PT + (y1 - v) * (CHH - PT - PB) / (y1 - y0)

pts = " ".join(f"{PX(x):.1f},{PY(y):.1f}" for x, y in zip(xs, ys))
grid2 = []
for k in range(6):
    v = y0 + k * (y1 - y0) / 5
    grid2.append(f'<line x1="{PL}" y1="{PY(v):.1f}" x2="{CWW-PR}" y2="{PY(v):.1f}" stroke="#1e2a3b"/>'
                 f'<text x="{PL-8}" y="{PY(v)+4:.1f}" fill="#8fa0b6" font-size="10" '
                 f'text-anchor="end">{v:.0f}%</text>')
for v in range(0, int(x1) + 1, 2000):
    grid2.append(f'<line x1="{PX(v):.1f}" y1="{PT}" x2="{PX(v):.1f}" y2="{CHH-PB}" '
                 f'stroke="#1e2a3b" stroke-dasharray="3 4"/>'
                 f'<text x="{PX(v):.1f}" y="{CHH-PB+16}" fill="#8fa0b6" font-size="10" '
                 f'text-anchor="middle">{v//1000}k</text>')

dots = []
for lbl, floor in [('أعلى فوز رابح', 8000), ('المؤشر الآن', None)]:
    pass
for x, r in [(c[0], c[1]) for c in curve if c[0] in (0, 4000, 8000, 12000, 14000)]:
    dots.append(f'<circle cx="{PX(x):.1f}" cy="{PY(r["win_rate"]):.1f}" r="4" fill="#ffd45a"/>'
                f'<text x="{PX(x):.1f}" y="{PY(r["win_rate"])-9:.1f}" fill="#ffe08a" '
                f'font-size="9" text-anchor="middle">{r["tp"]}/{r["sl"]}</text>')

base_mark = (f'<line x1="{PX(BASE_NET):.1f}" y1="{PT}" x2="{PX(BASE_NET):.1f}" y2="{CHH-PB}" '
             f'stroke="#46a5ff" stroke-width="1.5" stroke-dasharray="5 4"/>'
             f'<circle cx="{PX(BASE_NET):.1f}" cy="{PY(BASE_WR):.1f}" r="5" fill="#46a5ff"/>'
             f'<text x="{PX(BASE_NET)-8:.1f}" y="{PY(BASE_WR)+4:.1f}" fill="#8ec5ff" '
             f'font-size="10" text-anchor="end">المؤشر الآن</text>')

tradeoff = f'''<svg viewBox="0 0 {CWW} {CHH}">
<rect width="{CWW}" height="{CHH}" fill="#080d14"/>{''.join(grid2)}
<polyline points="{pts}" fill="none" stroke="#20d17a" stroke-width="2"/>
{base_mark}{''.join(dots)}
<text x="{CWW/2:.0f}" y="{CHH-6}" fill="#c8d6e8" font-size="11" text-anchor="middle">
الصافي بالنقاط على ٦.٥ شهور ←</text></svg>'''

rows = "".join(
    f"<tr><td><b>{r['tp']} / {r['sl']}</b></td><td>{f}</td>"
    f"<td class='up'>{r['win_rate']:.2f}%</td><td>{r['breakeven']:.2f}%</td>"
    f"<td class='{'up' if r['edge']>0 else 'dn'}'>{r['edge']:+.2f}</td>"
    f"<td class='{'up' if r['net_points']>0 else 'dn'}'>{r['net_points']:+,}</td>"
    f"<td>{r['per_trade']:+.3f}</td></tr>"
    for f, r in [(c[0], c[1]) for c in curve if c[0] % 2000 == 0])

html = f"""<meta charset="utf-8">
<title>SYR30 — أعلى نسبة ربح على نظام الأهداف</title>
<style>
body{{margin:0;background:#070b11;color:#f4f7fb;font-family:-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;direction:rtl}}
.wrap{{max-width:1000px;margin:auto;padding:16px}}
h1{{font-size:20px;margin:0 0 3px}} h2{{font-size:15px;margin:0 0 9px;color:#c8d6e8}}
.sub{{color:#91a1b6;font-size:12px;margin-bottom:14px;line-height:1.7}}
.card{{background:#101722;border:1px solid #29374b;border-radius:14px;padding:13px;margin-bottom:12px}}
svg{{width:100%;height:auto;display:block}}
table{{width:100%;border-collapse:collapse;font-size:12px}}
th,td{{padding:7px 6px;border-bottom:1px solid #202c3c;text-align:center;white-space:nowrap}}
th{{background:#192435}} .up{{color:#20d17a;font-weight:700}} .dn{{color:#ff5968;font-weight:700}}
.hero{{background:#102b21;border:1px solid #285943;border-radius:12px;padding:13px;margin-bottom:11px;line-height:1.9;font-size:13px}}
.warn{{background:#2a210d;border:1px solid #6d5520;border-radius:12px;padding:13px;color:#ffe08a;line-height:1.9;font-size:12.5px}}
.big{{font-size:27px;font-weight:900;color:#20d17a}}
.lg{{display:inline-flex;align-items:center;gap:5px;margin-left:14px;font-size:11px;color:#c8d6e8}}
.lg i{{width:11px;height:11px;border-radius:50%;display:inline-block;border:2px solid}}
.scroll{{overflow-x:auto}}
</style>
<div class="wrap">
<h1>أعلى نسبة ربح على نظام الأهداف في SYR30</h1>
<div class="sub">
٦,٤٦٣ صفقة فعلية للمؤشر على XAUUSD M1 • ٢٠٢٦-٠١-٠٢ → ٢٠٢٦-٠٧-١٧<br>
الدخولات مثبّتة كما هي، والمتغيّر هو خطة الخروج وحدها — فكل فرق يعود لنظام الأهداف.<br>
نموذج التنفيذ متحقَّق منه مقابل المحرك: <b style="color:#20d17a">تطابق ٩٩.٨١٪ صفقةً بصفقة</b>.
</div>

<div class="hero">
<b>الجواب المباشر:</b> أعلى نسبة فوز ممكنة هي <span class="big">٩١.٣٪</span> عند هدف ١٠ ووقف ١٢٠ —
<b style="color:#ff5968">وتخسر ٨,٤٥٠ نقطة.</b><br>
أعلى نسبة فوز <b>مع بقاء الربح عند مستوى ربح المؤشر الحالي</b> هي
<span class="big">٧٢.٦٪</span> عند هدف ٤٦ ووقف ١١٩ — مقابل ٦٠.٧٪ اليوم.
</div>

<div class="card">
<h2>لماذا نسبة الفوز وحدها لا تعني شيئاً</h2>
<div class="sub" style="margin:0">
نقطة التعادل = الوقف ÷ (الهدف + الوقف). عند هدف ١٠ ووقف ١٢٠ تكون ٩٢.٣٪ —
فنسبة فوز ٩١.٣٪ تحتها، والحساب ينزف. المقياس الحقيقي هو
<b style="color:#20d17a">الحافة = نسبة الفوز − نقطة التعادل</b>.
</div>
</div>

<div class="card">
<h2>منحنى المقايضة — كم نسبة فوز تشتري بكم ربح</h2>
{tradeoff}
<div class="sub" style="margin-top:8px">
كل نقطة على المنحنى هي أعلى نسبة فوز ممكنة عند حدّ أدنى معيّن للربح.
الخط الأزرق هو موقع المؤشر الحالي. كل خطوة يمين تعني ربحاً أكثر ونسبة فوز أقل.
</div>
</div>

<div class="card"><h2>الجدول الكامل للمقايضة</h2><div class="scroll"><table>
<tr><th>هدف / وقف</th><th>الصافي ≥</th><th>نسبة الفوز</th><th>التعادل</th><th>الحافة</th><th>الصافي</th><th>نقطة/صفقة</th></tr>
{rows}</table></div></div>

<div class="card">
<h2>خريطة كل التركيبات (٨,١٨١ تركيبة)</h2>
<div style="margin-bottom:7px">
<span class="lg"><i style="border-color:#ffd45a"></i>أعلى فوز رابح ٤٦/١١٩</span>
<span class="lg"><i style="border-color:#46a5ff"></i>أعلى ربح ٦٠/٥٤</span>
<span class="lg"><i style="border-color:#fff"></i>المؤشر الآن ٣٠/٥٠</span>
</div>
{heat}
<div class="sub" style="margin-top:8px">الأخضر ربح والأحمر خسارة. المس أي مربع لترى أرقامه.</div>
</div>

<div class="warn">
<b>ثلاث تحفّظات لازمة:</b><br>
<b>١ — المحاكاة التسلسلية تغيّر النتيجة.</b> الأرقام أعلاه تفترض أخذ كل إشارة.
البوت يفتح صفقة واحدة في المرة، وعندها هدف ٤٦/وقف ١١٩ ينزل ربحه إلى
<b>+٣,٨٠٢</b> مقابل <b>+٧,٧٤٠</b> للمؤشر الحالي — أي نصف الربح مقابل ١٢ نقطة مئوية من نسبة الفوز.<br>
<b>٢ — وقف ١١٩ نقطة يكسر قيد المشروع</b> (الوقف ≤ الهدف + ٢٠). ضمن القيد،
أعلى نسبة فوز رابحة هي ٦٢.٩٩٪ عند هدف ٣١ ووقف ٥١.<br>
<b>٣ — القياس على ٦.٥ شهور من زوج واحد.</b> نسبة الفوز ثابتة شهرياً (٧١.٧–٧٤.٦٪)
لكن الصافي خسر في مايو. التحقق على ٢٠٢١/٢٠٢٣/٢٠٢٥ لم يُنفّذ بعد.
</div>
</div>"""

open('research/results/tpsl_report.html', 'w', encoding='utf-8').write(html)
print("wrote research/results/tpsl_report.html", len(html), "bytes")
