"""المحفظة النهائية بالقيود الحقيقية:
   • صفقة واحدة مفتوحة فقط
   • وقف زمني 30 شمعة (نصف ساعة)
   • الخروج الزمني بربح/خسارة فعلية"""
import numpy as np, json, methods, lab, lab30
X30 = lab30.build(); D = X30['D']; O = X30['O']
_, F = methods.all_features(D)
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
TR=np.zeros(n,bool); TR[:split]=True; TE=~TR
BASE={}
for pn,p in (('tr',TR),('te',TE)):
    for sn in ('BUY','SELL'):
        W=O[sn][0]; m=p&valid&(W>=0); BASE[(pn,sn)]=float(W[m].mean())*100
print('خط الأساس: تدريب شراء %.2f بيع %.2f | اختبار شراء %.2f بيع %.2f'%(
    BASE[('tr','BUY')],BASE[('tr','SELL')],BASE[('te','BUY')],BASE[('te','SELL')]), flush=True)

def build_mask(name):
    m=np.ones(n,bool)
    for part in name.split(' & '):
        part=part.strip()
        if '<' in part:   f,t=part.split('<')
        elif '>' in part: f,t=part.split('>')
        elif '=' in part: m&=F[part.split('=')[0].strip()]>0.5; continue
        else: return None
        f=f.strip()
        if f not in F: return None
        m &= (F[f]<float(t)) if '<' in part else (F[f]>float(t))
    return m

rules=[]
for r in json.load(open('merged_rules.json')):
    m=build_mask(r['name'])
    if m is not None: rules.append(dict(name=r['name'],side=r['side'],mask=m))
print('قواعد: %d'%len(rules), flush=True)

def seq1(rs,lo,hi,days):
    """صفقة واحدة فقط + وقف زمني."""
    wins=[]; pts=[]; durs=[]; busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i]: continue
        for nm,sn,m in rs:
            if not m[i]: continue
            W,P,B,K = O[sn]
            if W[i]<0: continue
            wins.append(int(W[i])); pts.append(float(P[i])); durs.append(int(B[i]))
            busy=i+int(B[i]); break
    if not wins: return None
    N=len(wins)
    return N, 100*sum(wins)/N, N/days, float(np.mean(pts)), float(np.mean(durs))

# إعادة ترتيب القواعد حسب جودتها تحت المحرك الجديد
scored=[]
for r in rules:
    a=seq1([(r['name'],r['side'],r['mask'])],0,split,d_tr)
    b=seq1([(r['name'],r['side'],r['mask'])],split,n,d_te)
    if not a or not b or a[0]<30 or b[0]<20: continue
    if min(a[1],b[1])<66: continue
    scored.append(dict(**r, wa=a[1], wb=b[1], ea=a[3], eb=b[3], score=min(a[1],b[1])))
scored.sort(key=lambda c:-c['score'])
print('صامدة فوق 66%% بالمحرك الجديد: %d\n'%len(scored), flush=True)
print('=== أفضل 10 قواعد منفردة ===')
for c in scored[:10]:
    print('  %-66s %-5s %5.1f%%/%5.1f%%  توقّع %+5.2f'%(c['name'][:66],c['side'],c['wa'],c['wb'],c['eb']))
print()
print('%8s | %7s %7s %7s %9s %7s | %7s %7s %7s %9s %7s'%(
    'عائلات','عدد','فوز%','/يوم','توقّع','مدة','عدد','فوز%','/يوم','توقّع','مدة'))
print('%8s | %41s | %41s'%('','تدريب','اختبار'))
print('─'*96)
for k in (5,10,20,40,60,100,150,220):
    if k>len(scored): break
    rs=[(c['name'],c['side'],c['mask']) for c in scored[:k]]
    a=seq1(rs,0,split,d_tr); b=seq1(rs,split,n,d_te)
    if a and b:
        print('%8d | %7d %6.1f%% %6.1f %+9.2f %6.1f | %7d %6.1f%% %6.1f %+9.2f %6.1f'%(
            k,a[0],a[1],a[2],a[3],a[4],b[0],b[1],b[2],b[3],b[4]), flush=True)
json.dump([{k:v for k,v in c.items() if k!='mask'} for c in scored[:250]],
          open('final_rules.json','w'), ensure_ascii=False)
