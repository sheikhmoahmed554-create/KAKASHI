"""ما هي خطة الخروج المثلى داخل قيود المشروع، تحت المحرك الصحيح؟
قيود: هدف 30-60 • الوقف يزيد عن الهدف بـ20 كحد أقصى • صفقة واحدة • وقف زمني 30 شمعة."""
import numpy as np, json, methods, lab, lab30
D = lab.load(); _,F = methods.all_features(D)
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
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
for r in json.load(open('final_rules.json'))[:40]:
    m=build_mask(r['name'])
    if m is not None: rules.append((r['name'],r['side'],m))
print('عائلات: %d\n'%len(rules), flush=True)

PLANS=[(tp,sl) for tp in (30,35,40,45,50,55,60) for sl in (30,35,40,45,50,55,60,65,70,75,80)
       if sl<=tp+20]
print('خطط مسموحة: %d  |  الوقف الزمني 30 شمعة  |  صفقة واحدة\n'%len(PLANS), flush=True)

def run(O,rs,lo,hi,days):
    wins=[];pts=[];durs=[];busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i]: continue
        for nm,sn,m in rs:
            if not m[i]: continue
            W,P,B,K=O[sn]
            if W[i]<0: continue
            wins.append(int(W[i])); pts.append(float(P[i])); durs.append(int(B[i]))
            busy=i+int(B[i]); break
    if not wins: return None
    N=len(wins)
    return N,100*sum(wins)/N,N/days,float(np.mean(pts)),float(np.mean(durs))

res=[]
for tp,sl in PLANS:
    O=lab30.outcomes_timed(D,tp,sl,30)
    a=run(O,rules,0,split,d_tr); b=run(O,rules,split,n,d_te)
    if not a or not b: continue
    res.append((tp,sl,a,b,min(a[3],b[3])))
    print('  %2d/%2d | تدريب %5.1f%% %5.1f/يوم %+6.2f | اختبار %5.1f%% %5.1f/يوم %+6.2f | مدة %.1f'%(
        tp,sl,a[1],a[2],a[3],b[1],b[2],b[3],b[4]), flush=True)
res.sort(key=lambda r:-r[4])
print('\n═══ الأفضل بالتوقّع (أضعف الفترتين) ═══')
for tp,sl,a,b,s in res[:6]:
    print('  هدف %2d وقف %2d  →  اختبار %5.1f%% • %5.1f صفقة/يوم • %+6.2f نقطة/صفقة'%(tp,sl,b[1],b[2],b[3]))
print('\n═══ الأفضل بنسبة الفوز ═══')
for tp,sl,a,b,s in sorted(res,key=lambda r:-min(r[2][1],r[3][1]))[:6]:
    print('  هدف %2d وقف %2d  →  اختبار %5.1f%% • %5.1f صفقة/يوم • %+6.2f نقطة/صفقة'%(tp,sl,b[1],b[2],b[3]))
