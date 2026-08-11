"""بحث بالمكتبة الموسّعة (55 خاصية). المقياس = الزيادة فوق خط الأساس لنفس الفترة والجهة."""
import numpy as np, lab, math, json, itertools
X=lab.build(); D,F,L,S=X['D'],X['F'],X['L'],X['S']; n=D['n']
valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
TR=np.zeros(n,bool); TR[:split]=True; TE=~TR
BASE={}
for pn,part in (('tr',TR),('te',TE)):
    for sn,out in (('BUY',L),('SELL',S)):
        m=part&valid&(out>=0); BASE[(pn,sn)]=float(out[m].mean())*100
DAYS={'tr':len(set((D['t'][TR&valid]//86400).astype(int))),
      'te':len(set((D['t'][TE&valid]//86400).astype(int)))}
def ev(mask,out,part,pn,sn,minn=300):
    m=mask&part&valid&(out>=0); k=int(m.sum())
    if k<minn: return None
    w=float(out[m].mean())*100
    return dict(n=k,wr=w,exc=w-BASE[(pn,sn)],perday=k/DAYS[pn])

SKIP={'ema9','ema21','ema50','ema200','bb_mid','bb_sd','hh20','hh60','hh240',
      'll20','ll60','ll240','vwap','atr60'}
q=lambda a,p: np.nanpercentile(a[np.isfinite(a)],p)
C={}
for f in F:
    if f in SKIP: continue
    a=F[f]
    u=np.unique(a[:5000])
    if len(u)<=2:                       # خاصية ثنائية
        C['%s=1'%f]=a>0.5; continue
    for p in (3,5,10,20,30,70,80,90,95,97):
        t=q(a,p)
        if not np.isfinite(t): continue
        C['%s%s%.4g'%(f,'<' if p<50 else '>',t)] = a<t if p<50 else a>t
print('شروط مرشّحة: %d  |  خصائص: %d'%(len(C),len(F)))

sing=[]
for nm,m in C.items():
    for sn,out in (('BUY',L),('SELL',S)):
        a=ev(m,out,TR,'tr',sn); b=ev(m,out,TE,'te',sn)
        if a and b and min(a['exc'],b['exc'])>0.8: sing.append((nm,sn,m,a,b))
sing.sort(key=lambda r:-min(r[3]['exc'],r[4]['exc']))
print('شروط مفردة صامدة في الفترتين: %d\n'%len(sing))
print('=== أفضل 12 شرط مفرد ===')
for nm,sn,m,a,b in sing[:12]:
    print('  %-30s %-4s تدريب %5.1f%% %+5.1f | اختبار %5.1f%% %+5.1f'%(nm[:30],sn,a['wr'],a['exc'],b['wr'],b['exc']))

fam=lambda s: s.split('<')[0].split('>')[0].split('=')[0]
top=sing[:55]
tri=[]
for combo in itertools.combinations(top,3):
    if len({c[1] for c in combo})>1: continue
    if len({fam(c[0]) for c in combo})<3: continue
    sn=combo[0][1]; out=L if sn=='BUY' else S
    m=combo[0][2]&combo[1][2]&combo[2][2]
    a=ev(m,out,TR,'tr',sn,150); b=ev(m,out,TE,'te',sn,150)
    if a and b: tri.append((' & '.join(c[0] for c in combo),sn,m,a,b))
tri.sort(key=lambda r:-min(r[3]['wr'],r[4]['wr']))
print('\nتركيبات ثلاثية مختبَرة: %d'%len(tri))
print('=== أعلى نسبة فوز صامدة ===')
for nm,sn,m,a,b in tri[:14]:
    print('  %-56s %-4s %5.1f%%/%5.1f%%  %4.1f-%4.1f صفقة/يوم'%(
        nm[:56],sn,a['wr'],b['wr'],a['perday'],b['perday']))
json.dump([[r[0],r[1],r[3],r[4]] for r in tri[:400]],open('search4.json','w'))
