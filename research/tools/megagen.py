"""توليد قواعد على نطاق واسع: عدة شعاعات ببدايات مختلفة لزيادة التنوع.
الهدف: رفع التردد من 6.3 إلى 30 صفقة/يوم دون خفض نسبة الفوز."""
import numpy as np, methods, lab, lab30, itertools, json, time, sys
X30=lab30.build(); D=X30['D']; O=X30['O']
_,F = methods.all_features(D)
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
TR=np.zeros(n,bool); TR[:split]=True; TE=~TR
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
BASE={}
for pn,p in (('tr',TR),('te',TE)):
    for sn in ('BUY','SELL'):
        W=O[sn][0]; m=p&valid&(W>=0); BASE[(pn,sn)]=float(W[m].mean())*100
SKIP={'ema9','ema21','ema50','ema200','bb_mid','bb_sd','hh20','hh60','hh240',
      'll20','ll60','ll240','vwap','atr60','spread'}
q=lambda a,p: np.nanpercentile(a[np.isfinite(a)],p)
def make_conds(pcts):
    C={}
    for f in F:
        if f in SKIP: continue
        a=F[f]
        if len(np.unique(a[:8000]))<=2:
            if 0.001 < a.mean() < 0.6: C['%s=1'%f]=a>0.5
            continue
        for p in pcts:
            t=q(a,p)
            if np.isfinite(t): C['%s%s%.4g'%(f,'<' if p<50 else '>',t)]=(a<t if p<50 else a>t)
    return C
fam=lambda s: s.split('<')[0].split('>')[0].split('=')[0]
def score(m,sn,mn_tr,mn_te):
    W=O[sn][0]
    xa=m&TR&valid&(W>=0); ka=int(xa.sum())
    if ka<mn_tr: return None
    wa=float(W[xa].mean())*100
    xb=m&TE&valid&(W>=0); kb=int(xb.sum())
    if kb<mn_te: return None
    wb=float(W[xb].mean())*100
    return wa,wb,min(wa-BASE[('tr',sn)], wb-BASE[('te',sn)])
def seq(mask,sn,lo,hi):
    W,P,B,K=O[sn]; idx=[]; res=[]; busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i] or not mask[i] or W[i]<0: continue
        idx.append(i); res.append(int(W[i])); busy=i+int(B[i])
    return idx,res

# ثلاثة شعاعات بعتبات مئوية مختلفة => تنوّع أكبر في القواعد
BEAMS=[((2,5,10,20,80,90,95,98), 200, 4.0),
       ((1,3,7,12,88,93,97,99),  200, 4.0),
       ((5,15,25,35,65,75,85,95),200, 3.0)]
allrules={}
t0=time.time()
for bi,(pcts,keep1,minexc) in enumerate(BEAMS,1):
    C=make_conds(pcts); names=list(C)
    l1=[]
    for nm,m in C.items():
        for sn in ('BUY','SELL'):
            r=score(m,sn,250,180)
            if r and r[2]>0.5: l1.append((nm,sn,m,r[2]))
    l1.sort(key=lambda x:-x[3]); l1=l1[:keep1]
    l2=[]
    for (n1,s1,m1,_),(n2,s2,m2,_) in itertools.combinations(l1,2):
        if s1!=s2 or fam(n1)==fam(n2): continue
        m=m1&m2; r=score(m,s1,200,150)
        if r and r[2]>2: l2.append(((n1,n2),s1,m,r[2]))
    l2.sort(key=lambda x:-x[3]); l2=l2[:1200]
    l3=[]
    for combo,sn,m,_ in l2:
        fams={fam(x) for x in combo}
        for n3,s3,m3,_ in l1:
            if s3!=sn or fam(n3) in fams: continue
            mm=m&m3; r=score(mm,sn,120,90)
            if r and r[2]>minexc: l3.append((combo+(n3,),sn,mm,r[2]))
    l3.sort(key=lambda x:-x[3])
    seen=set(); cnt=0
    for combo,sn,m,sc in l3:
        k=(frozenset(combo),sn)
        if k in seen: continue
        seen.add(k)
        nm=' & '.join(combo)
        if (nm,sn) in allrules: continue
        ia,ra=seq(m,sn,0,split); ib,rb=seq(m,sn,split,n)
        if len(ra)<30 or len(rb)<20: continue
        wa=100*sum(ra)/len(ra); wb=100*sum(rb)/len(rb)
        if min(wa,wb)<68: continue
        allrules[(nm,sn)]=dict(name=nm,side=sn,wa=wa,wb=wb,nb=len(rb),
                               pb=len(rb)/d_te,idx=ib)
        cnt+=1
        if cnt>=600: break
    print('شعاع %d: %d قاعدة جديدة | الإجمالي %d | %.0f ث'%(bi,cnt,len(allrules),time.time()-t0), flush=True)
out=sorted(allrules.values(), key=lambda c:-min(c['wa'],c['wb']))
json.dump([{k:v for k,v in c.items() if k!='idx'} for c in out], open('megagen_rules.json','w'), ensure_ascii=False)
json.dump({'%s|%s'%(c['name'],c['side']):c['idx'] for c in out}, open('megagen_idx.json','w'))
print('\nإجمالي القواعد: %d'%len(out))
print('أفضل 8:')
for c in out[:8]:
    print('  %-72s %-5s %5.1f%%/%5.1f%%  %4.2f/يوم'%(c['name'][:72],c['side'],c['wa'],c['wb'],c['pb']))
