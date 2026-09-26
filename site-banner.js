/* ============================================================
 * site-banner.js — サイト全体で「現在有効な大型大会・プロモ・掲載店舗募集」を1つに束ね、
 * トップページ(index.html)最上部のバナー(カルーセル)と全く同じものをどのページからでも
 * 描画できるようにする共通部品。
 *
 * ■ 背景(2026-09-26)
 *   これまでトップページだけに出していたバナーを、店舗ページ・エリアページ・大会ページ・
 *   初心者ガイド・トップページ内SPAの店舗詳細ビュー(#venue/vXX)にも同じ内容で表示することにした。
 *   同日中に一度「店舗ページにはその店舗自身のプロモだけ」という狭い実装
 *   (promo-banners.js の venuePromoBanners()・tools/site-shell.js の venuePromoBannerHtml())を
 *   入れたが、運営判断により「トップと全く同じ内容を全ページに出す」仕様に変更となったため、
 *   このファイルで「何を出すか(visibleSiteBanners)」「どう描画するか(markup生成・カルーセル)」を
 *   1箇所に集約し、venuePromoBanners()/venuePromoBannerHtml() 側の狭い仕組みを置き換える。
 *
 * ■ 「何を出すか」の判定は既存の3レジストリにそのまま委ねる(判定ロジックの複製はしない)
 *   - promo-banners.js  の visiblePromoBanners()  … 単発プロモ・常設(evergreen)PR掲載
 *   - big-events.js     の visibleBigEvents()     … 大型大会(WJPT/JOPT/FST 等)
 *   - listing-banner.js の visibleListingBanner()  … 掲載店舗募集の常設バナー
 *   連結順(promos → 大型大会 → 掲載店舗募集)は index.html の renderBigEventBanner() が
 *   もともと使っていた順序と同じにしてある(単発プロモ・常設PRは常に大型大会より先頭、
 *   掲載店舗募集は常に最後尾)。
 *
 * ■ 「どう描画するか」も1箇所に集約する
 *   0件 → 空 / 1件 → バナー1枚 / 2件以上 → 横スライド(カルーセル、ドット・矢印つき)。
 *   HTMLの組み立て(siteBannerInnerHtml/siteBannerBlockHtml)は純粋な文字列関数なので、
 *   生成時(Node、静的ページ)にも閲覧時(ブラウザ、index.html)にも同じものを使える。
 *   カルーセルの操作(スワイプ・矢印・ドット、prefers-reduced-motion 対応)は
 *   initBigEventCarousel() にまとめてある。もともと index.html にしか無かったが、
 *   静的ページ・SPAの店舗詳細ビューからも呼べるようここへ移設した(2026-09-26)。
 *   見た目・動作は移設前と同一(呼び出し元が「リサイズのたびに使い回す関数」を自分で
 *   保持できるよう、内部で決め打ちの外部変数に代入せず、リサイズ用コールバックを
 *   戻り値として返す形にした点だけが index.html 側の呼び出し方の変更点)。
 *
 * ■ ブラウザでの読み込み順(<script> 非moduleタグは同じ字句スコープを共有する。
 *   promo-banners.js冒頭の「2026-09-02の本番障害・再発防止」コメントを参照)。
 *   このファイルは big-events.js・promo-banners.js・listing-banner.js より【後】に読み込むこと
 *   (index.html・各静的ページとも、この並びで <script src> している)。
 *   Node実行時の別名(_SB_BE 等)は他ファイルの別名(promo-banners.js の `_BE` 等)と
 *   衝突しない名前にしてある(同じ理由でここでも新しい var/let/const を安易に追加しないこと)。
 * ============================================================ */

const _SB_BE = (typeof module !== 'undefined' && typeof require === 'function')
  ? require('./big-events.js') : null;
const _SB_PROMO = (typeof module !== 'undefined' && typeof require === 'function')
  ? require('./promo-banners.js') : null;
