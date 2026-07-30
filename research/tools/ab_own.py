"""يقيس إعدادات SYR30 مستخدماً خطة الخروج التي يحسبها المؤشر نفسه لكل صفقة،
بدل فرض خطة ثابتة. الصفقة تُحاكى بـ tradeTargetPts/tradeStopPts الخاصين بها."""
import json, csv, sys, numpy as np
PU=0.1; MAXBARS=30
R=list(csv.DictReader(open('vault.csv')))
H=[float(r['high']) for r in R]; L=[float(r['low']) for r in R]; C=[float(r['close']) for r in R]; N=len(R)

def sim(i0,buy,tp_pts,sl_pts):
    ep=C[i0]
    tp=ep+(tp_pts*PU if buy else -tp_pts*PU); sl=ep-(sl_pts*PU if buy else -sl_pts*PU)
    end=min(i0+1+MAXBARS,N)
    for j in range(i0+1,end):
        if (L[j]<=sl) if buy else (H[j]>=sl): return 0,-sl_pts,j-i0
        if (H[j]>=tp) if buy else (L[j]<=tp): return 1, tp_pts,j-i0
    if end>i0+1:
        j=end-1; pts=(C[j]-ep)/PU if buy else (ep-C[j])/PU
        return (1 if pts>0 else 0), pts, j-i0
    return None,None,None

CFG=sys.argv[1:] or ['A_baseline']
print('محاكاة بخطة المؤشر نفسه لكل صفقة • صفقة واحدة • وقف زمني %d شمعة\n'%MAXBARS)
print('%-24s %7s %7s %8s %9s %8s %8s %7s'%(
    'الإعداد','صفقات','فوز%','توقّع','صافي','م.هدف','م.وقف','مدة'))
print('─'*86)
for c in CFG:
    try: d=json.load(open('ab/%s.out.json'%c))
    except Exception: print('%-24s (غير موجود)'%c); continue
    wins=[];pts=[];tps=[];sls=[];durs=[]; busy=-1
    for e in d['entries']:
        i,side,tgt,stp = e[0],e[1],e[2],e[3]
        if i<=busy or i>=N-1: continue
        if not (tgt>0 and stp>0): continue
        w,p,b = sim(i, side>0, tgt, stp)
        if w is None: continue
        wins.append(w); pts.append(p); tps.append(tgt); sls.append(stp); durs.append(b)
        busy=i+b
    if not wins: print('%-24s (لا صفقات بخطة صالحة)'%c); continue
    n=len(wins)
    print('%-24s %7d %6.1f%% %+8.2f %9.0f %8.1f %8.1f %7.1f'%(
        c,n,100*sum(wins)/n,float(np.mean(pts)),float(np.sum(pts)),
        float(np.mean(tps)),float(np.mean(sls)),float(np.mean(durs))))
