"""الدمج بقيد صارم: صفقة واحدة مفتوحة فقط — لا دخول جديد قبل إغلاق الحالية."""
import numpy as np, json, methods, lab
D,F = methods.all_features(); X=lab.build()
L,S,LB,SB=X['L'],X['S'],X['LB'],X['SB']
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
rules=json.load(open('merged_rules.json'))
print('قواعد: %d'%len(rules), flush=True)
for r in rules: r['mask']=build_mask(r['name'])
rules=[r for r in rules if r['mask'] is not None]

def seq_idx(mask,sn,lo,hi):
    out,bars=(L,LB) if sn=='BUY' else (S,SB); idx=[]
    busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i] or not mask[i] or out[i]<0: continue
        idx.append(i); busy=i+int(bars[i])
    return set(idx)
for r in rules: r['idx']=seq_idx(r['mask'],r['side'],split,n)

TP,SL=30.0,50.0
def port1(rs,lo,hi,days):
    """صفقة واحدة فقط في المرة."""
    tr=[]; busy=-1; blocked=0; durs=[]
    for i in range(lo,hi):
        if not valid[i]: continue
        if i<=busy:
            if any(m[i] for _,_,m in rs): blocked+=1
            continue
        for nm,sn,m in rs:
            if not m[i]: continue
            out,bars=(L,LB) if sn=='BUY' else (S,SB)
            if out[i]<0: continue
            tr.append(int(out[i])); durs.append(int(bars[i])); busy=i+int(bars[i]); break
    if not tr: return None
    w=sum(tr); N=len(tr); net=w*TP-(N-w)*SL
    return N,100*w/N,N/days,net/N,blocked,float(np.mean(durs))

print('\nقيد: صفقة واحدة مفتوحة فقط. الترتيب: الأعلى جودة أولاً.\n')
print('%8s | %7s %7s %7s %9s %8s %8s | %7s %7s %7s %9s'%(
    'عائلات','عدد','فوز%','/يوم','توقّع','محجوب','مدة','عدد','فوز%','/يوم','توقّع'))
print('%8s | %49s | %35s'%('','تدريب','اختبار'))
print('─'*100)
for k in (5,10,15,20,30,40,60,80,120,180,250):
    if k>len(rules): break
    rs=[(r['name'],r['side'],r['mask']) for r in rules[:k]]
    a=port1(rs,0,split,d_tr); b=port1(rs,split,n,d_te)
    if a and b:
        print('%8d | %7d %6.1f%% %6.1f %+9.2f %8d %7.0f | %7d %6.1f%% %6.1f %+9.2f'%(
            k,a[0],a[1],a[2],a[3],a[4],a[5],b[0],b[1],b[2],b[3]), flush=True)
