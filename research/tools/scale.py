"""منحنى المحفظة: كل ما نضيف عائلات، التردد بيزيد — والنسبة بتعمل إيه؟"""
import numpy as np, lab, itertools, json
X=lab.build(); D,F,L,S,LB,SB=X['D'],X['F'],X['L'],X['S'],X['LB'],X['SB']
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
TR=np.zeros(n,bool); TR[:split]=True; TE=~TR
OK={'BUY':L>=0,'SELL':S>=0}; OUT={'BUY':L,'SELL':S}
BASE={}
for pn,p in (('tr',TR),('te',TE)):
    for sn in ('BUY','SELL'):
        m=p&valid&OK[sn]; BASE[(pn,sn)]=float(OUT[sn][m].mean())*100
SKIP={'ema9','ema21','ema50','ema200','bb_mid','bb_sd','hh20','hh60','hh240',
      'll20','ll60','ll240','vwap','atr60','spread'}
q=lambda a,p: np.nanpercentile(a[np.isfinite(a)],p)
C={}
for f in F:
    if f in SKIP: continue
    a=F[f]
    if len(np.unique(a[:5000]))<=2: C['%s=1'%f]=a>0.5; continue
    for p in (3,8,15,85,92,97):
        t=q(a,p)
        if np.isfinite(t): C['%s%s%.4g'%(f,'<' if p<50 else '>',t)]=(a<t if p<50 else a>t)
fam=lambda s: s.split('<')[0].split('>')[0].split('=')[0]
names=list(C)
surv=[]
for combo in itertools.combinations(names,3):
    if len({fam(x) for x in combo})<3: continue
    m=C[combo[0]]&C[combo[1]]&C[combo[2]]
    if m.sum()<600: continue
    for sn in ('BUY','SELL'):
        xa=m&TR&valid&OK[sn]; ka=int(xa.sum())
        if ka<250: continue
        wa=float(OUT[sn][xa].mean())*100
        if wa-BASE[('tr',sn)]<3: continue
        xb=m&TE&valid&OK[sn]; kb=int(xb.sum())
        if kb<200: continue
        wb=float(OUT[sn][xb].mean())*100
        if wb-BASE[('te',sn)]<3: continue
        surv.append((' & '.join(combo),sn,m,min(wa,wb)))
surv.sort(key=lambda r:-r[3])
print('ناجون من الفرز السريع: %d'%len(surv), flush=True)
def seq(mask,sn,lo,hi):
    out,bars=(L,LB) if sn=='BUY' else (S,SB); idx=[]; res=[]; busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i] or not mask[i] or out[i]<0: continue
        idx.append(i); res.append(int(out[i])); busy=i+int(bars[i])
    return idx,res
cands=[]
for nm,sn,m,_ in surv[:900]:
    ia,ra=seq(m,sn,0,split)
    if len(ra)<45: continue
    ib,rb=seq(m,sn,split,n)
    if len(rb)<35: continue
    wa=100*sum(ra)/len(ra); wb=100*sum(rb)/len(rb)
    if min(wa,wb)<66: continue
    cands.append(dict(name=nm,side=sn,mask=m,idx_te=set(ib),wa=wa,wb=wb,score=min(wa,wb)))
cands.sort(key=lambda c:-c['score'])
print('اجتازوا المحاكاة (>=66%%): %d\n'%len(cands), flush=True)
def port(rs,lo,hi,days):
    tr=[]; busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i]: continue
        for nm,sn,m in rs:
            if not m[i]: continue
            out,bars=(L,LB) if sn=='BUY' else (S,SB)
            if out[i]<0: continue
            tr.append(int(out[i])); busy=i+int(bars[i]); break
    return (len(tr),100*sum(tr)/len(tr),len(tr)/days) if tr else None
for ov in (0.30, 0.50, 0.70):
    picked=[]
    for c in cands:
        if all(len(c['idx_te']&p['idx_te'])<=ov*min(len(c['idx_te']),len(p['idx_te'])) for p in picked):
            picked.append(c)
        if len(picked)>=60: break
    print('══ حد التداخل %.0f%% — عائلات متاحة: %d'%(ov*100,len(picked)), flush=True)
    print('   %6s | %8s %7s %8s | %8s %7s %8s'%('عائلات','عدد','فوز%','/يوم','عدد','فوز%','/يوم'))
    for k in (5,10,15,20,25,30,40,50,60):
        if k>len(picked): break
        rs=[(c['name'],c['side'],c['mask']) for c in picked[:k]]
        a=port(rs,0,split,d_tr); b=port(rs,split,n,d_te)
        if a and b:
            print('   %6d | %8d %6.1f%% %7.1f | %8d %6.1f%% %7.1f'%(k,a[0],a[1],a[2],b[0],b[1],b[2]), flush=True)
    print()
json.dump([{'name':c['name'],'side':c['side'],'wa':c['wa'],'wb':c['wb']} for c in cands[:120]],
          open('cands.json','w'), ensure_ascii=False)
