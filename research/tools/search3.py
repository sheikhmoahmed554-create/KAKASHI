import numpy as np, lab, math, json, itertools
X=lab.build(); D,F,L,S=X['D'],X['F'],X['L'],X['S']; n=D['n']
valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
TR=np.zeros(n,bool); TR[:split]=True; TE=~TR
BASE={}
for pn,part in (('tr',TR),('te',TE)):
    for sn,out in (('BUY',L),('SELL',S)):
        m=part&valid&(out>=0); BASE[(pn,sn)]=float(out[m].mean())*100
DAYS_TR=len(set((D['t'][TR&valid]//86400).astype(int))); DAYS_TE=len(set((D['t'][TE&valid]//86400).astype(int)))
def ev(mask,out,part,pn,sn,days,minn=250):
    m=mask&part&valid&(out>=0); k=int(m.sum())
    if k<minn: return None
    w=float(out[m].mean())*100
    return dict(n=k,wr=w,exc=w-BASE[(pn,sn)],perday=k/days)
q=lambda a,p: np.nanpercentile(a[np.isfinite(a)],p)
C={}
for f in ['rsi14','rsi3','bb_z','pos20','pos60','pos240','atr_ratio','vol_ratio','body',
          'upwick','dnwick','ret5','ret15','ret60','ema9_21','ema21_50','dist_ema200','atr14']:
    a=F[f]
    for p in (3,5,10,20,30,70,80,90,95,97):
        C['%s%s%.4g'%(f,'<' if p<50 else '>',q(a,p))]=(a<q(a,p) if p<50 else a>q(a,p))
for hs in range(0,22,2): C['hour%d-%d'%(hs,hs+2)]=(D['hour']>=hs)&(D['hour']<hs+2)
base_of=lambda nm: nm.split('<')[0].split('>')[0]

sing=[]
for nm,m in C.items():
    for sn,out in (('BUY',L),('SELL',S)):
        a=ev(m,out,TR,'tr',sn,DAYS_TR); b=ev(m,out,TE,'te',sn,DAYS_TE)
        if a and b and min(a['exc'],b['exc'])>0.8: sing.append((nm,sn,m,a,b))
sing.sort(key=lambda r:-min(r[3]['exc'],r[4]['exc']))
sing=sing[:45]
print('شروط مفردة صامدة: %d'%len(sing))
tri=[]
for combo in itertools.combinations(sing,3):
    sns={c[1] for c in combo}
    if len(sns)>1: continue
    fams=[base_of(c[0]) for c in combo]
    if len(set(fams))<3: continue
    sn=combo[0][1]; out=L if sn=='BUY' else S
    m=combo[0][2]&combo[1][2]&combo[2][2]
    a=ev(m,out,TR,'tr',sn,DAYS_TR,150); b=ev(m,out,TE,'te',sn,DAYS_TE,150)
    if a and b: tri.append((' & '.join(c[0] for c in combo),sn,m,a,b))
tri.sort(key=lambda r:-min(r[3]['wr'],r[4]['wr']))
print('تركيبات ثلاثية مختبَرة: %d\n'%len(tri))
print('=== أعلى نسبة فوز صامدة في الفترتين (ثلاثية) ===')
print('%-52s %-4s %-19s %-19s'%('القاعدة','جهة','تدريب','اختبار'))
print('─'*100)
for nm,sn,m,a,b in tri[:12]:
    print('%-52s %-4s %5.1f%% %+4.1f %4.1f/يوم %5.1f%% %+4.1f %4.1f/يوم'%(
        nm[:52],sn,a['wr'],a['exc'],a['perday'],b['wr'],b['exc'],b['perday']))
json.dump([[r[0],r[1],r[3],r[4]] for r in tri[:300]],open('search3.json','w'))
np.save('tri_masks.npy', np.array([r[2] for r in tri[:60]]))
json.dump([[r[0],r[1]] for r in tri[:60]],open('tri_names.json','w'))
