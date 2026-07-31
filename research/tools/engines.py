"""يقيس كل محرك دخول في SYR30 وحده، ثم يبحث عن أفضل تركيبة منها.

يستخدم الجرد المستخرج مسبقاً (inventory_all.json) فيقيّم التركيبة في أجزاء الثانية
بدل 3 دقائق لكل تشغيل في المتصفح.
القيود: صفقة واحدة مفتوحة • وقف زمني 30 شمعة • خطة 39/55 (متوسط خطة المؤشر)."""
import json, csv, math, re, itertools, sys, numpy as np
PU=0.1; MAXBARS=30; TP,SL=39.0,55.0
R=list(csv.DictReader(open('vault.csv')))
H=[float(r['high']) for r in R]; L=[float(r['low']) for r in R]; C=[float(r['close']) for r in R]
import datetime
HR=[datetime.datetime.fromisoformat(r['time']).hour for r in R]
TS=[datetime.datetime.fromisoformat(r['time']).timestamp() for r in R]
N=len(R)
GAP=[True]+[ (TS[i]-TS[i-1])>300 for i in range(1,N) ]
VALID=[(HR[i]<22) and (not GAP[i]) for i in range(N)]

# نتائج مسبقة: لكل شمعة، ماذا يحدث لو دخلنا شراءً/بيعاً
def precompute():
    out={}
    for side,buy in (('BUY',True),('SELL',False)):
        W=np.full(N,-1,np.int8); B=np.zeros(N,np.int16)
        for i in range(N-1):
            ep=C[i]; tp=ep+(TP*PU if buy else -TP*PU); sl=ep-(SL*PU if buy else -SL*PU)
            end=min(i+1+MAXBARS,N); done=False
            for j in range(i+1,end):
                if (L[j]<=sl) if buy else (H[j]>=sl): W[i]=0; B[i]=j-i; done=True; break
                if (H[j]>=tp) if buy else (L[j]<=tp): W[i]=1; B[i]=j-i; done=True; break
            if not done and end>i+1:
                j=end-1; pts=(C[j]-ep)/PU if buy else (ep-C[j])/PU
                W[i]=1 if pts>0 else 0; B[i]=j-i
        out[side]=(W,B)
    return out
print('بحساب النتائج مسبقاً...', flush=True)
O=precompute()
print('تم.\n', flush=True)

d=json.load(open('inventory_all.json')); fires=d['fires']; nbars=min(d['bars'],N)
def side_of(nm):
    if nm.endswith('Buy') or nm.endswith('Long') or nm.endswith('B'): return 'BUY'
    if nm.endswith('Sell') or nm.endswith('Short') or nm.endswith('S'): return 'SELL'
    if re.search(r'(Buy|Long)',nm): return 'BUY'
    if re.search(r'(Sell|Short)',nm): return 'SELL'
    return None
# قناع لكل إشارة
ENG={}
for nm,ev in fires.items():
    if not ev: continue
    sn=side_of(nm)
    if sn is None: continue
    m=np.zeros(N,bool)
    for i in ev:
        if i<N: m[i]=True
    if m.sum()<80: continue
    ENG[nm]=(sn,m)
print('محركات قابلة للقياس: %d'%len(ENG), flush=True)

VAL=np.array(VALID)
def run(pairs, lo=0, hi=None):
    """pairs = [(side, mask), ...] تُجمَع بـ OR لكل جهة."""
    hi = hi or nbars
    bm=np.zeros(N,bool); sm=np.zeros(N,bool)
    for sn,m in pairs:
        if sn=='BUY': bm|=m
        else: sm|=m
    WB,BB=O['BUY']; WS,BS=O['SELL']
    tp=sl=tw=tl=0; busy=-1
    for i in range(lo,hi):
        if i<=busy or not VAL[i]: continue
        if bm[i] and not sm[i]:
            if WB[i]<0: continue
            w,b=int(WB[i]),int(BB[i])
        elif sm[i] and not bm[i]:
            if WS[i]<0: continue
            w,b=int(WS[i]),int(BS[i])
        else: continue
        busy=i+b
        if w: tp+=1
        else: sl+=1
    n=tp+sl
    return (n, 100*tp/n if n else 0)

print('\n=== كل محرك وحده (أفضل 25) ===')
print('%-30s %-5s %8s %8s'%('المحرك','جهة','صفقات','فوز%'))
print('─'*56)
solo=[]
for nm,(sn,m) in ENG.items():
    n,wr = run([(sn,m)])
    if n>=100: solo.append((nm,sn,m,n,wr))
solo.sort(key=lambda x:-x[4])
for nm,sn,m,n,wr in solo[:25]:
    print('%-30s %-5s %8d %7.2f%%'%(nm[:30],sn,n,wr))
json.dump([[x[0],x[1],x[3],round(x[4],2)] for x in solo],open('engines_solo.json','w'))
print('\nمحركات مقيسة: %d  |  فوق 62%%: %d  |  فوق 60%%: %d'%(
    len(solo),sum(1 for x in solo if x[4]>62),sum(1 for x in solo if x[4]>60)))
