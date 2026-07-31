"""يطلّع النسختين بالضبط كما قيستا، ويحصر الخصائص المطلوبة لتحويلها Pine."""
import numpy as np, json, methods, lab, lab30, collections, re
X30=lab30.build(); D=X30['D']; O=X30['O']
_,F=methods.all_features(D)
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
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
def seq(mask,sn,lo,hi):
    W,P,B,K=O[sn]; idx=[]; res=[]; busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i] or not mask[i] or W[i]<0: continue
        idx.append(i); res.append(int(W[i])); busy=i+int(B[i])
    return idx,res
rules=json.load(open('portfolio_rules.json'))
print('قواعد مرتّبة: %d'%len(rules), flush=True)
scored=[]
for r in rules:
    m=build_mask(r['name'])
    if m is None: continue
    ib,rb=seq(m,r['side'],split,n)
    if len(rb)<20: continue
    scored.append(dict(name=r['name'],side=r['side'],wa=r['wa'],wb=r['wb'],
                       mask=m,idx=set(ib),score=min(r['wa'],r['wb'])))
scored.sort(key=lambda c:-c['score'])
def pick(ov,k):
    out=[]
    for c in scored:
        if all(len(c['idx']&p['idx'])<=ov*min(len(c['idx']),len(p['idx'])) for p in out):
            out.append(c)
        if len(out)>=k: break
    return out
A=pick(0.30,20); B=pick(0.55,150)
for lbl,S in (('A',A),('B',B)):
    nb=sum(1 for c in S if c['side']=='BUY')
    json.dump([{'name':c['name'],'side':c['side'],'wa':round(c['wa'],1),'wb':round(c['wb'],1)} for c in S],
              open('version_%s.json'%lbl,'w'), ensure_ascii=False, indent=1)
    print('النسخة %s: %d عائلة (%d شراء، %d بيع)'%(lbl,len(S),nb,len(S)-nb))
feats=collections.Counter()
for c in A+B:
    for part in c['name'].split(' & '):
        feats[re.split(r'[<>=]',part.strip())[0]]+=1
print('\nالخصائص المطلوبة في Pine (%d خاصية):'%len(feats))
for f,k in feats.most_common(): print('  %-22s %d'%(f,k))
