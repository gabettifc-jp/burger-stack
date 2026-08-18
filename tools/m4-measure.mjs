/* 測定 M4：方策を直して測り直す（2026-08-14）。
   index.html は1行も変更しない。実プレイ経路（Chromium の実UI操作）だけで走らせ、
   1ランごとに JSON 1行を書き出す。集計は tools/m4-report.mjs。

   M3 との違いは**方策だけ**。ゲーム側の値・記録の取り方は M3 と同じ。
   M3 の基準は「デッキ最弱より代理打点が高ければ常に取る」で、これは実質「取れるだけ取る」だった
   （10営業日でデッキ中央値71枚）。M4 は「引く枚数とデッキ枚数を揃える」を基本戦術に置き直す。

   改訂版（指示書 M4 改訂版 §2-3／§2-4）：**ソース枠を買う。**ソース枠が何枚開くかが総倍率を
   ほぼ単独で決める（特上×6 なら 1枠×6／2枠×36／3枠×216）。改訂前は買わない方策だったので
   「ソース1枚の世界」だけを測っていた。購入順序は 削除 → ソース枠 → 具材枠 → アーティファクト → カード。

   使い方：
     node tools/m4-measure.mjs --policy=base --from=4001 --to=4060 --out=tools/out/m4-base.jsonl
     --workers=N でページを並列に走らせる（既定4）。--days=10 で dayGoal。
     --axis=agemono --axismode=weak  で軸に寄せる（weak＝罰なし／strong＝Wave29 と同じ）。

   方策（--policy）：
     base    基準：枠（引く枚数）とデッキ枚数を揃える。空きがあるとき／削除で入れ替えるとき／
             代理打点がデッキ平均の2倍以上のときだけ3択を取る。
     norem   削除しない：削除を買わない。空きは具材枠を買ったときだけ生まれる。
     nosauce ソース無視：ソースを取らない・買わない（初期デッキのケチャップは残る）。
     noaxis  軸を無視：軸ボーナス（主軸なら ×1.3）を外し、代理打点だけで取捨する。
     takeall 全部取る：M3 の基準と同じ。デッキ最弱より高ければ常に取る。下限の比較対象。
     random  何も考えない：3択は無作為・店は買えるものを無作為に買う。
*/
import pkg from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pkg;
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const POLICY = arg('policy', 'base');
const FROM = +arg('from', 4001), TO = +arg('to', 4060);
const OUT = arg('out', `tools/out/m4-${POLICY}.jsonl`);
const HTML = arg('html', 'file:///home/user/burger-stack/index.html');   // Wave25：変更前の index.html を指定して同じ方策で測るため
const RENTRATIO = arg('rentratio', '');   // Wave26：家賃を所持金比で出すモード（Wave24）。空なら OFF
const AXIS = arg('axis', '');   // Wave29：この軸に寄せる（kokyu/wa/chuka/kaisen/agemono）。空なら軸に寄せない＝基準方策
/* Wave31：軸方策の強さ。Wave29 は「狙う軸×3／別の軸×0.4」の一択で、別の軸への罰が
   「強いカードでも軸が違えば避ける」方策を作っていた。制約つきの方策が制約なしの方策に
   勝てないのは当たり前なので、罰のない「弱」を足す。
     weak   … 狙う軸 ×2.0／別の軸 ×1.0／無軸 ×1.0（罰なし）
     strong … 狙う軸 ×3.0／別の軸 ×0.4／無軸 ×1.0（Wave29 と同じ。比較用に残す） */
const AXISMODE = arg('axismode', 'strong');
const AXISW = AXISMODE === 'weak' ? { on: 2.0, off: 1.0 } : { on: 3.0, off: 0.4 };
const DEEP = arg('deep', '') === '1';   // Wave29-2：スピンごとの盤面と hits、最終デッキの中身まで残す（解剖用・JSON が大きくなる）
const WORKERS = +arg('workers', 4);
const DAYS = +arg('days', 10);
const TARGET = HTML;   // Wave25：--html= で差し替え可能（変更前後を同じ方策で比べるため）

if (!existsSync('tools/out')) mkdirSync('tools/out', { recursive: true });
writeFileSync(OUT, '');

