import json, csv, datetime, math, sys

R=list(csv.DictReader(open('vault.csv')))
H=[float(r['high']) for r in R]; L=[float(r['low']) for r in R]; N=len(R)
PU=0.1
NAMES={'finalS06':'الزخم Momentum','finalS09':'بولنجر+كلتنر (شراء فقط)','finalS11':'QQE + Vortex',
 'finalS12':'Balance Reset ★جديدة','finalS17':'Dead Auction ★جديدة','finalS18':'Ichimoku',
 'finalS19':'Side Pack / 331','finalS22':'السيولة Liquidity','finalS23':'Asia Break-Retest ★جديدة'}

d=json.load(open(sys.argv[1] if len(sys.argv)>1 else 'schools6m.json'))
sig=d['sig']; close=[float(x) for x in d['close']]; times=d['times']
n_bars=len(close)
TP,SL=float(sys.argv[2]) if len(sys.argv)>2 else 30.0, 50.0

def sim(i0, buy, ep, tp_pts=TP, sl_pts=SL, maxbars=600):
    tp = ep + (tp_pts*PU if buy else -tp_pts*PU)
    sl = ep - (sl_pts*PU if buy else -sl_pts*PU)
    for i in range(i0+1, min(i0+1+maxbars, N, n_bars)):
        if (L[i]<=sl if buy else H[i]>=sl): return 0
        if (H[i]>=tp if buy else L[i]<=tp): return 1
    return None

def run(name, series, dedupe=True):
    w=l=0; sides={'BUY':[0,0],'SELL':[0,0]}
    for i in range(1, min(len(series), n_bars-1)):
        s=series[i]
        if s==0: continue
        if dedupe and series[i-1]==s: continue     # أول شمعة في السلسلة فقط
        buy = s>0
        r=sim(i, buy, close[i])
        if r is None: continue
        k='BUY' if buy else 'SELL'
        sides[k][0]+=1; sides[k][1]+=r
        w+=r; l+=1-r
    return w,l,sides

be=100*SL/(TP+SL)
print('خطة الاختبار: هدف %g / وقف %g   •   نقطة التعادل %.1f%%'%(TP,SL,be))
print('كل مدرسة تُختبر وحدها: تُفتح صفقة عند إغلاق أول شمعة تُصدر فيها إشارة.')
print()
print('%-26s %8s %8s %9s %9s %10s'%('المدرسة','إشارات','فوز%','الحافة','الصافي','لكل صفقة'))
print('─'*76)
res=[]
for k in ['finalS06','finalS09','finalS11','finalS12','finalS17','finalS18','finalS19','finalS22','finalS23']:
    if k not in sig: continue
    w,l,sides=run(k, sig[k]); n=w+l
    if n<20:
        print('%-26s %8d  — عدد الإشارات أقل من أن يُقاس'%(NAMES[k],n)); continue
    wr=100*w/n; net=w*TP-l*SL; se=math.sqrt(0.625*0.375/n)*100
    res.append((k,n,wr,wr-be,net,net/n,se,sides))
    print('%-26s %8d %7.1f%% %+8.1f %9.0f %+9.2f'%(NAMES[k],n,wr,wr-be,net,net/n))
print('─'*76)
print()
print('التفصيل حسب الجهة:')
print('%-26s %-22s %-22s'%('المدرسة','شراء','بيع'))
for k,n,wr,edge,net,exp,se,sides in res:
    ps=[]
    for side in ('BUY','SELL'):
        c,ww=sides[side]
        ps.append('%4d إشارة  %5.1f%%'%(c,100*ww/c) if c>=20 else '%4d إشارة  —'%c)
    print('%-26s %-22s %-22s'%(NAMES[k],ps[0],ps[1]))
print()
print('الدلالة الإحصائية (انحراف الحافة عن الصفر):')
for k,n,wr,edge,net,exp,se,sides in sorted(res,key=lambda x:-x[3]):
    z=edge/se
    tag='حقيقية' if abs(z)>=2.5 else ('محتملة' if abs(z)>=1.8 else 'ضمن الضوضاء')
    print('  %-26s حافة %+6.1f  خطأ معياري %.1f  ->  %+5.2f σ  %s'%(NAMES[k],edge,se,z,tag))
