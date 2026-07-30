"""تجهيز مشترك: العائلات المختارة + دوال المحاكاة. يُستورَد من تجارب متعددة."""
import numpy as np, lab, itertools
X=lab.build(); D,F,L,S,LB,SB=X['D'],X['F'],X['L'],X['S'],X['LB'],X['SB']
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
TR=np.zeros(n,bool); TR[:split]=True; TE=~TR
OK={'BUY':L>=0,'SELL':S>=0}; OUT={'BUY':L,'SELL':S}
BASE={}
for pn,p in (('tr',TR),('te',TE)):
    for sn in ('BUY','SELL'):
        m=p&valid&OK[sn]; BASE[(pn,sn)]=float(OUT[sn][m].mean())*100
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
SKIP={'ema9','ema21','ema50','ema200','bb_mid','bb_sd','hh20','hh60','hh240',
      'll20','ll60','ll240','vwap','atr60','spread'}
q=lambda a,p: np.nanpercentile(a[np.isfinite(a)],p)
def conditions(pcts=(3,8,15,85,92,97)):
    C={}
    for f in F:
        if f in SKIP: continue
        a=F[f]
        if len(np.unique(a[:5000]))<=2: C['%s=1'%f]=a>0.5; continue
        for p in pcts:
            t=q(a,p)
            if np.isfinite(t): C['%s%s%.4g'%(f,'<' if p<50 else '>',t)]=(a<t if p<50 else a>t)
    return C
fam=lambda s: s.split('<')[0].split('>')[0].split('=')[0]
def seq(mask,sn,lo,hi):
    out,bars=(L,LB) if sn=='BUY' else (S,SB); idx=[]; res=[]; busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i] or not mask[i] or out[i]<0: continue
        idx.append(i); res.append(int(out[i])); busy=i+int(bars[i])
    return idx,res
