"""جرد كامل لمؤشر Pine: ما الذي يعمل، وما هو ميت، وما هو زينة.

    python3 research/tools/deadcode.py research/variants/SYR30_USER_CURRENT.pine

الفئات:
  ميت        — معرّف ولا يُستعمل في أي مكان
  ثابت       — مقفول على true أو false في الكود، فالشرط الذي يحرسه محسوم سلفاً
  زينة       — لا يُستعمل إلا داخل plot/label/table، فلا أثر له على قرار الدخول
  مدخل صامت  — input معرّف ولا يُقرأ بعدها
  يعمل       — يدخل في سلسلة القرار
"""
import re
import sys
from collections import defaultdict

DECOR = re.compile(r'\b(plot|plotshape|plotchar|plotcandle|bgcolor|fill|hline|'
                   r'label\.|line\.|box\.|table\.|barcolor|plotarrow)')
ASSIGN = re.compile(r'^(\w+)\s*=(?!=)')
REASSIGN = re.compile(r'^(\w+)\s*:=')
INPUT = re.compile(r'=\s*input\.')
CONST = re.compile(r'^\s*(\w+)\s*=\s*(true|false)\s*(?://.*)?$')


def strip_comment(line):
    q = None
    for i, ch in enumerate(line):
        if q:
            if ch == q:
                q = None
        elif ch in '"\'':
            q = ch
        elif ch == '/' and line[i:i + 2] == '//':
            return line[:i]
    return line


def main(path):
    raw = open(path, encoding='utf-8').read().split('\n')
    lines = [strip_comment(x) for x in raw]

    decls = {}          # اسم -> (سطر، نوع)
    consts = {}
    for i, line in enumerate(lines):
        s = line.strip()
        m = CONST.match(s)
        if m:
            consts[m.group(1)] = (i + 1, m.group(2))
        m = ASSIGN.match(s)
        if m:
            name = m.group(1)
            if name in ('if', 'for', 'while', 'else', 'var', 'varip'):
                continue
            kind = 'input' if INPUT.search(s) else 'متغير'
            decls.setdefault(name, (i + 1, kind))
        m2 = re.match(r'^(?:var|varip)\s+(?:\w+\s+)?(\w+)\s*=', s)
        if m2:
            decls.setdefault(m2.group(1), (i + 1, 'متغير'))

    # عدّ الاستعمالات: مرات الظهور خارج سطر التعريف
    uses = defaultdict(int)
    decor_uses = defaultdict(int)
    logic_uses = defaultdict(int)
    for i, line in enumerate(lines):
        decorative = bool(DECOR.search(line))
        for name in re.findall(r'\b\w+\b', line):
            if name not in decls:
                continue
            if decls[name][0] == i + 1 and ASSIGN.match(line.strip()):
                continue
            uses[name] += 1
            (decor_uses if decorative else logic_uses)[name] += 1

    dead, decor_only, silent_inputs, const_gates = [], [], [], []
    for name, (ln, kind) in sorted(decls.items(), key=lambda x: x[1][0]):
        u, lu = uses[name], logic_uses[name]
        if u == 0:
            (silent_inputs if kind == 'input' else dead).append((ln, name, kind))
        elif lu == 0:
            decor_only.append((ln, name, kind))
    for name, (ln, val) in sorted(consts.items(), key=lambda x: x[1][0]):
        if logic_uses[name]:
            const_gates.append((ln, name, val, logic_uses[name]))

    total = len(decls)
    inputs = sum(1 for _, k in decls.values() if k == 'input')
    print(f'{path}\n{len(raw)} سطر • {total} تعريف • {inputs} مدخل\n')

    print(f'### مدخلات صامتة — معرّفة ولا تُقرأ ({len(silent_inputs)})\n')
    for ln, name, _ in silent_inputs:
        print(f'  سطر {ln:>5}  {name}')

    print(f'\n### متغيرات ميتة — معرّفة ولا تُستعمل ({len(dead)})\n')
    for ln, name, _ in dead[:40]:
        print(f'  سطر {ln:>5}  {name}')
    if len(dead) > 40:
        print(f'  … و{len(dead) - 40} غيرها')

    print(f'\n### زينة — تُستعمل في الرسم فقط، بلا أثر على القرار ({len(decor_only)})\n')
    for ln, name, _ in decor_only[:40]:
        print(f'  سطر {ln:>5}  {name}')
    if len(decor_only) > 40:
        print(f'  … و{len(decor_only) - 40} غيرها')

    print(f'\n### بوابات مقفولة على ثابت — الشرط محسوم سلفاً ({len(const_gates)})\n')
    for ln, name, val, u in const_gates:
        print(f'  سطر {ln:>5}  {name} = {val}   (مستعمل في {u} موضع منطقي)')

    print(f'\nالخلاصة: {len(silent_inputs)} مدخل صامت • {len(dead)} متغير ميت • '
          f'{len(decor_only)} زينة • {len(const_gates)} بوابة ثابتة')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'research/variants/SYR30_USER_CURRENT.pine')
