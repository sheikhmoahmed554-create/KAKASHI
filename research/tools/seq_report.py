"""تقرير الخطة لبوت يفتح صفقة واحدة في المرة."""
import json

rows = json.load(open('research/results/tpsl_seq_40_60.json'))
B_WR, B_NET, B_PT, B_DAY, B_NEG, B_WORST = 60.70, 7740, 1.198, 46.8, 2, -1235

pareto = [r for r in rows
          if not any(o['win_rate'] >= r['win_rate'] and o['net'] >= r['net']
                     and (o['win_rate'] > r['win_rate'] or o['net'] > r['net'])
                     for o in rows)]
pareto.sort(key=lambda r: -r['win_rate'])

W, H, PL, PR, PT, PB = 880, 380, 62, 24, 22, 46
xs = [r['net'] for r in rows]; ys = [r['win_rate'] for r in rows]
x0, x1 = min(xs + [B_NET]) - 400, max(xs + [B_NET]) + 400
y0, y1 = min(ys) - 1, max(ys) + 1.5
PX = lambda v: PL + (v - x0) * (W - PL - PR) / (x1 - x0)
PY = lambda v: PT + (y1 - v) * (H - PT - PB) / (y1 - y0)

grid = []
for k in range(6):
    v = y0 + k * (y1 - y0) / 5
    grid.append(f'<line x1="{PL}" y1="{PY(v):.1f}" x2="{W-PR}" y2="{PY(v):.1f}" stroke="#1e2a3b"/>'
                f'<text x="{PL-8}" y="{PY(v)+4:.1f}" fill="#8fa0b6" font-size="10" '
                f'text-anchor="end">{v:.0f}%</text>')
for v in range(4000, 15001, 2000):
    grid.append(f'<line x1="{PX(v):.1f}" y1="{PT}" x2="{PX(v):.1f}" y2="{H-PB}" '
                f'stroke="#1e2a3b" stroke-dasharray="3 4"/>'
                f'<text x="{PX(v):.1f}" y="{H-PB+16}" fill="#8fa0b6" font-size="10" '
                f'text-anchor="middle">{v//1000}k</text>')

cloud = "".join(f'<circle cx="{PX(r["net"]):.1f}" cy="{PY(r["win_rate"]):.1f}" r="2" '
                f'fill="#2a3a52"/>' for r in rows)
front = " ".join(f'{PX(r["net"]):.1f},{PY(r["win_rate"]):.1f}' for r in pareto)

PICKS = {(40, 65): ('أعلى ون ريت', '#ffd45a'), (44, 59): ('التوصية', '#20d17a'),
         (60, 54): ('أعلى نقاط', '#46a5ff')}
marks = []
for r in pareto:
    key = (r['tp'], r['sl'])
    if key in PICKS:
        lbl, col = PICKS[key]
        x, y = PX(r['net']), PY(r['win_rate'])
        marks.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="7" fill="none" stroke="{col}" '
                     f'stroke-width="2.5"/><text x="{x:.1f}" y="{y-13:.1f}" fill="{col}" '
                     f'font-size="11" font-weight="700" text-anchor="middle">{lbl} {r["tp"]}/{r["sl"]}</text>')

base = (f'<circle cx="{PX(B_NET):.1f}" cy="{PY(B_WR):.1f}" r="7" fill="#ff5968"/>'
        f'<text x="{PX(B_NET):.1f}" y="{PY(B_WR)-14:.1f}" fill="#ff8a95" font-size="11" '
        f'font-weight="700" text-anchor="middle">المؤشر الآن</text>')

chart = f'''<svg viewBox="0 0 {W} {H}"><rect width="{W}" height="{H}" fill="#080d14"/>
{''.join(grid)}{cloud}<polyline points="{front}" fill="none" stroke="#20d17a" stroke-width="2"/>
{base}{''.join(marks)}
<text x="{W/2:.0f}" y="{H-6}" fill="#c8d6e8" font-size="11" text-anchor="middle">الصافي بالنقاط ←</text>
</svg>'''

TABLE = [(40, 65), (42, 65), (44, 65), (44, 63), (44, 62), (45, 62),
         (44, 59), (46, 59), (46, 54), (60, 54)]
