import numpy as np, lab, json, math
X=lab.build(); D,F,L,S,LB,SB=X['D'],X['F'],X['L'],X['S'],X['LB'],X['SB']
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
q=lambda f,p: np.nanpercentile(F[f][np.isfinite(F[f])],p)

RULES=[
 ('S1 هدوء + منتصف اليوم',   'SELL', (F['atr14']<15.67)&(F['vol_ratio']<0.8634)&(D['hour']>=10)&(D['hour']<12)),
 ('S2 هدوء + قمة النطاق',    'SELL', (F['atr14']<15.67)&(F['vol_ratio']<0.6974)&(F['pos20']>82.83)),
 ('S3 هدوء + تشبع شرائي',    'SELL', (F['atr14']<17.98)&(F['rsi3']>84.28)&(D['hour']>=10)&(D['hour']<12)),
 ('B1 تشبع بيعي + اندفاع',   'BUY',  (F['bb_z']<-2.094)&(F['vol_ratio']>1.356)&(F['pos20']<2.611)),
 ('B2 RSI3 منهار + اندفاع',  'BUY',  (F['rsi3']<7.031)&(F['vol_ratio']>1.356)&(F['pos20']<2.611)),
 ('B3 قاع 240 + اندفاع',     'BUY',  (F['pos240']<4.161)&(F['vol_ratio']>1.356)&(F['pos20']<2.611)),
]

def sequential(masks, lo, hi):
    """محاكاة واقعية: صفقة واحدة في المرة، لا نفتح جديدة قبل إغلاق الحالية."""
    trades=[]; busy_until=-1
    for i in range(lo,hi):
        if i<=busy_until or not valid[i]: continue
        for nm,sn,m in masks:
            if not m[i]: continue
            out,bars=(L,LB) if sn=='BUY' else (S,SB)
            if out[i]<0: continue
            trades.append((i,nm,sn,int(out[i])))
            busy_until=i+int(bars[i]); break
    return trades

def report(trades,lbl,days):
    if not trades: print('  %s: لا صفقات'%lbl); return
    w=sum(t[3] for t in trades); N=len(trades)
    wr=100*w/N; net=w*X['tp']-(N-w)*X['sl']
    print('  %-8s %5d صفقة  %5.1f/يوم  فوز %5.1f%%  صافي %+7.0f نقطة  توقّع %+5.2f/صفقة'%(
        lbl,N,N/days,wr,net,net/N))
    return wr,N/days

days_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
days_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
print('التعادل %.1f%%  |  أيام تدريب %d، أيام اختبار %d\n'%(100*X['sl']/(X['tp']+X['sl']),days_tr,days_te))

print('كل قاعدة وحدها (محاكاة تسلسلية):')
for nm,sn,m in RULES:
    print('  ── %s (%s)'%(nm,sn))
    report(sequential([(nm,sn,m)],0,split),'تدريب',days_tr)
    report(sequential([(nm,sn,m)],split,n),'اختبار',days_te)

print('\nالمحفظة الكاملة (كل القواعد مع بعض):')
report(sequential(RULES,0,split),'تدريب',days_tr)
report(sequential(RULES,split,n),'اختبار',days_te)

print('\nالمحفظة — بيع فقط:')
sells=[r for r in RULES if r[1]=='SELL']
report(sequential(sells,0,split),'تدريب',days_tr)
report(sequential(sells,split,n),'اختبار',days_te)
print('\nالمحفظة — شراء فقط:')
buys=[r for r in RULES if r[1]=='BUY']
report(sequential(buys,0,split),'تدريب',days_tr)
report(sequential(buys,split,n),'اختبار',days_te)