/* ── 代理打点（ボットが使う近似）。M3 と同じ換算。 ────────────────────────
   具材＝帯の値（並60・上120・特上240・極480）
   ソース＝40×(帯の倍率−1)（並×1.5→20・上×3→80・特上×6→200・極×10→360）
     ＝「中段の自分以外の合計を40とみなしたときの打点」。M3 §3 と同じ式。
   ボットは実際の打点を知らない。このずれ自体が「帯から飛び出しているカード」の証拠になる。 */
const PROXY = `
  const BAND = { nami:60, jou:120, tokujou:240, kiwami:480 };
  const SAUCE_MULT = { nami:1.5, jou:3, tokujou:6, kiwami:10 };
  function proxy(nm){
    const it = CONFIG.items[nm]; if (!it) return 0;
    if (it.pile === "sauce") return Math.round(40 * ((SAUCE_MULT[it.rar] || 1) - 1));
    return BAND[it.rar] || 0;
  }
  // 軸ボーナス：デッキの主軸と同じ軸なら 1.3 倍に見積もる（noaxis では使わない）。M3 と同じ値。
  function proxyWithAxis(nm, useAxis){
    const v = proxy(nm);
    const cu = (CONFIG.items[nm] || {}).cuisine || "none";
    /* Wave29／Wave31：軸に寄せる方策。係数は __axisW（weak なら 2.0/1.0、strong なら 3.0/0.4）。
       無軸（none）は素のまま（無軸は序盤を支える札なので、寄せる／寄せないの判断から外す）。
       方策そのもの（買い方・取捨の手順）は変えていない。変えたのは代理打点の係数だけ。 */
    if (window.__axisTarget){
      const W = window.__axisW || { on: 3, off: 0.4 };
      if (cu === window.__axisTarget) return Math.round(v * W.on);
      if (cu !== "none") return Math.round(v * W.off);
      return v;
    }
    if (!useAxis) return v;
    const main = RUN.mainCuisine();
    return (main !== "none" && cu === main) ? Math.round(v * 1.3) : v;
  }
  // 方策 random 用の乱数。ゲームの grand() は使わない（使うとゲーム側の抽選がずれる）。
  window.__rngState = 0;
  function botRand(){ let t = (window.__rngState += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  function weakestInDeck(){
    const d = RUN.deck(); let lo = null;
    for (const x of d){ const v = proxy(x.name); if (lo === null || v < lo.v) lo = { v, name: x.name }; }
    return lo || { v: 0, name: null };
  }
  function avgInDeck(){
    const d = RUN.deck(); if (!d.length) return 0;
    let s = 0; for (const x of d) s += proxy(x.name);
    return s / d.length;
  }
  // 引く枚数＝具材枠＋ソース枠。デッキ枚数をここに合わせるのが M4 の基本戦術。
  function capacity(){ return Math.round(CONFIG.params.tiers.ingredients) + Math.round(CONFIG.params.tiers.sauces); }
  function deckN(){ return RUN.deck().length; }
  function sauceN(){ return RUN.deck().filter(x => CONFIG.items[x.name].pile === "sauce").length; }
  function sauceRoom(){ return Math.round(CONFIG.params.tiers.sauces) - sauceN(); }
`;

// ── 1スピンぶんのカード別打点を取り出す（plan から読むだけ・コードは変えない）──
const PERCARD = `
  function perCardHits(){
    if (typeof plan === "undefined" || !plan) return [];
    const st = plan.stack, ba = plan.sc.baseArr || [], hits = plan.sc.hits || [];
    const out = [];
    for (let i = 0; i < st.length; i++){
      const it = CONFIG.items[st[i]]; if (!it || it.pile === "bun") continue;
      let add = 0, mul = 1;
      for (const h of hits){ if (h.src !== i || h.disabled) continue;
        if (h.kind === "add") add += (h.add || 0);
        else if (h.kind === "mult") mul *= (h.mult || 1); }
      const dmg = Math.round((40 + (ba[i] || 0) + add) * mul - 40);
      out.push([st[i], dmg]);
    }
    return out;
  }
`;

