import numpy as np, lab, math, json, itertools
X=lab.build(); D,F,L,S = X['D'],X['F'],X['L'],X['S']
n=D['n']; BE=62.5
valid=(D['hour']<22)&(~D['gap'])
split=int(n*0.6)
TR=np.zeros(n,bool); TR[:split]=True; TE=~TR

BASE={}
for pn,part in (('tr',TR),('te',TE)):
    for sn,out in (('BUY',L),('SELL',S)):
        m=part&valid&(out>=0); BASE[(pn,sn)]=float(out[m].mean())*100
print('خط الأساس (دخول عند كل شمعة):')
for k,v in BASE.items(): print('   %-4s %-5s %.2f%%'%(k[0],k[1],v))
print('\nالمقياس المستخدم: الزيادة فوق خط الأساس لنفس الفترة ونفس الجهة (excess)\n')

def ev(mask,out,part,pn,sn):
    m=mask&part&valid&(out>=0); k=int(m.sum())
    if k<300: return None
    w=float(out[m].mean())*100; base=BASE[(pn,sn)]
    se=math.sqrt(base/100*(1-base/100)/k)*100
    return dict(n=k,wr=w,exc=w-base,z=(w-base)/se,edge=w-BE)

CONDS={}
q=lambda a,p: np.nanpercentile(a[np.isfinite(a)],p)
FEATS=['rsi14','rsi3','bb_z','pos20','pos60','pos240','atr_ratio','vol_ratio','body',
       'upwick','dnwick','ret5','ret15','ret60','ema9_21','ema21_50','dist_ema200','spread','atr14']
for f in FEATS:
    a=F[f]
    for p in (5,10,20,30,70,80,90,95):
        CONDS['%s%s%.4g'%(f,'<' if p<50 else '>',q(a,p))] = a<q(a,p) if p<50 else a>q(a,p)
for hs in range(0,22,2): CONDS['hour%d-%d'%(hs,hs+2)]=(D['hour']>=hs)&(D['hour']<hs+2)

singles=[]
for name,m in CONDS.items():
    for sn,out in (('BUY',L),('SELL',S)):
        a=ev(m,out,TR,'tr',sn); b=ev(m,out,TE,'te',sn)
        if a and b: singles.append((name,sn,m,a,b))

def show(rows,title,k=15):
    print(title); print('%-26s %-5s %-22s %-22s'%('القاعدة','جهة','تدريب (زيادة)','اختبار (زيادة)')); print('─'*80)
    for r in rows[:k]:
        name,sn,_,a,b=r
        print('%-26s %-5s %6dص %5.1f%% %+5.1f  %6dص %5.1f%% %+5.1f'%(
            name[:26],sn,a['n'],a['wr'],a['exc'],b['n'],b['wr'],b['exc']))
    print()

singles.sort(key=lambda r:-min(r[3]['exc'],r[4]['exc']))
show(singles,'=== أفضل الشروط المفردة (مرتبة بأضعف الفترتين) ===')

# تركيبات ثنائية من أفضل 40 شرط مفرد
top=[r for r in singles if min(r[3]['exc'],r[4]['exc'])>0][:40]
pairs=[]
for (n1,s1,m1,_,_),(n2,s2,m2,_,_) in itertools.combinations(top,2):
    if s1!=s2 or n1.split('<')[0].split('>')[0]==n2.split('<')[0].split('>')[0]: continue
    out=L if s1=='BUY' else S; m=m1&m2
    a=ev(m,out,TR,'tr',s1); b=ev(m,out,TE,'te',s1)
    if a and b: pairs.append((n1+' & '+n2,s1,m,a,b))
pairs.sort(key=lambda r:-min(r[3]['exc'],r[4]['exc']))
show(pairs,'=== أفضل التركيبات الثنائية ===')
json.dump({'singles':[[r[0],r[1],r[3],r[4]] for r in singles],
           'pairs':[[r[0],r[1],r[3],r[4]] for r in pairs]}, open('search2.json','w'))
best=max(pairs+singles,key=lambda r:min(r[3]['exc'],r[4]['exc']))
print('أفضل زيادة صامدة في الفترتين: %+.2f نقطة مئوية  (%s / %s)'%(min(best[3]['exc'],best[4]['exc']),best[0][:50],best[1]))
print('عدد القواعد المختبَرة: %d مفردة + %d ثنائية'%(len(singles),len(pairs)))
