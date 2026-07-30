#!/usr/bin/env bash
# حفظ ورفع فوري لأي نتيجة جديدة.
#
#   ./save.sh "وصف النتيجة"
#
# بيضيف كل حاجة تحت research/ ويعمل commit ويرفع على الفرع الحالي،
# مع إعادة محاولة عند فشل الشبكة (2ث، 4ث، 8ث، 16ث).
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO" || exit 1

MSG="${1:-}"
if [ -z "$MSG" ]; then
  echo "الاستخدام: ./save.sh \"وصف النتيجة\"" >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"

git add research
if git diff --cached --quiet; then
  echo "لا جديد يُحفظ."
  exit 0
fi

echo "— الملفات المتغيرة:"
git diff --cached --name-only | sed 's/^/    /'

git commit -q -m "$MSG" || { echo "فشل الـ commit" >&2; exit 1; }
echo "— اتعمل commit: $(git log --oneline -1)"

delay=2
for attempt in 1 2 3 4 5; do
  if git push -u origin "$BRANCH" 2>&1 | tail -2; then
    echo "— اترفع على $BRANCH"
    exit 0
  fi
  if [ "$attempt" -eq 5 ]; then
    echo "فشل الرفع بعد 5 محاولات. الـ commit محفوظ محلياً — أعد المحاولة لاحقاً." >&2
    exit 1
  fi
  echo "— فشل الرفع، إعادة المحاولة بعد ${delay}ث..." >&2
  sleep "$delay"
  delay=$((delay * 2))
done
