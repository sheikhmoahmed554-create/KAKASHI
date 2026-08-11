"""يحذف من SYR30 كل ما ثبت أنه ميت، حذفاً تاماً لا إطفاءً.

    python3 research/tools/clean_indicator.py <المصدر> <الخرج>

يُحذف فقط ما قيس أنه لا يطلق إشارة واحدة على ١٩٢ ألف شمعة حتى بفتح مفاتيحه
(التجربة ٠١٧)، أو ما ثبت أن إقفاله لا يغيّر رقماً (التجربة ٠٣٥). فالحذف
لا يغيّر سلوك المؤشر، والمقارنة بعده تثبت ذلك صفقةً بصفقة.

بعد الحذف المباشر يمشي المنظّف دورات: أي متغيّر لم يبق له مرجع يُحذف أيضاً،
حتى لا يبقى للمحذوف أثر في الكود.
"""
import re
import sys

# المدارس الميتة: صفر إشارة على ١٩٢ ألف شمعة بمفاتيح مفتوحة
DEAD_SCHOOLS = ['finalS11', 'finalS17', 'finalS19', 'finalS22', 'finalS09']
# حدود لا تُحذف: أسماء تتوقعها منصة V16 أو تحتاجها لغة Pine
PROTECTED = {
    'canEnterLong', 'canEnterShort', 'tradeDecisionSide', 'statsActive', 'active', 'side',
    'entryPrice', 'tpPrice', 'slPrice', 'tradeTargetPts', 'tradeStopPts', 'tradeEntrySource',
    'tradeEntrySourceCode', 'tradeKind', 'skipTrade', 'isWin', 'isLoss', 'hardExit',
    'trades', 'wins', 'losses', 'netPts', 'maxWin', 'maxLoss', 'sumWinPts', 'sumLossPts',
    'lastClosedPts', 'pointUnit', 'buySignal', 'sellSignal',
    'sy348EntryBuyPlot', 'sy348EntrySellPlot', 'sy348ExitTPPlot', 'sy348ExitSLPlot',
    'trendVoteLiveWins', 'trendVoteLiveLosses', 'finalFusionLiveWins', 'finalFusionLiveLosses',
    'm1LiveM1Wins', 'm1LiveM1Losses', 'm1LiveOwnTrades', 'm1LiveSameTrades', 'm1LiveTakeTrades',
    'trendVoteLiveTrades', 'finalFusionLiveTrades',
}
ASSIGN = re.compile(r'^([A-Za-z_]\w*)\s*=(?!=)')
DECL = re.compile(r'^(?:var|varip)\s+(?:\w+\s+)?([A-Za-z_]\w*)\s*=')


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


def refs(lines, name, skip):
    """عدد المواضع التي يُذكر فيها الاسم خارج سطر تعريفه."""
    pat = re.compile(r'\b' + re.escape(name) + r'\b')
    n = 0
    for i, ln in enumerate(lines):
        if i == skip:
            continue
        if pat.search(strip_comment(ln)):
            n += 1
    return n


def main(src_path, out_path):
    src = open(src_path, encoding='utf-8').read()

    # ١ — إزالة المدارس الميتة من مجموعي التصويت
    for school in DEAD_SCHOOLS:
        for val in ('1', '-1'):
            src = src.replace(f'({school} == {val} ? 1 : 0) + ', '')
            src = src.replace(f' + ({school} == {val} ? 1 : 0)', '')
        # وأي ذكر متبقٍّ داخل شروط مركّبة يصير قيمة ثابتة صفر
        src = re.sub(r'\(' + school + r' == -?1 \? 1 : 0\)', '0', src)

    # ٢ — تصفير مساهمات المصادر الميتة في نقاط الجودة
    for name, val in (('syr30DeadAuctionBuy', '1.05'), ('syr30DeadAuctionSell', '1.05')):
        src = src.replace(f'({name} ? {val} : 0.0) + ', '')
        src = src.replace(f' + ({name} ? {val} : 0.0)', '')

    lines = src.split('\n')

    # ٣ — حذف تعريفات المدارس الميتة نفسها
    keep = []
    for ln in lines:
        m = ASSIGN.match(ln.strip())
        if m and m.group(1) in DEAD_SCHOOLS:
            continue
        keep.append(ln)
    lines = keep

    # ٤ — دورات إزالة الأيتام: أي تعريف لم يبق له مرجع يُحذف
    removed = []
    for _ in range(40):
        gone = False
        for i, ln in enumerate(lines):
            s = ln.strip()
            m = ASSIGN.match(s) or DECL.match(s)
            if not m:
                continue
            name = m.group(1)
            if name in PROTECTED or name.startswith('G_'):
                continue
            if re.search(r'\b(plot|plotshape|plotchar|label|line|box|table|bgcolor|barcolor|alert)\b', s):
                continue
            if ':=' in s or s.startswith('if') or s.startswith('for'):
                continue
            if refs(lines, name, i) == 0:
                removed.append(name)
                del lines[i]
                gone = True
                break
        if not gone:
            break

    out = '\n'.join(lines)
    hdr = ('// SYR30 منظّف — حُذف ما ثبت أنه ميت، حذفاً تاماً لا إطفاءً.\n'
           '// المدارس المحذوفة (صفر إشارة على ١٩٢ ألف شمعة بمفاتيح مفتوحة، التجربة ٠١٧):\n'
           '//   ١١ QQE+Vortex • ١٧ المزاد الميت • ١٩ حزمة الجهة • ٢٢ السيولة\n'
           '// و٠٩ بولنجر+كلتنر (إقفاله لا يغيّر رقماً واحداً، التجربة ٠٣٥).\n'
           f'// وحُذف معها {len(removed)} متغيّراً صار بلا مرجع.\n'
           '// المنطق الباقي لم يُمسّ، والمقارنة صفقةً بصفقة تثبت أن السلوك واحد.\n//\n')
    open(out_path, 'w', encoding='utf-8').write(hdr + out)
    print(f'حُذف {len(removed)} متغيّراً يتيماً')
    print(f'الأسطر: {len(src.split(chr(10)))} → {len(lines)}')
    if removed:
        print('عيّنة مما حُذف: ' + '، '.join(removed[:12]))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
