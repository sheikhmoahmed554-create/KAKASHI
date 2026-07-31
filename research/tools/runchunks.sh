#!/bin/bash
# القطع واحدة تلو الأخرى — التشغيل المتوازي يقتلها بتزاحم الذاكرة
cd /home/user/KAKASHI/research/tools
for k in 0 1 2 3; do
  [ -f own_c$k.json ] && { echo "قطعة $k جاهزة، تخطّي"; continue; }
  echo "=== قطعة $k بدأت $(date +%H:%M:%S)"
  DATA=vault_c$k.csv node ownstats.mjs ab/EXTRACT.json own_c$k.json 0 > own_c$k.log 2>&1
  if [ -f own_c$k.json ]; then echo "=== قطعة $k تمّت $(date +%H:%M:%S)"; else echo "=== قطعة $k فشلت"; tail -3 own_c$k.log; fi
done
python3 stitch.py