by = {(r['tp'], r['sl']): r for r in rows}
trs = ""
for tp, sl in TABLE:
    r = by[(tp, sl)]
    dwr = r['win_rate'] - B_WR
    dnet = 100 * (r['net'] - B_NET) / B_NET
    hl = ' style="background:#12301f"' if (tp, sl) == (44, 59) else ''
    trs += (f"<tr{hl}><td><b>{tp} / {sl}</b></td>"
            f"<td>{r['win_rate']:.2f}%</td>"
            f"<td class='{'up' if dwr>=0 else 'dn'}'>{dwr:+.2f}</td>"
            f"<td>{r['net']:,.0f}</td>"
            f"<td class='{'up' if dnet>=0 else 'dn'}'>{dnet:+.0f}%</td>"
            f"<td>{r['per_trade']:.3f}</td><td>{r['per_day']:.1f}</td>"
            f"<td class='{'up' if r['neg_months']<B_NEG else 'dn' if r['neg_months']>B_NEG else ''}'>"
            f"{r['neg_months']}</td><td>{r['min_net']:,.0f}</td></tr>")
trs += (f"<tr style='background:#2a1416'><td><b>R16 الآن</b></td><td>{B_WR:.2f}%</td>"
        f"<td>—</td><td>{B_NET:,}</td><td>—</td><td>{B_PT:.3f}</td><td>{B_DAY}</td>"
        f"<td>{B_NEG}</td><td>{B_WORST:,}</td></tr>")

# ── الاختبار خارج العيّنة: القسمة عند ١٥ أبريل ──────────────────────────────
OOS = [("44 / 59", 59.27, 6782, 58.09, 2285, "أعلى صافي خارج العيّنة"),
       ("40 / 65", 62.79, 3070, 62.34, 1250, "أعلى فوز — وتتفوّق على R16 في الاثنين"),
       ("44 / 62", 60.25, 6122, 59.21, 2064, ""),
       ("46 / 59", 58.44, 7772, 56.91, 2047, ""),
       ("60 / 54", 50.77, 12336, 47.95, 1674, ""),
       ("R16 الحالي", 61.18, 7352, 60.15, 388, "انهار خارج العيّنة")]
oos_rows = ""
for n, a, b, c, d, note in OOS:
    bg = " style='background:#12301f'" if n.startswith("44 / 59") else (
         " style='background:#2a1416'" if n.startswith("R16") else "")
    oos_rows += (f"<tr{bg}><td><b>{n}</b></td><td>{a:.2f}%</td><td>{b:,}</td>"
                 f"<td class='{'up' if c >= 60 else ''}'>{c:.2f}%</td>"
                 f"<td class='{'up' if d > 1500 else 'dn' if d < 600 else ''}'>{d:,}</td>"
                 f"<td style='font-size:11px;color:#91a1b6'>{note}</td></tr>")

