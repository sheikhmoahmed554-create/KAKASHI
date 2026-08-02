"""يعيد تنظيم الإعدادات: مجموعة منفصلة لكل مصدر، مرقّمة ومسمّاة باسم المؤشر الأصلي."""
import re

p = 'build_v2.py'
s = open(p, encoding='utf-8').read()

# ترتيب العرض في TradingView، والاسم يذكر مصدر الفكرة
GROUPS = [
    ('Rsi',   'RSI Reaction'),
    ('Macd',  'MACD Cross'),
    ('M4c',   'MACD 4-Colour'),
    ('Adx',   'ADX / DMI'),
    ('Bb',    'Bollinger Rebound'),
    ('Ichi',  'Ichimoku'),
    ('Sar',   'Parabolic SAR'),
    ('Pivot', 'Pivot Reclaim'),
    ('Fib',   'Fibonacci Retracement'),
    ('Ma',    'Moving Average'),
    ('Mis',   'RSI+CCI+Stoch Confluence'),
    ('Mtx',   'Matrix Series'),
    ('Qqe',   'QQE'),
    ('Sqz',   'Squeeze Momentum'),
    ('Vfx',   'Williams Vix Fix'),
    ('Vol',   'Volume Spike'),
    ('Kw',    'Keltner Wick Rejection'),
    ('Brt',   'Breakout & Retest'),
    ('Smb',   'Smart Money Breakout'),
    ('Sr',    'S/R Re-test Finder'),
    ('Str',   'Liquidity Sweep Reversal'),
    ('Lux',   'LuxAlgo Reversal'),
    ('Aa',    'AlgoAlpha Reversal'),
]

decl = []
for i, (key, name) in enumerate(GROUPS, start=10):
    decl.append(f'G_{key.upper()} = "{i} ■ {name}"')
s = s.replace('G_SRC   = "03 ■ Multicator Sources"',
              'G_SRC   = "03 ■ Entry Sources — master list"\n' + '\n'.join(decl))

# كل إعداد يذهب إلى مجموعة مصدره، مطابقةً على بادئة اسم المتغيّر
lines = s.split('\n')
out = []
for ln in lines:
    m = re.match(r'\s*mc([A-Z][a-z0-9]*)\w* = input\.', ln)
    if m and 'group=G_SRC' in ln:
        key = m.group(1)
        # أطول بادئة مطابقة أولاً، فلا يبتلع Ma اسم Macd ولا Sr اسم Str
        best = None
        for k, _ in GROUPS:
            if re.match(r'\s*mc' + k + r'(?![a-z])', ln) and (best is None or len(k) > len(best)):
                best = k
        if best:
            ln = ln.replace('group=G_SRC', f'group=G_{best.upper()}')
    out.append(ln)
s = '\n'.join(out)

open(p, 'w', encoding='utf-8').write(s)
left = len(re.findall(r'group=G_SRC', s))
print(f"أُنشئت {len(GROUPS)} مجموعة • إعدادات بقيت في المجموعة العامة: {left}")