const _SB_LISTING = (typeof module !== 'undefined' && typeof require === 'function')
  ? require('./listing-banner.js') : null;

// ブラウザでNode向けrequireが使えないときは、既に読み込み済みの他ファイルが定義した
// グローバル関数(window.xxx)を使う。読み込み順の事故(未読み込み)でも例外にせず
// 「その分は0件」として安全側に倒す(promo-banners.js等の既存の typeof ガードと同じ考え方)。
function _sbGlobalFn(name) {
  return (typeof window !== 'undefined' && typeof window[name] === 'function') ? window[name] : null;
}
function _sbVisiblePromoBanners(today) {
  const fn = _SB_PROMO ? _SB_PROMO.visiblePromoBanners : _sbGlobalFn('visiblePromoBanners');
  return fn ? fn(today) : [];
}
function _sbVisibleBigEvents(today) {
  const fn = _SB_BE ? _SB_BE.visibleBigEvents : _sbGlobalFn('visibleBigEvents');
  return fn ? fn(today) : [];
}
function _sbVisibleListingBanner() {
  const fn = _SB_LISTING ? _SB_LISTING.visibleListingBanner : _sbGlobalFn('visibleListingBanner');
  return fn ? fn() : [];
}
function _sbBigEventBannerHtml(ev, opts) {
  const fn = _SB_BE ? _SB_BE.bigEventBannerHtml : _sbGlobalFn('bigEventBannerHtml');
  return fn ? fn(ev, opts) : '';
}
function _sbEscBanner(s) {
  const fn = _SB_BE ? _SB_BE.escHtmlBanner : _sbGlobalFn('escHtmlBanner');
  return fn ? fn(s) : String(s == null ? '' : s);
}

// サイト全体で「いま出すべきバナー」の全件(0件〜複数件)。index.html・静的ページ・
// SPAの店舗詳細ビューのすべてがこの1本だけを呼ぶ(集合の定義をここ以外に複製しない)。
// today は big-events.js/promo-banners.js の resolveNowAndToday と同じ形式('YYYY-MM-DD'/Date/省略)。
function visibleSiteBanners(today) {
  return _sbVisiblePromoBanners(today)
    .concat(_sbVisibleBigEvents(today))
    .concat(_sbVisibleListingBanner());
}

// カルーセルの中身(.ec-track 以下)だけを組み立てる。0件は空文字列、1件はバナー1枚分の
// HTMLをそのまま返す(カルーセルのUIは出さない)。
// opts.staticPage(2026-09-26追加): big-events.js の bigEventBannerHtml() にそのまま渡す。
// index.html を経由しない独立した静的ページ(店舗/エリア/大会/初心者ガイド)から呼ぶときは
// 必ず { staticPage: true } を渡すこと(WJPT/JOPT/NIPPON/FSTの `hash` リンクがその静的ページの
// 中では無反応になるのを防ぐため。big-events.js の bigEventBannerHtml() コメント参照)。
function siteBannerInnerHtml(evs, opts) {
  if (!evs || !evs.length) return '';
  if (evs.length === 1) return _sbBigEventBannerHtml(evs[0], opts);
  return `<div class="ec-track" role="group" aria-label="開催中・開催予定の大会・イベント ${evs.length}件（横スクロールできます）">
        ${evs.map(ev => `<div class="ec-slide">${_sbBigEventBannerHtml(ev, opts)}</div>`).join('')}
      </div>
      <button class="ec-arrow ec-prev" type="button" aria-label="前の大会を表示">‹</button>
      <button class="ec-arrow ec-next" type="button" aria-label="次の大会を表示">›</button>
      <div class="ec-dots">
        ${evs.map((ev, i) => `<button class="ec-dot" type="button" data-i="${i}" aria-label="${_sbEscBanner(ev.label)}を表示（${i + 1}／${evs.length}枚目）"></button>`).join('')}
      </div>`;
}
// 2件以上のときだけ .evtCarousel を付ける(index.html の renderBigEventBanner() と同じ判定)。
function siteBannerClass(evs) {
  return (evs && evs.length > 1) ? 'evtCarousel' : '';
}
// 静的ページ生成(Node)用: <div id="…">…</div> をまるごと文字列で返す。
// 0件でも空のdivを返す(閲覧時にJS側で描き直す余地・CSSの `:empty` 連動を残すため)。
// tools/site-shell.js の siteBannerSection() は必ず opts.staticPage:true を渡す。
function siteBannerBlockHtml(evs, slotId, opts) {
  const id = slotId || 'siteBanner';
  const cls = siteBannerClass(evs);
  return `<div id="${id}"${cls ? ` class="${cls}"` : ''}>${siteBannerInnerHtml(evs, opts)}</div>`;
}