async function runOne(page, seed, policy) {
  const errs = [];
  page.removeAllListeners('pageerror'); page.removeAllListeners('console');
  page.on('pageerror', e => errs.push('PE ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CE ' + m.text()); });
  await page.goto(TARGET);
  await page.waitForFunction(() => typeof window.RUN !== 'undefined');
  await page.evaluate(([seed, days, policy, proxySrc, perCardSrc, rentRatio, axis, deep, axisW]) => {
    window.__M4 = { policy, spins: [], days: [], buys: [], removes: {}, skips: {}, takes: {}, slots: {},
      sauSlots: [], artBuys: [], artSwaps: 0, fills: null, day: 0, credit: 0, shop: [], noneOffer: 0, noneTake: 0, noneShop: 0, noneShopBuy: 0 };
    eval(proxySrc); eval(perCardSrc);
    window.__proxy = proxy; window.__proxyAxis = proxyWithAxis; window.__weakest = weakestInDeck;
    window.__avg = avgInDeck; window.__cap = capacity; window.__deckN = deckN; window.__sauceRoom = sauceRoom;
    window.__perCard = perCardHits; window.__botRand = botRand; window.__rngState = seed * 7919;
    window.__axisTarget = axis || '';   // Wave29：軸に寄せる方策（空なら従来どおり）
    window.__axisW = axisW;             // Wave31：軸方策の係数（weak / strong）
    window.__deep = !!deep;             // Wave29-2：解剖用の詳しい記録
    CONFIG.params.skipFx = true; CONFIG.params.completeLock = 0.001;
    if (RUN.plogDetail) RUN.plogDetail(false);   // Wave13：スピンごとの盤面・内訳はプレイログに残さない（測定では要らない・JSON が膨らむ）
    RUN.setPendingSeed(seed); RUN.reset();
    CONFIG.params.skipFx = true; CONFIG.params.completeLock = 0.001;
    CONFIG.params.run.dayGoal = days;
    if (rentRatio !== '' && CONFIG.params.run.rentFromMoney){    // Wave26：所持金比モードで測るとき
      CONFIG.params.run.rentFromMoney.on = true;
      CONFIG.params.run.rentFromMoney.ratio = +rentRatio;
    }
  }, [seed, DAYS, policy, PROXY, PERCARD, RENTRATIO, AXIS, DEEP, AXISW]);

  const st = () => page.evaluate(() => ({
    show: document.getElementById('offer').classList.contains('show'),
    title: (document.querySelector('#offer .offer-title') || {}).textContent || '',
    done: /完成/.test(document.getElementById('progress').textContent),
    active: RUN.state().runActive, days: RUN.state().daysSurvived, money: RUN.state().money,
    cls: document.getElementById('offer').className }));
  const tap = () => page.evaluate(() => { const el = document.getElementById('tap');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); });

  let guard = 0, ended = null, lastKey = '', rep = 0;
  while (guard++ < 4000) {
    const s = await st();
    if (!s.active) { ended = /cleared/.test(s.cls) ? 'cleared' : 'broke'; break; }
    const key = s.show + '|' + s.title + '|' + s.days;
    if (key === lastKey) rep++; else { rep = 0; lastKey = key; }
    if (rep > 40) { ended = 'stuck'; break; }
    if (!s.show) {
      for (let k = 0; k < 14; k++) { if ((await page.evaluate(() => /完成/.test(document.getElementById('progress').textContent)))) break; await tap(); await page.waitForTimeout(20); }
      await page.evaluate(() => {   // 完成した時点のカード別打点と得点を控える
        const day = RUN.state().daysSurvived + 1;
        const d = RUN.deck();
        window.__M4.spins.push({ d: day, t: plan ? plan.sc.total : 0, n: plan ? plan.stack.length : 0,
          deck: d.length, ing: Math.round(CONFIG.params.tiers.ingredients), sau: Math.round(CONFIG.params.tiers.sauces),
          ic: d.filter(x => CONFIG.items[x.name].pile === 'ingredient').length,
          sc: d.filter(x => CONFIG.items[x.name].pile === 'sauce').length,
          cards: window.__perCard(),
          // Wave29：得点のどこで伸びたか（第1項＋第2項／加算／倍率）と、盤面の軸の内訳
          b1: plan ? (plan.sc.base + (plan.sc.grow || 0)) : 0, ad: plan ? plan.sc.add : 0, mu: plan ? plan.sc.mult : 1,
          cui: (() => { const c = {}; for (const x of d){ const k = CONFIG.items[x.name].cuisine || 'none'; c[k] = (c[k]||0)+1; } return c; })(),
          // Wave29-2：盤面と hits をそのまま残す（何が噛み合ったかを後から読むため）
          st: window.__deep && plan ? plan.stack.slice() : undefined,
          hits: window.__deep && plan ? plan.sc.hits.map(h => ({ k:h.kind, l:h.label, e:h.effect,
            m:(h.mult!=null?Math.round(h.mult*1000)/1000:undefined), a:h.add, ma:h.madd })) : undefined,
          madd: plan ? Math.round((plan.sc.multAdd||0)*1000)/1000 : 0,
          mmul: plan ? Math.round((plan.sc.multMul||1)*1000)/1000 : 1,
          gr: window.__deep ? (plan ? plan.inst.map((x,i)=>({ n:plan.stack[i], pb:x.pb||0, pm:x.pm||0, mx:(x.mx!=null?x.mx:1) })) : undefined) : undefined,
          /* Wave32：ブイヤベースが実際にどこまで育ったか。
             ch（次の段までの持ち越し）は RUN.deck() から取れるが、**mx は RUN.deck() の射影に入っていない**ので
             盤面に出たスピンだけ plan.inst から読む（出ていないスピンは null）。ここを取り違えると
             「一度も育っていない」という誤った読みになる。 */
          bui: d.filter(x => x.name === 'ブイヤベース').map(x => ({ ch: Math.round(x.charge||0) })),
          buiMx: (plan ? plan.stack.map((n,i)=> n === 'ブイヤベース' ? (plan.inst[i].mx != null ? plan.inst[i].mx : 1) : null)
                              .filter(v => v != null) : []).map(v => Math.round(v*1000)/1000),
          /* Wave33：RUN.deck() の射影に mx を足したので、盤面に出ていないスピンでも読める。
             buiMx（plan.inst 由来）と突き合わせて、同じ値になることを確認する。 */
          buiMxDeck: d.filter(x => x.name === 'ブイヤベース').map(x => Math.round((x.mx != null ? x.mx : 1)*1000)/1000),
          buiOn: plan ? plan.stack.filter(x => x === 'ブイヤベース').length : 0,
          /* Wave38-2：mx と charge（端数）を個体ごとに対にして残す。別々の配列だと突き合わせを間違える。
             線形になったので吸収累計は (mx - mx0)/per*step + charge で厳密に復元できる。 */
          buiPair: d.filter(x => x.name === 'ブイヤベース')
                    .map(x => ({ mx: Math.round((x.mx != null ? x.mx : 1)*1000)/1000, ch: Math.round(x.charge||0) })),
          /* Wave38：レモンバターソース（growMx・線形）の育ち。mx は RUN.deck() の射影に入っている（Wave33）。
             ブイヤベースと違い盤面に出ていなくても読めるので、デッキ側だけで足りる。 */
          lbs: d.filter(x => x.name === 'レモンバターソース').map(x => Math.round((x.mx != null ? x.mx : 1)*1000)/1000),
          lbsOn: plan ? plan.stack.filter(x => x === 'レモンバターソース').length : 0,
          // Wave33：在庫側（うに）と、その参照先（ナンプラー）
          uni: d.filter(x => x.name === 'うに').map(x => Math.round(x.pb||0)),
          nam: plan ? (plan.sc.hits || []).filter(h => h.kind === 'mult' && /^ナンプラー/.test(h.label))
                        .reduce((m,h) => Math.max(m, h.mult||1), 0) : 0,
          /* Wave34：しらすの第1項（base + pb）。dayBaseMul は伸びを pb に入れるので、
             ブイヤベースに吸われうる。吸われたかを後から読めるように pb ごと残す。 */
          sir: d.filter(x => x.name === 'しらす')
                .map(x => ({ pb: Math.round(x.pb||0), t1: Math.round((CONFIG.items['しらす'].base||0) + (x.pb||0)) })),
          // Wave34：いかの加算（上限1000に張り付いているか）
          ika: plan ? (plan.sc.hits || []).filter(h => h.kind === 'add' && /^いか：盤面の加算合計/.test(h.label))
                        .reduce((m,h) => Math.max(m, h.add||0), 0) : 0,
          /* Wave35：デッキ枚数を読む極ソース2枚。hit の label は「名前：デッキN枚」なので
             倍率とそのときのデッキ枚数を一緒に取る（フォンドヴォーは薄いほど、花椒油は厚いほど強い）。 */
          ksauce: plan ? (plan.sc.hits || []).filter(h => h.kind === 'mult' && /^(フォンドヴォー|花椒油)：デッキ/.test(h.label))
                        .map(h => ({ n: h.label.split('：')[0], m: Math.round((h.mult||1)*1000)/1000,
                                     dk: +(h.label.match(/デッキ(\d+)枚/) || [0,0])[1] })) : [] });
      });
      for (let k = 0; k < 14; k++) { if (!(await page.evaluate(() => /完成/.test(document.getElementById('progress').textContent)))) break; await tap(); await page.waitForTimeout(20); }
      continue;
    }
    const handled = await page.evaluate((policy) => {
      const M = window.__M4, title = (document.querySelector('#offer .offer-title') || {}).textContent || '';
      const day = RUN.state().daysSurvived + 1;
      const useAxis = policy !== 'noaxis';
      const useSauce = policy !== 'nosauce';
      const useRemove = policy !== 'norem';
      const rnd = arr => arr[Math.floor(window.__botRand() * arr.length)];
      // 営業日が変わったら「今日の入れ替え枠」を戻す。credit＝削除で消す前提で先に取った枚数。
      if (M.day !== day) { M.day = day; M.credit = 0; }

      // ① バンズの押し出し：効果を持たないゴマバンズを優先して捨てる（方策で差をつけない）
      if (/バンズを1枚入手/.test(title)) {
        const sub = (document.querySelector('#offer .offer-subtitle') || {}).textContent || '';
        const take = [...document.querySelectorAll('#offer .offer-buy')].find(x => /受け取る/.test(x.textContent));
        if (!/押し出す/.test(sub) && take) { take.click(); return 'bun'; }
        const rows = [...document.querySelectorAll('#offer .bunslots .remove-row:not(.off)')];
        const goma = rows.find(r => (r.querySelector('.nm') || {}).textContent === 'ゴマバンズ');
        if (goma) goma.click(); else if (rows[0]) rows[0].click();
        else if (take) take.click();
        return 'bun';
      }
      // ② 家賃
      if (/家賃の支払い/.test(title)) {
        const before = RUN.state().money;
        const x = [...document.querySelectorAll('#offer .offer-buy')].find(y => /支払う|前借り|結果/.test(y.textContent));
        if (x) x.click();
        M.days.push({ d: day, moneyBefore: before, money: RUN.state().money,
          bands: (() => { const c = { nami:0, jou:0, tokujou:0, kiwami:0 }; for (const y of RUN.deck()) c[CONFIG.items[y.name].rar]++; return c; })(),
          deck: RUN.deck().length, cap: window.__cap(),
          ing: Math.round(CONFIG.params.tiers.ingredients), sau: Math.round(CONFIG.params.tiers.sauces) });
        return 'rent';
      }
      // ③ 店　買う順序：削除 → 具材枠 → アーティファクト → カード（今日の家賃ぶんは常に残す）
      if (/店（/.test(title)) {
        const money = () => RUN.state().money;
        // Wave29：店に並んだ無軸の札と、そのうち買った枚数（3択は無印を出さないので、無軸の判断は店でしか起きない）
        for (const c of document.querySelectorAll('#offer .shopcard:not(.artcard)')){
          const nm0 = (c.querySelector('.nm') || {}).textContent;
          if (((CONFIG.items[nm0]||{}).cuisine || 'none') === 'none') M.noneShop = (M.noneShop || 0) + 1;
        }
        const m0 = RUN.state().money;                       // Wave25：店に入った時点（家賃を払った直後）の所持金
        const keep = () => Math.round(300 * Math.pow(1.4, RUN.state().daysSurvived));   // 今日の家賃ぶんは残す
        const btn = re => [...document.querySelectorAll('#offer .shopbtn')].find(y => re.test(y.textContent));
        const price = el => +((el.querySelector('.price') || {}).textContent || '0').replace(/\D/g, '');
        if (policy === 'random') {
          for (let k = 0; k < 6; k++) {
            const cs = [...document.querySelectorAll('#offer .shopcard')].filter(x => !x.classList.contains('cant'));
            if (!cs.length) break; const c = rnd(cs);
            const nm = (c.querySelector('.nm') || {}).textContent; const isArt = c.classList.contains('artcard');
            c.click(); (isArt ? M.artBuys : M.buys).push({ d: day, nm });
          }
        } else {
          // (a) 削除：デッキが引く枚数を上回っているぶんだけ、最弱を取り除く
          if (useRemove) {
            for (let k = 0; k < 3; k++) {
              if (policy !== 'takeall' && window.__deckN() <= window.__cap()) break;
              const rb = btn(/取り除く/); if (!rb || /cant/.test(rb.className)) break;
              const cost = price(rb); if (money() - cost < keep()) break;
              rb.click();
              const rows = [...document.querySelectorAll('#offer .remove-row:not(.off)')];
              if (!rows.length) { const back = [...document.querySelectorAll('#offer .offer-skip')].find(y => /戻る/.test(y.textContent)); if (back) back.click(); break; }
              let lo = rows[0], lv = 1e9;
              for (const r of rows) { const v = window.__proxy((r.querySelector('.nm') || {}).textContent); if (v < lv) { lv = v; lo = r; } }
              const nm = (lo.querySelector('.nm') || {}).textContent;
              lo.click(); M.removes[day] = (M.removes[day] || 0) + 1; M.buys.push({ d: day, nm, kind: 'remove' });
            }
          }
          // (b) ソース枠：上限に達していなければ、買えるようになった時点で買う（具材枠より優先）
          //     ソース枠は総倍率を桁で動かす唯一のレバー（1枠×6／2枠×36／3枠×216）。
          if (useSauce) {
            for (let k = 0; k < 3; k++) {
              const sb = btn(/ソース枠/); if (!sb || /cant/.test(sb.className)) break;
              const cost = price(sb); if (money() - cost < keep()) break;
              const before = Math.round(CONFIG.params.tiers.sauces);
              sb.click();
              const after = Math.round(CONFIG.params.tiers.sauces);
              if (after === before) break;
              M.sauSlots.push({ d: day, to: after, cost });
              M.buys.push({ d: day, nm: 'ソース枠+1', kind: 'sslot' });
            }
          }
          // (c) 具材枠：枠がデッキで埋まっているなら1つ増やす（明日ぶんの空きを作る）
          for (let k = 0; k < 2; k++) {
            const ib = btn(/具材枠/); if (!ib || /cant/.test(ib.className)) break;
            const cost = price(ib); if (money() - cost < keep()) break;
            if (policy === 'takeall') { if (RUN.deck().length <= Math.round(CONFIG.params.tiers.ingredients) + 1) break; }
            else if (window.__deckN() < window.__cap()) break;   // まだ空きがあるなら増やさない
            ib.click(); M.slots[day] = (M.slots[day] || 0) + 1; M.buys.push({ d: day, nm: '具材枠+1', kind: 'slot' });
          }
          // (d) アーティファクト：買えるものを高いレアリティから（M3 と同じ）
          for (let k = 0; k < 3; k++) {
            const as = [...document.querySelectorAll('#offer .shopcard.artcard')].filter(x => !x.classList.contains('cant'))
              .filter(x => money() - price(x) >= keep());
            if (!as.length) break;
            const before = (RUN.state().artifacts || []).length;
            const nm = (as[0].querySelector('.nm') || {}).textContent;
            as[0].click();
            const after = (RUN.state().artifacts || []).length;
            if (after === before) M.artSwaps++;
            M.artBuys.push({ d: day, nm });
            if (M.fills === null && after >= 3) M.fills = day;
          }
          // (e) カード：空きがあるぶんだけ買う（takeall は M3 と同じで買えるだけ買う）
          for (let k = 0; k < 8; k++) {
            if (policy !== 'takeall' && window.__deckN() >= window.__cap()) break;
            let cs = [...document.querySelectorAll('#offer .shopcard:not(.artcard)')].filter(x => !x.classList.contains('cant'));
            if (!useSauce) cs = cs.filter(x => (CONFIG.items[(x.querySelector('.nm') || {}).textContent] || {}).pile !== 'sauce');
            cs = cs.filter(x => money() - price(x) >= keep());
            if (!cs.length) break;
            const wantSauce = useSauce && window.__sauceRoom() > 0;
            const weak = window.__weakest();
            let pick = cs.map(x => ({ x, nm: (x.querySelector('.nm') || {}).textContent }))
              .map(o => ({ ...o, v: window.__proxyAxis(o.nm, useAxis) + ((wantSauce && CONFIG.items[o.nm].pile === 'sauce') ? 10000 : 0) }))
              .sort((a, b) => b.v - a.v)[0];
            if (policy !== 'takeall' && pick.v < 10000 && pick.v <= weak.v) break;   // 最弱以下なら買わない
            pick.x.click(); M.buys.push({ d: day, nm: pick.nm, kind: 'card' });
            if (((CONFIG.items[pick.nm]||{}).cuisine || 'none') === 'none') M.noneShopBuy = (M.noneShopBuy || 0) + 1;
          }
        }
        // Wave25：この営業日に店で使った額と、店を出た時点の残り
        M.shop.push({ d: day, in: m0, out: RUN.state().money, spent: m0 - RUN.state().money });
        const out = [...document.querySelectorAll('#offer .offer-skip')].find(y => /店を出る/.test(y.textContent));
        if (out) out.click();
        return 'shop';
      }
      // ④ 押し出し・軸選択など
      if (/押し出す|減らす|軸を選ぶ/.test(title)) {
        const r = document.querySelector('#offer .remove-row:not(.off)') || document.querySelector('#offer .offer-card')
          || [...document.querySelectorAll('#offer .offer-buy')][0];
        if (r) r.click();
        return 'other';
      }
      // ⑤ 3択
      const cs = [...document.querySelectorAll('#offer .offer-card')];
      if (!cs.length) { const s = document.querySelector('#offer .offer-skip'); if (s) s.click(); return 'offer-empty'; }
      const names = cs.map(c => (c.querySelector('.nm') || {}).textContent);
      if (policy === 'random') { const k = Math.floor(window.__botRand() * cs.length); cs[k].click();
        M.takes[day] = (M.takes[day] || 0) + 1; return 'offer'; }
      // Wave29：無軸の札が提示されたか／取られたかを数える（軸が決まった後の価値を見る）
      M.noneOffer = (M.noneOffer || 0) + (names.some(n => (CONFIG.items[n]||{}).cuisine === 'none' || !CONFIG.items[n].cuisine) ? 1 : 0);
      let cand = names.map((nm, k) => ({ nm, k, v: window.__proxyAxis(nm, useAxis) }));
      if (!useSauce) cand = cand.filter(o => CONFIG.items[o.nm].pile !== 'sauce');
      const weak = window.__weakest();
      cand = cand.filter(o => o.v > weak.v);
      const skip = () => { const s = document.querySelector('#offer .offer-skip'); if (s) s.click();
        M.skips[day] = (M.skips[day] || 0) + 1; };
      if (!cand.length) { skip(); return 'skip'; }
      cand.sort((a, b) => b.v - a.v || a.k - b.k);   // 同点なら左端
      // 「全部取る」＝ M3 の基準。枚数を見ない。
      const noteTake = nm => { if (((CONFIG.items[nm]||{}).cuisine || 'none') === 'none') M.noneTake = (M.noneTake || 0) + 1; };
      if (policy === 'takeall') { noteTake(cand[0].nm); cs[cand[0].k].click(); M.takes[day] = (M.takes[day] || 0) + 1; return 'offer'; }
      // ソース枠が空いていればソースを優先する（枚数の制約より優先）
      if (useSauce && window.__sauceRoom() > 0) {
        const sa = cand.find(o => CONFIG.items[o.nm].pile === 'sauce');
        if (sa) { noteTake(sa.nm); if (window.__deep) M.buys.push({ d: day, nm: sa.nm, kind: 'offer' });
          cs[sa.k].click(); M.takes[day] = (M.takes[day] || 0) + 1; return 'offer'; }
      }
      const room = window.__cap() - window.__deckN();
      const best = cand[0];
      let take = false;
      if (room > 0) take = true;                                        // ① 枠に空きがある
      else if (useRemove && M.credit < 1) { take = true; M.credit++; }   // ② 今日の削除1回ぶんを先に使う
      else if (best.v >= 2 * window.__avg()) take = true;                // ③ 平均の2倍以上なら薄まる損を承知で取る
      if (!take) { skip(); return 'skip'; }
      noteTake(best.nm); if (window.__deep) M.buys.push({ d: day, nm: best.nm, kind: 'offer' });
      cs[best.k].click(); M.takes[day] = (M.takes[day] || 0) + 1;
      return 'offer';
    }, policy);
    await page.waitForTimeout(handled === 'shop' ? 40 : 25);
  }

  const out = await page.evaluate(() => {
    const M = window.__M4;
    return { spins: M.spins, days: M.days, shop: M.shop, buys: M.buys, removes: M.removes, skips: M.skips, takes: M.takes, slots: M.slots, sauSlots: M.sauSlots,
      artBuys: M.artBuys, artSwaps: M.artSwaps, fills: M.fills, noneOffer: M.noneOffer, noneTake: M.noneTake, noneShop: M.noneShop, noneShopBuy: M.noneShopBuy,
      // Wave29-2：最終デッキの中身（個体ごとの育ち）と所持アーティファクト
      finalDeck: window.__deep ? RUN.deck().map(x => ({ n:x.name, pb:x.pb||0, pm:x.pm||0, mx:(x.mx!=null?x.mx:1),
        cui:(CONFIG.items[x.name]||{}).cuisine||'none', rar:(CONFIG.items[x.name]||{}).rar })) : undefined,
      arts2: window.__deep ? (RUN.state().artifacts || []).slice() : undefined,
      arts: (RUN.state().artifacts || []).slice(),
      // Wave31：最終デッキの軸の内訳と評価（--deep なしでも常に残す。§1-3 の純度と §3 の分布のため）
      cuiEnd: (() => { const c = {}; for (const x of RUN.deck()){ const k = (CONFIG.items[x.name]||{}).cuisine || 'none'; c[k] = (c[k]||0)+1; } return c; })(),
      grade: (typeof gradeOf === 'function') ? gradeOf(RUN.state().money) : null,
      fb: (RUN.rarityFallbacks ? RUN.rarityFallbacks().length : 0),
      warn: selfCheck().length, warnMsg: selfCheck(), deck: RUN.deck().length, cap: window.__cap(),
      ing: Math.round(CONFIG.params.tiers.ingredients), sau: Math.round(CONFIG.params.tiers.sauces),
      money: RUN.state().money, daysSurvived: RUN.state().daysSurvived };
  });
  return { seed, policy, ended, errs: errs.length, err0: errs[0] || null, ...out };
}

const seeds = []; for (let s = FROM; s <= TO; s++) seeds.push(s);
const t0 = Date.now();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell', args: ['--no-sandbox'] });
let idx = 0, done = 0;
async function worker() {
  const page = await browser.newPage();
  while (true) {
    const my = idx++; if (my >= seeds.length) break;
    try {
      const r = await runOne(page, seeds[my], POLICY);
      appendFileSync(OUT, JSON.stringify(r) + '\n');
    } catch (e) {
      appendFileSync(OUT, JSON.stringify({ seed: seeds[my], policy: POLICY, ended: 'error', error: String(e).slice(0, 200) }) + '\n');
    }
    done++;
    if (done % 5 === 0) process.stderr.write(`  ${POLICY}: ${done}/${seeds.length}（${Math.round((Date.now()-t0)/1000)}秒）\n`);
  }
  await page.close();
}
await Promise.all(Array.from({ length: Math.min(WORKERS, seeds.length) }, worker));
await browser.close();
console.log(`${POLICY}: ${done}ラン / ${Math.round((Date.now() - t0) / 1000)}秒 → ${OUT}`);
