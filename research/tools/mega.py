"""بحث شعاعي متدرّج على مكتبة الـ112 خاصية: مفرد ← ثنائي ← ثلاثي ← رباعي."""
import numpy as np, methods, lab, itertools, json, time
D,F = methods.all_features()
X = lab.build()                      # النتائج المحسوبة مسبقاً لخطة 30/50
L,S,LB,SB = X['L'],X['S'],X['LB'],X['SB']
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
TR=np.zeros(n,bool); TR[:split]=True; TE=~TR
OK={'BUY':L>=0,'SELL':S>=0}; OUT={'BUY':L,'SELL':S}
BASE={}
for pn,p in (('tr',TR),('te',TE)):
    for sn in ('BUY','SELL'):
        m=p&valid&OK[sn]; BASE[(pn,sn)]=float(OUT[sn][m].mean())*100
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
SKIP={'ema9','ema21','ema50','ema200','bb_mid','bb_sd','hh20','hh60','hh240',
      'll20','ll60','ll240','vwap','atr60','spread'}
q=lambda a,p: np.nanpercentile(a[np.isfinite(a)],p)
C={}
for f in F:
    if f in SKIP: continue
    a=F[f]
    if len(np.unique(a[:8000]))<=2:
        if 0.001 < a.mean() < 0.5: C['%s=1'%f]=a>0.5
        continue
    for p in (2,5,10,20,80,90,95,98):
        t=q(a,p)
        if np.isfinite(t): C['%s%s%.4g'%(f,'<' if p<50 else '>',t)]=(a<t if p<50 else a>t)
fam=lambda s: s.split('<')[0].split('>')[0].split('=')[0]
print('خصائص %d  |  شروط %d'%(len(F),len(C)), flush=True)

def score(m,sn,minn_tr=250,minn_te=180):
    xa=m&TR&valid&OK[sn]; ka=int(xa.sum())
    if ka<minn_tr: return None
    wa=float(OUT[sn][xa].mean())*100
    xb=m&TE&valid&OK[sn]; kb=int(xb.sum())
    if kb<minn_te: return None
    wb=float(OUT[sn][xb].mean())*100
    return (wa,wb,min(wa-BASE[('tr',sn)], wb-BASE[('te',sn)]),ka,kb)

t0=time.time()
# ── المستوى 1 ──
lvl1=[]
for nm,m in C.items():
    for sn in ('BUY','SELL'):
        r=score(m,sn)
        if r and r[2]>0.5: lvl1.append((nm,sn,m,r[2]))
lvl1.sort(key=lambda x:-x[3]); lvl1=lvl1[:180]
print('مستوى 1: %d شرط  (%.0f ث)'%(len(lvl1),time.time()-t0), flush=True)

# ── المستوى 2 ──
lvl2=[]
for (n1,s1,m1,_),(n2,s2,m2,_) in itertools.combinations(lvl1,2):
    if s1!=s2 or fam(n1)==fam(n2): continue
    m=m1&m2; r=score(m,s1)
    if r and r[2]>2: lvl2.append(((n1,n2),s1,m,r[2]))
lvl2.sort(key=lambda x:-x[3]); lvl2=lvl2[:900]
print('مستوى 2: %d ثنائي  (%.0f ث)'%(len(lvl2),time.time()-t0), flush=True)

# ── المستوى 3 ──
lvl3=[]
for combo,sn,m,_ in lvl2:
    fams={fam(x) for x in combo}
    for n3,s3,m3,_ in lvl1:
        if s3!=sn or fam(n3) in fams: continue
        mm=m&m3; r=score(mm,sn,150,120)
        if r and r[2]>4.5: lvl3.append((combo+(n3,),sn,mm,r[2]))
lvl3.sort(key=lambda x:-x[3])
seen=set(); u3=[]
for combo,sn,m,sc in lvl3:
    k=(frozenset(combo),sn)
    if k in seen: continue
    seen.add(k); u3.append((combo,sn,m,sc))
u3=u3[:700]
print('مستوى 3: %d ثلاثي فريد  (%.0f ث)'%(len(u3),time.time()-t0), flush=True)

# ── المستوى 4 ──
lvl4=[]
for combo,sn,m,_ in u3[:350]:
    fams={fam(x) for x in combo}
    for n4,s4,m4,_ in lvl1:
        if s4!=sn or fam(n4) in fams: continue
        mm=m&m4; r=score(mm,sn,120,90)
        if r and r[2]>7: lvl4.append((combo+(n4,),sn,mm,r[2]))
lvl4.sort(key=lambda x:-x[3])
seen=set(); u4=[]
for combo,sn,m,sc in lvl4:
    k=(frozenset(combo),sn)
    if k in seen: continue
    seen.add(k); u4.append((combo,sn,m,sc))
u4=u4[:600]
print('مستوى 4: %d رباعي فريد  (%.0f ث)\n'%(len(u4),time.time()-t0), flush=True)

# ── محاكاة تسلسلية للنهائيين ──
def seq(mask,sn,lo,hi):
    out,bars=(L,LB) if sn=='BUY' else (S,SB); idx=[]; res=[]; busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i] or not mask[i] or out[i]<0: continue
        idx.append(i); res.append(int(out[i])); busy=i+int(bars[i])
    return idx,res
fin=[]
for combo,sn,m,sc in (u4+u3)[:900]:
    ia,ra=seq(m,sn,0,split); ib,rb=seq(m,sn,split,n)
    if len(ra)<35 or len(rb)<25: continue
    wa=100*sum(ra)/len(ra); wb=100*sum(rb)/len(rb)
    if min(wa,wb)<72: continue
    fin.append(dict(name=' & '.join(combo),side=sn,wa=wa,wb=wb,
                    na=len(ra),nb=len(rb),pb=len(rb)/d_te,idx=list(ib)))
fin.sort(key=lambda c:-min(c['wa'],c['wb']))
print('=== أفضل القواعد (>=72%% في الفترتين) — %d قاعدة ==='%len(fin))
for c in fin[:25]:
    print('  %-78s %-5s %5.1f%%/%5.1f%%  %4.2f/يوم'%(c['name'][:78],c['side'],c['wa'],c['wb'],c['pb']))
json.dump(fin[:200],open('mega_rules.json','w'),ensure_ascii=False)
print('\nاتحفظ %d قاعدة في mega_rules.json  (%.0f ثانية إجمالاً)'%(len(fin[:200]),time.time()-t0))
