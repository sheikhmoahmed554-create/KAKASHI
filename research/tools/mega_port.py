"""محفظة من قواعد البحث الضخم: اختيار عائلات مستقلة وقياس التزامن."""
import numpy as np, json, methods, lab
D,F = methods.all_features(); X=lab.build()
L,S,LB,SB=X['L'],X['S'],X['LB'],X['SB']
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
rules=json.load(open('mega_rules.json'))
print('قواعد محمّلة: %d'%len(rules))

def build_mask(name):
    m=np.ones(n,bool)
    for part in name.split(' & '):
        if '=' in part and '<' not in part and '>' not in part:
            f=part.split('=')[0]; m&=F[f]>0.5
        elif '<' in part:
            f,t=part.split('<'); m&=F[f]<float(t)
        else:
            f,t=part.split('>'); m&=F[f]>float(t)
    return m
for r in rules: r['mask']=build_mask(r['name']); r['idx']=set(r['idx'])

picked=[]
for r in sorted(rules,key=lambda x:-min(x['wa'],x['wb'])):
    if all(len(r['idx']&p['idx'])<=0.30*min(len(r['idx']),len(p['idx'])) for p in picked):
        picked.append(r)
    if len(picked)>=40: break
nb=sum(1 for p in picked if p['side']=='BUY')
print('عائلات مستقلة: %d  (%d شراء، %d بيع)\n'%(len(picked),nb,len(picked)-nb))
R=[(p['name'],p['side'],p['mask']) for p in picked]
TP,SL=30.0,50.0
def port(rs,lo,hi,days,maxpos,cd):
    tr=[]; openu=[]; last={}; conc=[]
    for i in range(lo,hi):
        openu=[u for u in openu if u>i]
        if valid[i]:
            for j,(nm,sn,m) in enumerate(rs):
                if len(openu)>=maxpos: break
                if not m[i]: continue
                if cd and i-last.get(j,-10**9)<cd: continue
                out,bars=(L,LB) if sn=='BUY' else (S,SB)
                if out[i]<0: continue
                tr.append(int(out[i])); openu.append(i+int(bars[i])); last[j]=i
        conc.append(len(openu))
    if not tr: return None
    w=sum(tr); N=len(tr); net=w*TP-(N-w)*SL
    return N,100*w/N,N/days,max(conc),net/N
print('%8s %7s | %7s %7s %7s %8s %8s | %7s %7s %7s %8s %8s'%(
    'متزامن','تهدئة','عدد','فوز%','/يوم','ذروة','توقّع','عدد','فوز%','/يوم','ذروة','توقّع'))
print('%18s | %41s | %41s'%('','تدريب','اختبار'))
print('─'*106)
for k in (10,20,30,40):
    rs=R[:k]
    print('  ── أعلى %d عائلة'%k)
    for maxpos,cd in ((1,0),(5,15),(999,15)):
        a=port(rs,0,split,d_tr,maxpos,cd); b=port(rs,split,n,d_te,maxpos,cd)
        if a and b:
            print('%8s %7d | %7d %6.1f%% %6.1f %8d %+8.2f | %7d %6.1f%% %6.1f %8d %+8.2f'%(
                maxpos if maxpos<999 else 'بلاحد',cd,a[0],a[1],a[2],a[3],a[4],b[0],b[1],b[2],b[3],b[4]), flush=True)
