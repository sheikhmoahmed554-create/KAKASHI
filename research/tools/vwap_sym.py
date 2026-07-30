"""اختبار الجهة المقابلة: سعر بعيد تحت VWAP -> ارتداد صاعد."""
import numpy as np, lab
X=lab.build(); D,F,L,S,LB,SB=X['D'],X['F'],X['L'],X['S'],X['LB'],X['SB']
n=D['n']; valid=(D['hour']<22)&(~D['gap']); split=int(n*0.6)
TR=np.zeros(n,bool); TR[:split]=True; TE=~TR
BASE={}
for pn,p in (('tr',TR),('te',TE)):
    for sn,o in (('BUY',L),('SELL',S)):
        m=p&valid&(o>=0); BASE[(pn,sn)]=float(o[m].mean())*100
V=F['vwap_dist_atr']
print('توزيع bعد VWAP بالـATR: p5 %.1f  p50 %.1f  p95 %.1f  min %.1f  max %.1f'%(
  np.percentile(V,5),np.percentile(V,50),np.percentile(V,95),V.min(),V.max()))
print('خط الأساس: شراء tr %.2f te %.2f | بيع tr %.2f te %.2f\n'%(
  BASE[('tr','BUY')],BASE[('te','BUY')],BASE[('tr','SELL')],BASE[('te','SELL')]))

def ev(m,o,part,pn,sn,minn=200):
    x=m&part&valid&(o>=0); k=int(x.sum())
    if k<minn: return None
    w=float(o[x].mean())*100
    return (k,w,w-BASE[(pn,sn)])
print('%-34s %-5s %-20s %-20s'%('الشرط','جهة','تدريب','اختبار'))
print('─'*84)
for thr in (-30,-25,-21.78,-18.37,-13.67,-10):
    m=V<thr
    for sn,o in (('BUY',L),('SELL',S)):
        a=ev(m,o,TR,'tr',sn); b=ev(m,o,TE,'te',sn)
        if a and b:
            print('%-34s %-5s %6dش %5.1f%% %+5.1f  %6dش %5.1f%% %+5.1f'%(
              'vwap_dist_atr < %g'%thr,sn,a[0],a[1],a[2],b[0],b[1],b[2]))
print()
print('=== تركيبات الشراء تحت VWAP ===')
combos=[('+ هدوء',(F['atr14']<13.12)),('+ انكماش',(F['atr_ratio']<0.7798)),
        ('+ تباطؤ',(F['atr_accel']<0.7978)),('+ حجم منخفض',(F['vol_ratio']<0.7971)),
        ('+ قاع نطاق',(F['pos20']<17)),('+ RSI3 منهار',(F['rsi3']<25.65))]
for thr in (-18.37,-13.67):
    for lbl,extra in combos:
        m=(V<thr)&extra
        a=ev(m,L,TR,'tr','BUY',120); b=ev(m,L,TE,'te','BUY',120)
        if a and b:
            print('  vwap<%-7g %-14s تدريب %6dش %5.1f%% %+5.1f | اختبار %6dش %5.1f%% %+5.1f'%(
              thr,lbl,a[0],a[1],a[2],b[0],b[1],b[2]))
