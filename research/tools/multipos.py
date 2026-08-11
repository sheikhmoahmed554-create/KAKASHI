"""74% من الإشارات محجوبة. ماذا لو سمحنا بعدة صفقات متزامنة؟"""
import numpy as np, lab, itertools, json
exec(open('compat.py').read().split('print(\'العائلات المختارة')[0])
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
R=[(c['name'],c['side'],c['mask'],c['wb']) for c in picked]
print('العائلات: %d\n'%len(R))
def port(rules,lo,hi,days,maxpos,cooldown=0):
    """maxpos = أقصى عدد صفقات متزامنة. cooldown = شموع منع بعد إشارة من نفس العائلة."""
    tr=[]; open_until=[]; last_fire={}
    for i in range(lo,hi):
        if not valid[i]: continue
        open_until=[x for x in open_until if x>i]
        for j,(nm,sn,m,_) in enumerate(rules):
            if len(open_until)>=maxpos: break
            if not m[i]: continue
            if cooldown and i-last_fire.get(j,-10**9)<cooldown: continue
            out,bars=(L,LB) if sn=='BUY' else (S,SB)
            if out[i]<0: continue
            tr.append(int(out[i])); open_until.append(i+int(bars[i])); last_fire[j]=i
    return (len(tr),100*sum(tr)/len(tr),len(tr)/days) if tr else None
print('%8s %10s | %8s %7s %8s | %8s %7s %8s'%('أقصى','تهدئة','عدد','فوز%','/يوم','عدد','فوز%','/يوم'))
print('%8s %10s | %27s | %27s'%('متزامن','شمعة','تدريب','اختبار'))
print('─'*80)
for maxpos in (1,2,3,5,8,99):
    for cd in (0,15):
        a=port(R,0,split,d_tr,maxpos,cd); b=port(R,split,n,d_te,maxpos,cd)
        if a and b:
            print('%8s %10d | %8d %6.1f%% %7.1f | %8d %6.1f%% %7.1f'%(
                maxpos if maxpos<99 else 'بلا حد',cd,a[0],a[1],a[2],b[0],b[1],b[2]), flush=True)
