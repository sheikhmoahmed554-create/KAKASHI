"""منحنى المقايضة: كل ما نخفف الشرط، كام صفقة نكسب وكام نقطة مئوية نخسر؟"""
import numpy as np, lab
X=lab.build(); D,F,L,S,LB,SB=X['D'],X['F'],X['L'],X['S'],X['LB'],X['SB']
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
V=F['vwap_dist_atr']
d_tr=len(set((D['t'][:split][valid[:split]]//86400).astype(int)))
d_te=len(set((D['t'][split:][valid[split:]]//86400).astype(int)))
def seq(mask,sn,lo,hi):
    out,bars=(L,LB) if sn=='BUY' else (S,SB); tr=[]; busy=-1
    for i in range(lo,hi):
        if i<=busy or not valid[i] or not mask[i] or out[i]<0: continue
        tr.append(int(out[i])); busy=i+int(bars[i])
    return tr
def row(lbl,mask,sn):
    a=seq(mask,sn,0,split); b=seq(mask,sn,split,n)
    if len(a)<25 or len(b)<25: return None
    wa=100*sum(a)/len(a); wb=100*sum(b)/len(b)
    return (lbl,len(a),wa,len(a)/d_tr,len(b),wb,len(b)/d_te,min(wa,wb))
print('=== منحنى عتبة VWAP وحدها (بيع) ===')
print('%-16s %6s %6s %7s | %6s %6s %7s'%('العتبة','عدد','فوز%','/يوم','عدد','فوز%','/يوم'))
for thr in (25,22,20,18,16,14,12,10,8,6,4):
    r=row('vwap > %d'%thr, V>thr, 'SELL')
    if r: print('%-16s %6d %5.1f%% %6.1f | %6d %5.1f%% %6.1f'%(r[0],r[1],r[2],r[3],r[4],r[5],r[6]))
print()
print('=== مع فلتر جودة (قمة نطاق + تشبع RSI3) ===')
print('%-16s %6s %6s %7s | %6s %6s %7s'%('العتبة','عدد','فوز%','/يوم','عدد','فوز%','/يوم'))
for thr in (22,18,15,12,10,8,6,4,2):
    m=(V>thr)&(F['pos20']>82.83)&(F['rsi3']>74.73)
    r=row('vwap > %d'%thr, m, 'SELL')
    if r: print('%-16s %6d %5.1f%% %6.1f | %6d %5.1f%% %6.1f'%(r[0],r[1],r[2],r[3],r[4],r[5],r[6]))
print()
print('=== تخفيف فلتر الجودة تدريجيا عند vwap>10 ===')
for pos,rsi in ((82.83,84.28),(82.83,74.73),(75,70),(70,65),(60,60),(50,55)):
    m=(V>10)&(F['pos20']>pos)&(F['rsi3']>rsi)
    r=row('pos>%g rsi3>%g'%(pos,rsi), m, 'SELL')
    if r: print('%-22s %6d %5.1f%% %5.1f/يوم | %6d %5.1f%% %5.1f/يوم'%(r[0],r[1],r[2],r[3],r[4],r[5],r[6]))
