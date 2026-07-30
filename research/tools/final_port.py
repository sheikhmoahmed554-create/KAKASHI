"""المحفظة النهائية من كل القواعد المولّدة، بالقيود الحقيقية:
صفقة واحدة مفتوحة • وقف زمني 30 شمعة • اختيار عائلات قليلة التداخل."""
import numpy as np, json, methods, lab, lab30, os
X30=lab30.build(); D=X30['D']; O=X30['O']
_,F=methods.all_features(D)
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
def build_mask(name):
    m=np.ones(n,bool)
    for part in name.split(' & '):
        part=part.strip()
        if '<' in part: f,t=part.split('<')
        elif '>' in part: f,t=part.split('>')
        elif '=' in part: m&=F[part.split('=')[0].strip()]>0.5; continue
        else: return None
        f=f.strip()
        if f not in F: return None
        m &= (F[f]<float(t)) if '<' in part else (F[f]>float(t))
    return m
pool={}
for fn in ('megagen_rules.json','final_rules.json','merged_rules.json'):
    if not os.path.exists(fn): continue
    for r in json.load(open(fn)):
        k=(r['name'],r['side'])
        if k in pool: continue
        m=build_mask(r['name'])
        if m is not None: pool[k]=m
print('قواعد فريدة: %d'%len(pool), flush=True)
def seq(mask,sn,lo,hi):
    W,P,B,K=O[sn]; idx=[]; res=[]; busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i] or not mask[i] or W[i]<0: continue
        idx.append(i); res.append(int(W[i])); busy=i+int(B[i])
    return idx,res
scored=[]
for (nm,sn),m in pool.items():
    ia,ra=seq(m,sn,0,split); ib,rb=seq(m,sn,split,n)
    if len(ra)<30 or len(rb)<20: continue
    wa=100*sum(ra)/len(ra); wb=100*sum(rb)/len(rb)
    if min(wa,wb)<68: continue
    scored.append(dict(name=nm,side=sn,mask=m,idx=set(ib),wa=wa,wb=wb,score=min(wa,wb)))
scored.sort(key=lambda c:-c['score'])
print('صامدة فوق 68%%: %d\n'%len(scored), flush=True)
def port(rs,lo,hi,days):
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
for ov in (0.30,0.55,0.80):
    picked=[]
    for c in scored:
        if all(len(c['idx']&p['idx'])<=ov*min(len(c['idx']),len(p['idx'])) for p in picked):
            picked.append(c)
        if len(picked)>=300: break
    nb=sum(1 for p in picked if p['side']=='BUY')
    print('══ تداخل ≤%.0f%% — %d عائلة (%d شراء، %d بيع)'%(ov*100,len(picked),nb,len(picked)-nb), flush=True)
    R=[(p['name'],p['side'],p['mask']) for p in picked]
    print('  %7s | %7s %7s %7s %9s %6s | %7s %7s %7s %9s %6s'%(
        'عائلات','عدد','فوز%','/يوم','توقّع','مدة','عدد','فوز%','/يوم','توقّع','مدة'))
    for k in (20,50,100,150,200,300):
        if k>len(R): break
        a=port(R[:k],0,split,d_tr); b=port(R[:k],split,n,d_te)
        if a and b:
            print('  %7d | %7d %6.1f%% %6.1f %+9.2f %6.1f | %7d %6.1f%% %6.1f %+9.2f %6.1f'%(
                k,a[0],a[1],a[2],a[3],a[4],b[0],b[1],b[2],b[3],b[4]), flush=True)
    print()
json.dump([{k:v for k,v in c.items() if k not in ('mask','idx')} for c in scored[:400]],
          open('portfolio_rules.json','w'), ensure_ascii=False)
