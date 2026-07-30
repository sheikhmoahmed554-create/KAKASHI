"""محاكاة تسلسلية للقواعد الجديدة المبنية على بُعد VWAP."""
import numpy as np, lab, json
X=lab.build(); D,F,L,S,LB,SB=X['D'],X['F'],X['L'],X['S'],X['LB'],X['SB']
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)

V=F['vwap_dist_atr']
RULES=[
 ('V1 بعيد عن VWAP + هدوء + تباطؤ','SELL',(V>18.37)&(F['atr14']<13.12)&(F['atr_accel']<0.7978)),
 ('V2 بعيد عن VWAP + هدوء + انكماش','SELL',(V>18.37)&(F['atr14']<13.12)&(F['atr_ratio']<0.7798)),
 ('V3 بعيد + هدوء + حجم منخفض','SELL',(V>18.37)&(F['atr14']<13.12)&(F['vol_ratio']<0.7971)),
 ('V4 أوسع: بعد 13.67 + هدوء','SELL',(V>13.67)&(F['atr14']<13.12)&(F['atr_accel']<0.7978)),
 ('V5 بعيد + قمة نطاق + تشبع','SELL',(V>18.37)&(F['pos20']>82.83)&(F['rsi3']>84.28)),
 ('B1 تشبع بيعي + اندفاع','BUY',(F['bb_z']<-2.094)&(F['vol_ratio']>1.356)&(F['pos20']<2.611)),
 ('B2 RSI3 منهار + اندفاع','BUY',(F['rsi3']<7.031)&(F['vol_ratio']>1.356)&(F['pos20']<2.611)),
 ('B3 قاع 240 + اندفاع','BUY',(F['pos240']<4.161)&(F['vol_ratio']>1.356)&(F['pos20']<2.611)),
]
def seq(masks, lo, hi):
    tr=[]; busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i]: continue
        for nm,sn,m in masks:
            if not m[i]: continue
            out,bars=(L,LB) if sn=='BUY' else (S,SB)
            if out[i]<0: continue
            tr.append((i,nm,sn,int(out[i]))); busy=i+int(bars[i]); break
    return tr
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
def rep(t,lbl,days):
    if not t: print('    %-8s لا صفقات'%lbl); return None
    w=sum(x[3] for x in t); N=len(t); wr=100*w/N; net=w*30-(N-w)*50
    print('    %-8s %4d صفقة  %4.1f/يوم  فوز %5.1f%%  صافي %+6.0f  توقّع %+5.2f'%(lbl,N,N/days,wr,net,net/N))
    return wr
print('التعادل 62.5%  |  محاكاة تسلسلية: صفقة واحدة في المرة\n')
keep=[]
for nm,sn,m in RULES:
    print('  ── %s (%s)'%(nm,sn))
    a=rep(seq([(nm,sn,m)],0,split),'تدريب',d_tr)
    b=rep(seq([(nm,sn,m)],split,n),'اختبار',d_te)
    if a and b and min(a,b)>=70: keep.append((nm,sn,m))
print('\n=== محفظة القواعد التي تجاوزت 70%% في الفترتين (%d قاعدة) ==='%len(keep))
if keep:
    rep(seq(keep,0,split),'تدريب',d_tr); rep(seq(keep,split,n),'اختبار',d_te)
print('\n=== المحفظة الكاملة (كل القواعد) ===')
rep(seq(RULES,0,split),'تدريب',d_tr); rep(seq(RULES,split,n),'اختبار',d_te)
