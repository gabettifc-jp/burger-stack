#!/bin/sh
# Wave40：itch.io に上げる zip を作る。
#
#   sh tools/dist.sh
#
# 出来上がり： dist/burger-stack.zip
#   - **zip の直下に index.html を置く。**itch.io は zip 直下の index.html を探すので、
#     フォルダに入れると起動しない。
#   - 入れるのは index.html と LICENSE の2つだけ。
#     README / KENTO / LOG / SHOKUZAI / SHIYOU / tools は入れない
#     （設計と測定の記録は配布物に含めない）。
#   - dist/ は .gitignore 済み。zip はコミットしない。
#
# 一時ディレクトリに欲しいものだけコピーしてから固める。
# リポジトリの根で zip -x を並べる作り方だと、新しいファイルが増えたときに黙って混入する。
# 「入れるものを列挙する」ほうを採る。
set -eu

cd "$(dirname "$0")/.."
ROOT=$(pwd)
OUT="$ROOT/dist/burger-stack.zip"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

for f in index.html LICENSE; do
  [ -f "$ROOT/$f" ] || { echo "ない: $f" >&2; exit 1; }
  cp "$ROOT/$f" "$STAGE/$f"
done

mkdir -p "$ROOT/dist"
rm -f "$OUT"
# -X … 拡張属性とタイムスタンプ以外のメタ情報を落とす（同じ入力なら同じ zip に近づける）
# -r … 再帰。-9 … 最大圧縮。
( cd "$STAGE" && zip -q -X -9 -r "$OUT" . )

echo "できた: dist/burger-stack.zip"
unzip -l "$OUT"

# ── 検証ページ（zip には入れない） ─────────────────────────────────────────
# itch.io は index.html を**別オリジンの iframe**に入れて配信する。そこが一番壊れやすいので、
# ローカルで同じ形を作って確かめるためのページ。dist/ は .gitignore 済みで消えるので、
# ここで毎回生成する（置き場所を dist/ にしたまま、再現できるようにするため）。
#
#   使い方（ゲームと検証ページを**別ポート**で配ること。同一オリジンだと本番と条件が変わる）：
#     python3 -m http.server 8080 --bind 127.0.0.1 --directory .
#     python3 -m http.server 8081 --bind 127.0.0.1 --directory dist
#     → http://127.0.0.1:8081/iframe-test.html
cat > "$ROOT/dist/iframe-test.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>burger-stack — iframe 検証</title>
<style>
  html,body{margin:0;padding:0;background:#1b1f24;color:#ddd;font:14px/1.5 system-ui,sans-serif}
  .bar{padding:6px 10px;font-size:12px;color:#9aa}
  /* itch.io の埋め込みと同じ形：固定サイズの枠に入れ、枠の外にスクロールを作らない */
  #wrap{width:960px;height:720px;margin:0 auto;border:1px solid #444;overflow:hidden}
  iframe{width:100%;height:100%;border:0;display:block}
</style>
<div class="bar">iframe 検証（itch.io の埋め込みを模した枠）。?w= と ?h= で枠の寸法、?src= でゲームの URL を変えられる。</div>
<div id="wrap"><iframe id="game" src="" title="burger-stack"></iframe></div>
<script>
  const q = new URLSearchParams(location.search);
  const wrap = document.getElementById('wrap');
  if (q.get('w')) wrap.style.width  = q.get('w') + 'px';
  if (q.get('h')) wrap.style.height = q.get('h') + 'px';
  document.getElementById('game').src = q.get('src') || 'http://127.0.0.1:8080/index.html';
</script>
HTML
echo "できた: dist/iframe-test.html（検証用・zip には入れない）"
