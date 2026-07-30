import numpy as np, lab, math, json
X=lab.build(); D,F,L,S = X['D'],X['F'],X['L'],X['S']
n=D['n']; BE=100*X['sl']/(X['tp']+X['sl'])
# تقسيم زمني: تدريب على أول 60% واختبار على آخر 40%
split=int(n*0.6)
tr=np.zeros(n,bool); tr[:split]=True
te=~tr
valid_common = (D['hour']<22) & (~D['gap'])
print('التدريب: %s → %s | الاختبار: %s → %s'%(
  __import__('datetime').datetime.utcfromtimestamp(D['t'][0]).date(),
  __import__('datetime').datetime.utcfromtimestamp(D['t'][split]).date(),
  __import__('datetime').datetime.utcfromtimestamp(D['t'][split]).date(),
  __import__('datetime').datetime.utcfromtimestamp(D['t'][-1]).date()))
print('التعادل %.2f%%\n'%BE)

def ev(mask, out, part):
    m = mask & part & valid_common & (out>=0)
    k = int(m.sum())
    if k<100: return None
    w = float(out[m].mean())*100
    se = math.sqrt(BE/100*(1-BE/100)/k)*100
    return dict(n=k, wr=w, edge=w-BE, z=(w-BE)/se)

# مكتبة شروط مفردة
CONDS={}
def add(name, m): CONDS[name]=m
q=lambda a,p: np.nanpercentile(a[np.isfinite(a)],p)
for f in ['rsi14','rsi3','bb_z','pos20','pos60','pos240','atr_ratio','vol_ratio',
          'body','upwick','dnwick','ret5','ret15','ret60','ema9_21','ema21_50','dist_ema200','spread']:
    a=F[f]
    for p in (5,10,20,80,90,95):
        thr=q(a,p)
        add('%s %s %.4g'%(f, '<' if p<50 else '>', thr), a<thr if p<50 else a>thr)
for hstart in range(0,22,2):
    add('hour %d-%d'%(hstart,hstart+2), (D['hour']>=hstart)&(D['hour']<hstart+2))
for d in range(5):
    add('dow %d'%d, D['dow']==d)

rows=[]
for name,m in CONDS.items():
    for side,out in (('BUY',L),('SELL',S)):
        a=ev(m,out,tr); b=ev(m,out,te)
        if not a or not b: continue
        rows.append((name,side,a,b))
rows.sort(key=lambda r:-min(r[2]['edge'],r[3]['edge']))
print('%-30s %-5s %-24s %-24s'%('الشرط','جهة','تدريب','اختبار'))
print('─'*90)
for name,side,a,b in rows[:18]:
    print('%-30s %-5s %6d ص %5.1f%% (%+5.1f) %6d ص %5.1f%% (%+5.1f)'%(
        name[:30],side,a['n'],a['wr'],a['edge'],b['n'],b['wr'],b['edge']))
print('─'*90)
print('\nأفضل حافة على الاختبار من بين %d قاعدة مفردة: %+.2f نقطة مئوية'%(len(rows),max(r[3]['edge'] for r in rows)))
json.dump([[r[0],r[1],r[2],r[3]] for r in rows], open('search1.json','w'))
