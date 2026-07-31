"""اختبار حاسم: هل إشارات المؤشر مقلوبة؟ نقيسها كما هي ثم نعكسها."""
import json,numpy as np,lab30
X=lab30.build(); D=X['D']; O=X['O']
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
ev=json.load(open('/tmp/pineA2.json'))['entries']
def run(lo,hi,days,flip):
    wins=[];pts=[];busy=-1
    for i,side in ev:
        if i<lo or i>=hi or i<=busy or not valid[i]: continue
        s = -side if flip else side
        sn='BUY' if s>0 else 'SELL'
        W,P,B,K=O[sn]
        if W[i]<0: continue
        wins.append(int(W[i])); pts.append(float(P[i])); busy=i+int(B[i])
    if not wins: return None
    N=len(wins); return N,100*sum(wins)/N,N/days,float(np.mean(pts))
print('%-14s %8s %8s %8s %9s'%('','صفقات','فوز%','/يوم','توقّع'))
print('─'*52)
for flip in (False,True):
    lbl='مقلوبة' if flip else 'كما هي'
    for pn,lo,hi,days in (('تدريب',0,split,d_tr),('اختبار',split,n,d_te)):
        r=run(lo,hi,days,flip)
        if r: print('%-14s %8d %7.1f%% %8.1f %+9.2f'%(lbl+' '+pn,)+ '' if False else '%-14s %8d %7.1f%% %8.1f %+9.2f'%(lbl+' '+pn,r[0],r[1],r[2],r[3]))
