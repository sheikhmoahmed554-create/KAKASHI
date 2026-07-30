"""لكل قاعدة: ما هي خطة الخروج المثلى داخل القيود (هدف 30-60، وقف <= هدف+20)؟"""
import numpy as np, lab, itertools
D=lab.load(); F=lab.features(D); n=D['n']
valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
V=F['vwap_dist_atr']
RULES=[
 ('V5 بعيد VWAP + قمة + تشبع','SELL',(V>18.37)&(F['pos20']>82.83)&(F['rsi3']>84.28)),
 ('V3 بعيد + هدوء + حجم منخفض','SELL',(V>18.37)&(F['atr14']<13.12)&(F['vol_ratio']<0.7971)),
 ('B1 تشبع بيعي + اندفاع','BUY',(F['bb_z']<-2.094)&(F['vol_ratio']>1.356)&(F['pos20']<2.611)),
 ('B2 RSI3 منهار + اندفاع','BUY',(F['rsi3']<7.031)&(F['vol_ratio']>1.356)&(F['pos20']<2.611)),
 ('B3 قاع 240 + اندفاع','BUY',(F['pos240']<4.161)&(F['vol_ratio']>1.356)&(F['pos20']<2.611)),
]
PLANS=[(tp,sl) for tp in (30,35,40,45,50,55,60) for sl in (30,35,40,45,50,55,60,70,75,80)
       if sl<=tp+20]
print('خطط مسموحة: %d\n'%len(PLANS))
cache={}
for tp,sl in PLANS:
    cache[(tp,sl)]=lab.outcomes(D,tp,sl)
print('تم حساب كل الخطط.\n')

def seq(mask,sn,lo,hi,L,S,LB,SB):
    tr=[]; busy=-1
    out,bars=(L,LB) if sn=='BUY' else (S,SB)
    for i in range(lo,hi):
        if i<=busy or not valid[i] or not mask[i] or out[i]<0: continue
        tr.append(int(out[i])); busy=i+int(bars[i])
    return tr
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))

for nm,sn,m in RULES:
    print('══ %s (%s)'%(nm,sn))
    rows=[]
    for (tp,sl),(L,S,LB,SB) in cache.items():
        a=seq(m,sn,0,split,L,S,LB,SB); b=seq(m,sn,split,n,L,S,LB,SB)
        if len(a)<40 or len(b)<40: continue
        wa=100*sum(a)/len(a); wb=100*sum(b)/len(b)
        ea=sum(a)*tp-(len(a)-sum(a))*sl; eb=sum(b)*tp-(len(b)-sum(b))*sl
        rows.append((tp,sl,len(a),wa,ea/len(a),len(b),wb,eb/len(b),min(ea/len(a),eb/len(b))))
    rows.sort(key=lambda r:-r[8])
    print('   %4s %4s | %5s %6s %7s | %5s %6s %7s'%('هدف','وقف','عدد','فوز%','توقّع','عدد','فوز%','توقّع'))
    for r in rows[:4]:
        print('   %4d %4d | %5d %5.1f%% %+6.2f | %5d %5.1f%% %+6.2f'%(r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7]))
    cur=[r for r in rows if r[0]==30 and r[1]==50]
    if cur: print('   الحالي 30/50: تدريب %5.1f%% %+6.2f | اختبار %5.1f%% %+6.2f'%(cur[0][3],cur[0][4],cur[0][6],cur[0][7]))
    print()