html = f"""<meta charset="utf-8">
<title>SYR30 — أفضل خطة لصفقة واحدة في المرة</title>
<style>
body{{margin:0;background:#070b11;color:#f4f7fb;font-family:-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;direction:rtl}}
.wrap{{max-width:940px;margin:auto;padding:16px}}
h1{{font-size:20px;margin:0 0 3px}} h2{{font-size:15px;margin:0 0 9px;color:#c8d6e8}}
.sub{{color:#91a1b6;font-size:12px;line-height:1.75;margin-bottom:14px}}
.card{{background:#101722;border:1px solid #29374b;border-radius:14px;padding:13px;margin-bottom:12px}}
svg{{width:100%;height:auto;display:block}}
table{{width:100%;border-collapse:collapse;font-size:12px}}
th,td{{padding:7px 5px;border-bottom:1px solid #202c3c;text-align:center;white-space:nowrap}}
th{{background:#192435}} .up{{color:#20d17a;font-weight:700}} .dn{{color:#ff5968;font-weight:700}}
.hero{{background:#2a1416;border:1px solid #6d2530;border-radius:12px;padding:13px;margin-bottom:11px;line-height:1.9;font-size:13px}}
.pick{{background:#102b21;border:1px solid #285943;border-radius:12px;padding:13px;line-height:1.9;font-size:13px}}
.scroll{{overflow-x:auto}}
</style>
<div class="wrap">
<h1>أفضل خطة أهداف — بوت يفتح صفقة واحدة في المرة</h1>
<div class="sub">
٦,٤٦٣ صفقة فعلية للمؤشر • هدف ٤٠–٦٠ ووقف ٥٠–٦٥ = ٣٣٦ تركيبة<br>
كل إشارة تصل والصفقة القائمة مفتوحة تُرفض — كما يعمل بوتك تماماً.
</div>

<div class="hero">
<b>النتيجة الأولى وأهمها:</b> من أصل ٣٣٦ تركيبة، عددُ ما يتفوّق على نظام R16 الحالي
في نسبة الفوز والنقاط معاً = <b style="font-size:22px">صفر</b>.<br>
نظامك التكيّفي الحالي يقع على حدّ الكفاءة نفسه. أي مكسب في النقاط يُدفع ثمنه من نسبة الفوز.
</div>

<div class="card">
<h2>خريطة الخيارات — كل نقطة تركيبة</h2>
{chart}
<div class="sub" style="margin:8px 0 0">
الخط الأخضر هو حدّ الكفاءة: لا شيء فوقه ولا يمينه. النقطة الحمراء هي مؤشرك الآن —
وهي على الحد تماماً، لذلك لا يمكن تحسين الاثنين معاً.
</div>
</div>

<div class="card"><h2>الجدول الكامل</h2><div class="scroll"><table>
<tr><th>هدف/وقف</th><th>نسبة الفوز</th><th>الفرق</th><th>الصافي</th><th>الفرق</th>
<th>نقطة/صفقة</th><th>صفقة/يوم</th><th>شهور خاسرة</th><th>أسوأ شهر</th></tr>
{trs}</table></div></div>

<div class="card">
<h2>الاختبار خارج العيّنة — القسمة عند ١٥ أبريل</h2>
<div class="sub" style="margin:0 0 9px">
٧٢ يوم تدريب و٦٨ يوم اختبار. كل ما سبق محسوب على الفترة كاملة؛ وهذه على فترة
لم تدخل في أي اختيار — وهي وحدها ما يُعتمد عليه.
</div>
<div class="scroll"><table>
<tr><th>هدف/وقف</th><th>تدريب فوز%</th><th>تدريب صافي</th><th>اختبار فوز%</th>
<th>اختبار صافي</th><th></th></tr>
{oos_rows}</table></div>
<div class="sub" style="margin:9px 0 0">
نظام R16 الحالي يعطي <b>+٣٨٨ نقطة على ٦٨ يوماً</b> — أي +٠.١٢٩ لكل صفقة، قريباً من الصفر.
كل الخطط الثابتة أعلاه تتفوّق عليه في النقاط، و<b>٤٠/٦٥ تتفوّق عليه في نسبة الفوز أيضاً</b>.
</div>
</div>

<div class="card" style="border-color:#6d2530;background:#1a1013">
<h2 style="color:#ff8a95">تبديل الخطة حسب نوع السوق — فشل الاختبار</h2>
<div class="sub" style="margin:0;line-height:1.95">
اختيار أفضل خطة لكل نوع سوق من فترة التدريب وحدها، ثم قياسها على فترة الاختبار:<br><br>
<b style="color:#20d17a">التدريب: +١٤,٢٧٨ نقطة</b> (+٤.٤٥٨ لكل صفقة)
&nbsp;←&nbsp; <b style="color:#ff5968">الاختبار: −٢ نقطة</b><br><br>
وفي ثلاثة أنواع من أربعة، الخطة المختارة لنوعٍ ما ليست أفضل خطة له خارج العيّنة —
وفي الرينج والتذبذب هي <b>أسوأ الأربع</b>. الاختيار التقط ضجيجاً لا بنية،
فلا يوجد ما يكشفه كاشف لحظي.
</div>
</div>

<div class="pick">
<b>التوصية: هدف ٤٤ / وقف ٥٩</b><br>
صمدت خارج العيّنة: <b>+٢,٢٨٥ نقطة</b> مقابل <b>+٣٨٨</b> لنظامك الحالي — ستة أضعاف.<br>
تدفع <b>١.٩٦ نقطة مئوية</b> من نسبة الفوز (٥٨.٧٤٪ بدل ٦٠.٧٠٪) وتأخذ مقابلها:<br>
• <b>+١٧٪ نقاط</b> — ٩,٠٦٧ بدل ٧,٧٤٠<br>
• <b>شهر خاسر واحد بدل شهرين</b><br>
• <b>أسوأ شهر ‎−٥٤٤ بدل ‎−١,٢٣٥</b> — أي أقل من نصف الألم<br>
• +١.٤٩٧ نقطة لكل صفقة بدل +١.١٩٨<br><br>
وإن كانت نسبة الفوز أهم عندك من كل شيء: <b>٤٠ / ٦٥ تعطي ٦٢.٥٨٪</b> — أعلى رقم
داخل الصندوق — لكنها تخسر ٤٤٪ من النقاط وترفع الشهور الخاسرة إلى ثلاثة.
لاحظ المفارقة: <b>أعلى نسبة فوز هي الأقل ثباتاً شهرياً.</b>
</div>
</div>"""

open('research/results/seq_report.html', 'w', encoding='utf-8').write(html)
print("wrote research/results/seq_report.html")
