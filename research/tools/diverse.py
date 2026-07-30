"""عائلات قواعد مستقلة. فرز سريع بالمتجهات أولاً، ثم محاكاة تسلسلية للناجين فقط."""
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
print('شروط: %d | تركيبات ثلاثية محتملة: %d'%(len(names), len(names)*(len(names)-1)*(len(names)-2)//6), flush=True)

# ── المرحلة 1: فرز متجهي سريع ──
pre={}
for sn in ('BUY','SELL'):
    for pn,p in (('tr',TR),('te',TE)):
        pre[(sn,pn)]=(p&valid&OK[sn], OUT[sn])
survivors=[]
for combo in itertools.combinations(names,3):
    if len({fam(x) for x in combo})<3: continue
    m=C[combo[0]]&C[combo[1]]&C[combo[2]]
    tot=m.sum()
    if tot<600: continue
    for sn in ('BUY','SELL'):
        ma,out=pre[(sn,'tr')]; xa=m&ma
        ka=int(xa.sum())
        if ka<250: continue
        wa=float(out[xa].mean())*100
        if wa-BASE[('tr',sn)]<4: continue
        mb,_=pre[(sn,'te')]; xb=m&mb
        kb=int(xb.sum())
        if kb<200: continue
        wb=float(out[xb].mean())*100
        if wb-BASE[('te',sn)]<4: continue
        survivors.append((' & '.join(combo),sn,m,min(wa,wb)))
survivors.sort(key=lambda r:-r[3])
print('ناجون من الفرز السريع: %d'%len(survivors), flush=True)

# ── المرحلة 2: محاكاة تسلسلية لأفضل 400 ──
def seq(mask,sn,lo,hi):
    out,bars=(L,LB) if sn=='BUY' else (S,SB); idx=[]; res=[]; busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i] or not mask[i] or out[i]<0: continue
        idx.append(i); res.append(int(out[i])); busy=i+int(bars[i])
    return idx,res
cands=[]
for nm,sn,m,_ in survivors[:400]:
    ia,ra=seq(m,sn,0,split)
    if len(ra)<50: continue
    ib,rb=seq(m,sn,split,n)
    if len(rb)<40: continue
    wa=100*sum(ra)/len(ra); wb=100*sum(rb)/len(rb)
    if min(wa,wb)<68: continue
    cands.append(dict(name=nm,side=sn,wa=wa,wb=wb,na=len(ra),nb=len(rb),
                      pa=len(ra)/d_tr,pb=len(rb)/d_te,mask=m,
                      idx_te=set(ib),score=min(wa,wb)))
cands.sort(key=lambda c:-c['score'])
print('اجتازوا المحاكاة التسلسلية (>=68%% في الفترتين): %d\n'%len(cands), flush=True)

picked=[]
for c in cands:
    if all(len(c['idx_te']&p['idx_te']) <= 0.30*min(len(c['idx_te']),len(p['idx_te'])) for p in picked):
        picked.append(c)
    if len(picked)>=14: break
print('=== عائلات مستقلة (تداخل < 30%) ===')
print('%-56s %-5s %6s %6s %7s'%('القاعدة','جهة','تدريب','اختبار','/يوم'))
for c in picked:
    print('%-56s %-5s %5.1f%% %5.1f%% %6.2f'%(c['name'][:56],c['side'],c['wa'],c['wb'],c['pb']))
rules=[(c['name'],c['side'],c['mask']) for c in picked]
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
print()
for lbl,lo,hi,days in (('تدريب',0,split,d_tr),('اختبار',split,n,d_te)):
    r=port(rules,lo,hi,days)
    if r: print('محفظة العائلات — %s: %d صفقة، فوز %.1f%%، %.1f صفقة/يوم'%(lbl,r[0],r[1],r[2]))
json.dump([{k:v for k,v in c.items() if k not in ('mask','idx_te')} for c in picked],
          open('diverse.json','w'), ensure_ascii=False)
