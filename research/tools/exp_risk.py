"""قياس التزامن والسحب — المخاطرة الحقيقية للمحفظة."""
from setup_common import *
import itertools, json, numpy as np
C=conditions(); names=list(C)
surv=[]
for combo in itertools.combinations(names,3):
    if len({fam(x) for x in combo})<3: continue
    m=C[combo[0]]&C[combo[1]]&C[combo[2]]
    if m.sum()<600: continue
    for sn in ('BUY','SELL'):
        xa=m&TR&valid&OK[sn]
        if xa.sum()<250: continue
        wa=float(OUT[sn][xa].mean())*100
        if wa-BASE[('tr',sn)]<3: continue
        xb=m&TE&valid&OK[sn]
        if xb.sum()<200: continue
        wb=float(OUT[sn][xb].mean())*100
        if wb-BASE[('te',sn)]<3: continue
        surv.append((' & '.join(combo),sn,m,min(wa,wb)))
surv.sort(key=lambda r:-r[3])
cands=[]
for nm,sn,m,_ in surv[:900]:
    ia,ra=seq(m,sn,0,split); ib,rb=seq(m,sn,split,n)
    if len(ra)<45 or len(rb)<35: continue
    wa=100*sum(ra)/len(ra); wb=100*sum(rb)/len(rb)
    if min(wa,wb)<66: continue
    cands.append(dict(name=nm,side=sn,mask=m,idx_te=set(ib),score=min(wa,wb)))
cands.sort(key=lambda c:-c['score'])
picked=[]
for c in cands:
    if all(len(c['idx_te']&p['idx_te'])<=0.30*min(len(c['idx_te']),len(p['idx_te'])) for p in picked):
        picked.append(c)
    if len(picked)>=30: break
R=[(c['name'],c['side'],c['mask']) for c in picked]
print('عائلات: %d'%len(R), flush=True)
TP,SL=30.0,50.0
def run(lo,hi,maxpos,cd):
    openpos=[]; peak=0; eq=0.0; mineq=0.0; maxdd=0.0; conc=[]; trades=[]
    last={}
    for i in range(lo,hi):
        openpos=[(u,p) for u,p in openpos if u>i]
        if valid[i]:
            for j,(nm,sn,m) in enumerate(R):
                if len(openpos)>=maxpos: break
                if not m[i]: continue
                if cd and i-last.get(j,-10**9)<cd: continue
                out,bars=(L,LB) if sn=='BUY' else (S,SB)
                if out[i]<0: continue
                pts=TP if out[i]==1 else -SL
                openpos.append((i+int(bars[i]),pts)); last[j]=i
                trades.append(int(out[i]))
        conc.append(len(openpos))
        # منحنى الأسهم عند إغلاق الصفقات
        closed=[p for u,p in openpos if u<=i]
        eq+=sum(closed)
        peak=max(peak,eq); maxdd=max(maxdd,peak-eq)
    return trades,conc,maxdd
print('%10s %8s | %8s %7s %8s %9s %10s'%('أقصى','تهدئة','صفقات','فوز%','/يوم','أقصى تزامن','أسوأ سحب'))
for maxpos in (1,3,5,8,999):
    for cd in (0,15):
        tr,conc,dd=run(split,n,maxpos,cd)
        if not tr: continue
        c=np.array(conc)
        print('%10s %8d | %8d %6.1f%% %7.1f %9d %10.0f'%(
            maxpos if maxpos<999 else 'بلا حد',cd,len(tr),100*sum(tr)/len(tr),
            len(tr)/d_te,c.max(),dd), flush=True)
