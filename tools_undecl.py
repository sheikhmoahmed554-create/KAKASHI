#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""List identifiers a Pine file uses but never declares.

The JS engine only evaluates branches it reaches, so a dead block naming a
deleted variable runs fine there and fails on TradingView. This reads the file
the way the compiler does: every name that is assigned anywhere counts as
declared, everything else has to be a builtin.
"""
import io, re, sys

src = io.open(sys.argv[1], encoding='utf-8').read()
lines = src.split('\n')

# strip comments and string literals so their contents never look like code
clean = []
for l in lines:
    l = re.sub(r"'[^']*'", "''", l)
    l = re.sub(r'"[^"]*"', '""', l)
    l = re.sub(r'//.*$', '', l)
    clean.append(l)
body = '\n'.join(clean)

declared = set()
# plain and reassigning assignments, with or without a type keyword
for m in re.finditer(r'^\s*(?:var\s+|varip\s+)?(?:(?:int|float|bool|string|color|line|label|box|table|array<[^>]+>)\s+)?([A-Za-z_]\w*)\s*(?::=|=)(?!=)', body, re.M):
    declared.add(m.group(1))
# tuple destructuring:  [a, b] = f()
for m in re.finditer(r'^\s*\[([^\]]+)\]\s*=', body, re.M):
    for nm in m.group(1).split(','):
        declared.add(nm.strip().split()[-1])
# function definitions and their parameters
for m in re.finditer(r'^\s*([A-Za-z_]\w*)\s*\(([^)]*)\)\s*=>', body, re.M):
    declared.add(m.group(1))
    for p in m.group(2).split(','):
        p = p.strip()
        if p:
            declared.add(p.split()[-1].split('=')[0].strip())
# for-loop counters
for m in re.finditer(r'\bfor\s+([A-Za-z_]\w*)\s*=', body):
    declared.add(m.group(1))
for m in re.finditer(r'\bfor\s+\[?([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\]?\s+in\b', body):
    declared.add(m.group(1)); declared.add(m.group(2))

BUILTIN = set('''
open high low close volume time time_close hl2 hlc3 ohlc4 hlcc4 bar_index last_bar_index
last_bar_time na nz fixnan int float bool string color true false and or not if else for
while to by in var varip switch export import method type enum series simple const input
plot plotshape plotchar plotarrow plotcandle plotbar bgcolor barcolor fill hline alert
alertcondition indicator strategy library max_bars_back timenow dayofmonth dayofweek
dayofyear hour minute month second weekofyear year na_value
math ta str array matrix map color line label box table polyline chart currency dividends
earnings syminfo timeframe barstate session shape location size position extend
xloc yloc display format scale text font order strategy request runtime ticker
adjustment barmerge lookahead settlement_as_close alert_freq
'''.split())

used = {}
for i, l in enumerate(clean, 1):
    for m in re.finditer(r'(?<![.\w])([A-Za-z_]\w*)\b', l):
        nm = m.group(1)
        if nm in BUILTIN or nm in declared:
            continue
        # skip named arguments:  title=, group=, minval=
        if re.search(r'\b' + nm + r'\s*=[^=]', l) and not re.search(r'^\s*' + nm + r'\s*=', l):
            continue
        used.setdefault(nm, []).append(i)

if not used:
    print('clean — every identifier is declared')
else:
    print('%d undeclared identifier(s):' % len(used))
    for nm in sorted(used):
        print('  %-28s lines %s' % (nm, ', '.join(map(str, used[nm][:6]))))
