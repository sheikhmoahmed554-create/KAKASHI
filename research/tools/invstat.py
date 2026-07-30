"""يقيس كل إشارة في المؤشر وحدها: نسبة الفوز، الحافة، الدلالة الإحصائية."""
import json, csv, math, sys, re, numpy as np
PU=0.1; MAXBARS=30
TP,SL = (float(sys.argv[2]),float(sys.argv[3])) if len(sys.argv)>3 else (39.0,55.0)  # متوسط خطة المؤشر
R=list(csv.DictReader(open('vault.csv')))
H=[float(r['high']) for r in R]; L=[float(r['low']) for r in R]; C=[float(r['close']) for r in R]; N=len(R)
def sim(i0,buy):
    ep=C[i0]; tp=ep+(TP*PU if buy else -TP*PU); sl=ep-(SL*PU if buy else -SL*PU)
    end=min(i0+1+MAXBARS,N)
    for j in range(i0+1,end):
        if (L[j]<=sl) if buy else (H[j]>=sl): return 0,-SL
        if (H[j]>=tp) if buy else (L[j]<=tp): return 1, TP
    if end>i0+1:
        j=end-1; pts=(C[j]-ep)/PU if buy else (ep-C[j])/PU
        return (1 if pts>0 else 0), pts
    return None,None
d=json.load(open(sys.argv[1]))
fires=d['fires']; nbars=d['bars']
split=int(nbars*0.6)
BE=100*SL/(TP+SL)
# خط الأساس: الدخول عند كل شمعة
base={}
for side,buy in (('BUY',True),('SELL',False)):
    for lbl,lo,hi in (('tr',1,split),('te',split,nbars-1)):
        ws=[sim(i,buy)[0] for i in range(lo,hi,7)]
        ws=[w for w in ws if w is not None]
        base[(side,lbl)]=100*sum(ws)/len(ws)
print('خطة %g/%g • تعادل %.1f%% • وقف زمني %d شمعة'%(TP,SL,BE,MAXBARS))
print('خط الأساس: شراء tr %.1f te %.1f | بيع tr %.1f te %.1f\n'%(
    base[('BUY','tr')],base[('BUY','te')],base[('SELL','tr')],base[('SELL','te')]))
rows=[]
for name,ev in fires.items():
    if not ev: continue
    if name.endswith('Buy') or name.endswith('Long'): buy=True
    elif name.endswith('Sell') or name.endswith('Short'): buy=False
    elif re.search(r'(Buy|Long)', name): buy=True
    elif re.search(r'(Sell|Short)', name): buy=False
    elif name.endswith('B'): buy=True
    elif name.endswith('S'): buy=False
    else: continue
    side = 'BUY' if buy else 'SELL'
    a=[];b=[]
    for i in ev:
        if i>=N-1: continue
        w,_=sim(i,buy)
        if w is None: continue
        (a if i<split else b).append(w)
    if len(a)<40 or len(b)<25: continue
    wa=100*sum(a)/len(a); wb=100*sum(b)/len(b)
    ea=wa-base[(side,'tr')]; eb=wb-base[(side,'te')]
    se=math.sqrt(0.6*0.4/(len(a)+len(b)))*100
    rows.append((name,side,len(a),len(b),wa,wb,ea,eb,min(ea,eb),(min(ea,eb))/se))
rows.sort(key=lambda r:-r[8])
print('=== أقوى الإشارات (مرتبة بأضعف الفترتين، زيادة فوق خط الأساس) ===')
print('%-34s %-5s %6s %6s %7s %7s %7s %7s %7s'%('الإشارة','جهة','تدريب','اختبار','فوز tr','فوز te','زيادة tr','زيادة te','σ'))
print('─'*100)
for r in rows[:28]:
    print('%-34s %-5s %6d %6d %6.1f%% %6.1f%% %+7.1f %+8.1f %+6.1f'%(r[0][:34],r[1],r[2],r[3],r[4],r[5],r[6],r[7],r[9]))
print('─'*100)
print('\nإجمالي مقيسة: %d  |  زيادتها موجبة في الفترتين: %d'%(len(rows),sum(1 for r in rows if r[8]>0)))
json.dump([{'name':r[0],'side':r[1],'n_tr':r[2],'n_te':r[3],'wr_tr':r[4],'wr_te':r[5],
            'exc_tr':r[6],'exc_te':r[7],'score':r[8],'sigma':r[9]} for r in rows],
          open('inventory_scores.json','w'), ensure_ascii=False)
