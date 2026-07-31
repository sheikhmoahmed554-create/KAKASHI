"""بحث تركيبي على محركات SYR30: ثنائي ← ثلاثي ← رباعي، بدمج OR.
يُشغَّل بعد engines.py الذي يحفظ engines_solo.json."""
import json, csv, re, itertools, datetime, numpy as np
PU=0.1; MAXBARS=30; TP,SL=39.0,55.0; BE=100*SL/(TP+SL)
R=list(csv.DictReader(open('vault.csv')))
H=[float(r['high']) for r in R]; L=[float(r['low']) for r in R]; C=[float(r['close']) for r in R]
HR=[datetime.datetime.fromisoformat(r['time']).hour for r in R]
TS=[datetime.datetime.fromisoformat(r['time']).timestamp() for r in R]
N=len(R)
VAL=np.array([True]+[(HR[i]<22) and (TS[i]-TS[i-1])<=300 for i in range(1,N)])
def precompute():
    out={}
    for side,buy in (('BUY',True),('SELL',False)):
        W=np.full(N,-1,np.int8); B=np.zeros(N,np.int16)
        for i in range(N-1):
            ep=C[i]; tp=ep+(TP*PU if buy else -TP*PU); sl=ep-(SL*PU if buy else -SL*PU)
            end=min(i+1+MAXBARS,N); done=False
            for j in range(i+1,end):
                if (L[j]<=sl) if buy else (H[j]>=sl): W[i]=0;B[i]=j-i;done=True;break
                if (H[j]>=tp) if buy else (L[j]<=tp): W[i]=1;B[i]=j-i;done=True;break
            if not done and end>i+1:
                j=end-1; pts=(C[j]-ep)/PU if buy else (ep-C[j])/PU
                W[i]=1 if pts>0 else 0; B[i]=j-i
        out[side]=(W,B)
    return out
print('حساب مسبق...',flush=True); O=precompute(); print('تم.\n',flush=True)
d=json.load(open('inventory_all.json')); fires=d['fires']; nbars=min(d['bars'],N)
SPLIT=int(nbars*0.6)
def side_of(nm):
    if nm.endswith(('Buy','Long','B')): return 'BUY'
    if nm.endswith(('Sell','Short','S')): return 'SELL'
    if re.search(r'(Buy|Long)',nm): return 'BUY'
    if re.search(r'(Sell|Short)',nm): return 'SELL'
    return None
ENG={}
for nm,ev in fires.items():
    if not ev: continue
    sn=side_of(nm)
    if sn is None: continue
    m=np.zeros(N,bool)
    for i in ev:
        if i<N: m[i]=True
    if m.sum()>=80: ENG[nm]=(sn,m)
WB,BB=O['BUY']; WS,BS=O['SELL']
def run(bm,sm,lo,hi):
    tp=sl=0; busy=-1
    for i in range(lo,hi):
        if i<=busy or not VAL[i]: continue
        b_,s_=bm[i],sm[i]
        if b_ and not s_:
            if WB[i]<0: continue
            w,dur=int(WB[i]),int(BB[i])
        elif s_ and not b_:
            if WS[i]<0: continue
            w,dur=int(WS[i]),int(BS[i])
        else: continue
        busy=i+dur
        if w: tp+=1
        else: sl+=1
    n=tp+sl
    return n,(100*tp/n if n else 0)
def masks(names):
    bm=np.zeros(N,bool); sm=np.zeros(N,bool)
    for nm in names:
        sn,m=ENG[nm]
        if sn=='BUY': bm|=m
        else: sm|=m
    return bm,sm
def ev(names):
    bm,sm=masks(names)
    na,wa=run(bm,sm,0,SPLIT); nb,wb=run(bm,sm,SPLIT,nbars)
    if na<60 or nb<40: return None
    return na,wa,nb,wb,min(wa,wb)
solo=json.load(open('engines_solo.json'))
cand=[x[0] for x in solo if x[3]>=BE][:60]
print('مرشحون فوق التعادل: %d من %d\n'%(len(cand),len(solo)),flush=True)
best={1:[],2:[],3:[],4:[]}
for nm in cand:
    r=ev([nm])
    if r: best[1].append(([nm],)+r)
best[1].sort(key=lambda x:-x[5])
top1=[x[0][0] for x in best[1][:35]]
for a,b in itertools.combinations(top1,2):
    r=ev([a,b])
    if r: best[2].append(([a,b],)+r)
best[2].sort(key=lambda x:-x[5]); best[2]=best[2][:400]
print('ثنائيات مقيسة: %d'%len(best[2]),flush=True)
for combo,_,_,_,_,_ in best[2][:120]:
    for c in top1:
        if c in combo: continue
        r=ev(combo+[c])
        if r: best[3].append((combo+[c],)+r)
seen=set(); u3=[]
for combo,*rest in sorted(best[3],key=lambda x:-x[5]):
    k=frozenset(combo)
    if k in seen: continue
    seen.add(k); u3.append((combo,)+tuple(rest))
best[3]=u3[:400]
print('ثلاثيات فريدة: %d'%len(best[3]),flush=True)
for combo,*_ in best[3][:120]:
    for c in top1:
        if c in combo: continue
        r=ev(combo+[c])
        if r: best[4].append((combo+[c],)+r)
seen=set(); u4=[]
for combo,*rest in sorted(best[4],key=lambda x:-x[5]):
    k=frozenset(combo)
    if k in seen: continue
    seen.add(k); u4.append((combo,)+tuple(rest))
best[4]=u4[:400]
print('رباعيات فريدة: %d\n'%len(best[4]),flush=True)
print('التعادل %.2f%%  |  الأساس (كل المصادر) ≈ 58.98%%\n'%BE)
for k in (1,2,3,4):
    if not best[k]: continue
    print('══ أفضل %d محرك مجتمعة'%k)
    print('  %8s %7s %8s %7s   %s'%('تدريب','فوز%','اختبار','فوز%','المحركات'))
    for combo,na,wa,nb,wb,sc in best[k][:8]:
        print('  %8d %6.2f%% %8d %6.2f%%   %s'%(na,wa,nb,wb,' + '.join(combo)[:64]))
    print()
json.dump({str(k):[[c,na,round(wa,2),nb,round(wb,2)] for c,na,wa,nb,wb,_ in v[:100]]
           for k,v in best.items()}, open('combos.json','w'))
