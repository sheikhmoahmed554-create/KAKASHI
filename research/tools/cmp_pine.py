import json,sys,numpy as np,lab30
X=lab30.build(); D=X['D']; O=X['O']
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
d=json.load(open(sys.argv[1])); ev=d['entries']
def run(lo,hi,days):
    wins=[];pts=[];durs=[];busy=-1
    for i,side in ev:
        if i<lo or i>=hi or i<=busy or not valid[i]: continue
        sn='BUY' if side>0 else 'SELL'
        W,P,B,K=O[sn]
        if W[i]<0: continue
        wins.append(int(W[i])); pts.append(float(P[i])); durs.append(int(B[i])); busy=i+int(B[i])
    if not wins: return None
    N=len(wins); return N,100*sum(wins)/N,N/days,float(np.mean(pts)),float(np.mean(durs))
for lbl,lo,hi,days in (('تدريب',0,split,d_tr),('اختبار',split,n,d_te)):
    r=run(lo,hi,days)
    if r: print('  %-8s %5d صفقة  %5.1f%%  %5.1f/يوم  توقّع %+6.2f  مدة %.1f'%((lbl,)+r))