// ブラウザでの描画(DOM)用: 既存の slot 要素に上と同じ中身を書き込む。
// evs.length が2件未満のときは initBigEventCarousel を呼ばず null を返す
// (呼び出し元はこれを「リサイズ時に呼び直すハンドラが無い」の意味として扱う)。
function mountSiteBanner(slot, evs, startIndex, opts) {
  if (typeof document === 'undefined' || !slot) return null;
  slot.className = siteBannerClass(evs);
  slot.innerHTML = siteBannerInnerHtml(evs, opts);
  if (!evs || evs.length < 2) return null;
  return initBigEventCarousel(slot, startIndex || 0);
}

// prefers-reduced-motion(カルーセル初回のヒントアニメーションを止めるかどうか)。
// index.html にあったものをそのままこちらへ移設した(2026-09-26)。
const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// カルーセルの操作(スワイプ / 矢印 / ドット)と現在位置の同期。
// 自動スライドは実装しない — トップの自動スクロールは 6f9eddb で意図的に廃止している。
// 【index.html からの移設(2026-09-26)】もとは index.html 内で完結しており、リサイズ用の
// コールバックを外側の `carouselOnResize` 変数に直接代入していた。静的ページ・SPAの
// 店舗詳細ビューなど呼び出し元が増えたため、代入先を決め打ちにせず【戻り値として返す】形にした。
// 呼び出し元は「2件以上あって実際にカルーセルを作った場合はリサイズ処理を、そうでなければ
// null を受け取る」。index.html は今まで通り自前の `carouselOnResize` に代入して単一の
// window resize リスナーを使い回し、静的ページ・SPAはこの戻り値をそのまま使うかは呼び出し側の自由。
// 見た目・操作性はこの移設で一切変えていない。
function initBigEventCarousel(slot, startIndex) {
  const track = slot.querySelector('.ec-track');
  const slides = Array.prototype.slice.call(slot.querySelectorAll('.ec-slide'));
  const dots = Array.prototype.slice.call(slot.querySelectorAll('.ec-dot'));
  const prev = slot.querySelector('.ec-prev');
  const next = slot.querySelector('.ec-next');
  if (!track || slides.length < 2) return null;
  let index = startIndex || 0;
  let touched = false;

  // 全スライドが一度に収まっているか(＝横スクロールの必要がないか)。
  // 収まっているときは操作UIを隠す(.ec-fits)。画面幅で決め打ちせず実測で判定するので、
  // レジストリが3件以上に増えれば自動的にスライド表示へ戻る。
  function updateFits() {
    const fits = track.scrollWidth <= track.clientWidth + 1;
    slot.classList.toggle('ec-fits', fits);
    return fits;
  }

  // 「いま何枚目か」はトラック中央に最も近いスライドで決める。
  // 最後の1枚はスクロール範囲の都合でスナップ位置まで届かないことがあり、
  // scrollLeft の一致で判定すると指スワイプ時にズレるため。
  function currentIndex() {
    const box = track.getBoundingClientRect();
    const center = box.left + box.width / 2;
    let best = 0, bestD = Infinity;
    slides.forEach((s, i) => {
      const r = s.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - center);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }
  // スワイプ・矢印・ドットのどれで動いても、ここを通って表示を1つに揃える。
  // 端の矢印は disabled ではなく aria-disabled で無効化する。disabled にすると
  // 押した瞬間その要素がフォーカス不能になり、フォーカスが body に落ちて
  // 次のTabがページ先頭からやり直しになるため(キーボード操作が壊れる)。
  function sync() {
    // 全部見えているときは「何枚目」の概念が無いので先頭固定にする
    index = slot.classList.contains('ec-fits') ? 0 : currentIndex();
    slot.dataset.index = String(index);
    dots.forEach((d, i) => d.setAttribute('aria-current', i === index ? 'true' : 'false'));
    if (prev) prev.setAttribute('aria-disabled', index <= 0 ? 'true' : 'false');
    if (next) next.setAttribute('aria-disabled', index >= slides.length - 1 ? 'true' : 'false');
  }
  const arrowOff = btn => !btn || btn.getAttribute('aria-disabled') === 'true';
  function goTo(i, smooth) {
    const t = Math.max(0, Math.min(slides.length - 1, i));
    track.scrollTo({
      left: slides[t].offsetLeft - slides[0].offsetLeft,
      behavior: (smooth && !prefersReducedMotion()) ? 'smooth' : 'auto'
    });
  }

  let raf = 0;
  track.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; sync(); });
  }, { passive: true });
  ['pointerdown', 'touchstart', 'wheel', 'keydown'].forEach(t =>
    track.addEventListener(t, () => { touched = true; }, { passive: true }));
  // Tabでバナーに移ったとき、そのバナーまでトラックを送る。
  // Chromeはスナップ付きの横スクローラーを自動では送ってくれず、
  // 「フォーカスはあるのに画面外」になってキーボード操作が実質壊れるため。
  track.addEventListener('focusin', e => {
    touched = true;
    const el = e.target && e.target.closest ? e.target.closest('.ec-slide') : null;
    const i = el ? slides.indexOf(el) : -1;
    if (i >= 0 && i !== index) goTo(i, false);
  });
  if (prev) prev.addEventListener('click', () => { if (arrowOff(prev)) return; touched = true; goTo(index - 1, true); });
  if (next) next.addEventListener('click', () => { if (arrowOff(next)) return; touched = true; goTo(index + 1, true); });
  dots.forEach(d => d.addEventListener('click', () => { touched = true; goTo(Number(d.dataset.i), true); }));

  updateFits();
  if (index) goTo(index, false);
  sync();

  const onResize = () => { updateFits(); sync(); };

  // 「横に動かせる」ことを伝えるヒント。ごく短く1回だけ、少し動いて戻るだけ。
  // prefers-reduced-motion: reduce では必ず動かさない。ユーザーが先に触ったらやらない。
  // 全部見えている(スクロール不要)ときは動かす意味がないのでやらない。
  if (!prefersReducedMotion() && index === 0 && !slot.classList.contains('ec-fits')) {
    setTimeout(() => {
      if (touched || track.scrollLeft > 2) return;
      const snap = track.style.scrollSnapType;
      track.style.scrollSnapType = 'none';   // スナップに引き戻されて動かないのを防ぐ
      track.scrollTo({ left: 34, behavior: 'smooth' });
      setTimeout(() => {
        track.scrollTo({ left: 0, behavior: 'smooth' });
        setTimeout(() => { track.style.scrollSnapType = snap; sync(); }, 520);
      }, 430);
    }, 700);
  }

  return onResize;
}

if (typeof module !== 'undefined') {
  module.exports = {
    visibleSiteBanners, siteBannerInnerHtml, siteBannerClass, siteBannerBlockHtml,
    mountSiteBanner, initBigEventCarousel
  };
}
