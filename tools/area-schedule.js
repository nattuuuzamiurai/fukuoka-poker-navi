#!/usr/bin/env node
/**
 * area-schedule.js — エリアページ(/areas/<slug>/)の【エリアの決め方と日程表の唯一の所有者】
 *
 * 【何のためのページか】
 *   店舗ページ(/venues/<slug>/)は「店名 + 日程」の検索を取りにいく。
 *   トップ1枚では取れない残りのロングテールが「天神 ポーカー」「小倉 ポーカー」
 *   「久留米 ポーカー」のような【地名だけで探す】検索で、これは店名を知らない人の入口になる。
 *   その受け皿が無いので、エリア単位の集約ページを別に用意する。
 *
 * 【なぜ venue-schedule.js に相乗りせず独立したファイルなのか】
 *   あちらは「1店ぶんの日程表」の所有者で、行に店名の列を持たない。
 *   エリアページの表は複数店を1つの日付の下に並べるため【どの店の大会か】を必ず出す必要があり、
 *   表の作りが違う。一方で「どの行を出すか」(定期開催の展開・自動取込との重複の間引き)は
 *   まったく同じ規則でなければならないので、行の取得は venue-schedule.js の vpRows を
 *   店ごとに呼んで束ねる形にしてある(判定を書き写さない)。
 *
 * 【エリアページを作る条件 = そのエリアに2店舗以上あること】
 *   1店しかないエリア(2026-08-18時点で西中洲・博多・京築・筑豊)にエリアページを作ると、
 *   中身がその1店の店舗ページとほぼ同じになる。同じ内容のURLが2本ある状態は
 *   どちらの評価も上がらないうえ、読者にとっても回り道でしかない。
 *   店が2軒目が入った時点で自動的にページができる(手当ては不要)。
 *
 * 【sitemap に載せる条件は別 = 掲載中の日程が1件以上あること】
 *   店舗ページ(gen-sitemap.js の VENUE)と同じ考え方。日程0件のエリアページは
 *   実質「店の一覧」だけなので、AdSense審査に出す全URLの中に混ぜない[社長判断・2026-07-30]。
 *   ページ自体は生成し、トップのエリアリンク行(#areaLinks)からも辿れる。
 *
 * 【日付に依存させない】
 *   静的側に焼き込む期間は areaRange() が data.js の日付だけから決める。
 *   実行日で変わると、データを1文字も触っていないのに翌日には --check が落ちる
 *   (venue-schedule.js と同じ理由)。閲覧時に「今日以降」へ描き直すのはブラウザ側の仕事。
 *
 * 使う側:
 *   - tools/gen-area-pages.js … エリアページの生成
 *   - tools/gen-sitemap.js    … sitemap に載せるエリアの判定(hasAreaSchedule)
 *
 * テスト: node --test tools/area-schedule.test.js
 */

const vm = require('vm');
const path = require('path');

// 行の取得(定期開催の展開・自動取込との重複の間引き)は店舗ページと同じ1本を使う。
const { SCHEDULE_JS, SCHED, monthRange } = require(path.join(__dirname, 'venue-schedule.js'));
const RecurringDedupe = require(path.join(__dirname, '..', 'recurring-dedupe.js'));

// ---- エリア名 → URLのslug ----
// 【なぜ data.js ではなくここに置くか】
//   data.js は日次の自動取込(Waitinglist / Instagram監視)が書き換えるファイルで、
//   機械が触る領域に人手のURL定義を混ぜると、取込の実装変更で静かに消えうる。
//   slug は一度公開したら変えられない(変えると被リンクを失う)ので、
//   機械が書かないファイルに置く。
// 【店舗slugと同じローマ字表記にそろえてある】
//   例: 西中洲 → nishi-nakasu(casino-blow-nishi-nakasu と同じ)、大橋 → ohashi、
//       今泉 → imaizumi、北九州 → kitakyushu。表記が2通りあると読者にも検索にも分かりにくい。
const AREA_SLUGS = {
  '天神': 'tenjin',
  '中洲': 'nakasu',
  '西中洲': 'nishi-nakasu',
  '大名': 'daimyo',
  '今泉': 'imaizumi',
  '大橋': 'ohashi',
  '博多': 'hakata',
  '北九州': 'kitakyushu',
  '京築': 'keichiku',
  '筑豊': 'chikuho',
  '久留米': 'kurume'
};

// エリアページを作る最小店舗数(上記「エリアページを作る条件」)。
const MIN_VENUES_FOR_AREA_PAGE = 2;

/**
 * そのエリアの店舗(data.js の VENUES の順)。
 * 【未開店の店も含める】店舗ページ側(gen-venue-pages.js)が preopen の店も一覧に出しており、
 * エリアページだけ隠すと「トップの店舗リンク行にはあるのにエリアページには無い」ズレになる。
 * 未開店であることは各店舗ページ側が明示する。
 */
function areaVenues(VENUES, area) {
  return VENUES.filter(v => v.area === area);
}

/**
 * エリアページを作るエリアの一覧。並びは data.js の AREAS の順。
 * AREAS に無いエリアが VENUES 側に現れた場合も落とさず末尾に足す(掲載漏れを作らない。
 * トップの店舗リンク行 venueLinksRow() と同じ扱い)。
 * slug を持たないエリアはURLを決められないので、呼び出し側が validateAreaSlugs で先に落とす。
 */
function areaList(VENUES, AREAS) {
  const areas = AREAS.filter(a => VENUES.some(v => v.area === a));
  VENUES.forEach(v => { if (areas.indexOf(v.area) < 0) areas.push(v.area); });
  return areas.filter(a => areaVenues(VENUES, a).length >= MIN_VENUES_FOR_AREA_PAGE);
}

/**
 * slug の欠けを生成前に止める。
 * 【なぜ落とすか】店を1軒足したエリアが2軒目に達すると、その瞬間に新しいエリアページのURLが
 * 必要になる。slug が無いまま生成すると /areas/undefined/ ができるか、そのエリアだけ黙って
 * 落ちる。どちらも公開後に気づく壊れ方なので、生成させない。
 */
function validateAreaSlugs(VENUES, AREAS) {
  const missing = areaList(VENUES, AREAS).filter(a => !AREA_SLUGS[a]);
  if (missing.length) {
    throw new Error(
      `エリアのURL(slug)がありません: ${missing.join('、')}\n`
      + '  tools/area-schedule.js の AREA_SLUGS にローマ字のslugを足してください'
      + '（店舗slugと同じ表記にそろえること）。');
  }
  const seen = new Map();
  const dup = [];
  Object.keys(AREA_SLUGS).forEach(a => {
    if (seen.has(AREA_SLUGS[a])) dup.push(`${seen.get(AREA_SLUGS[a])} と ${a} が同じ slug "${AREA_SLUGS[a]}"`);
    seen.set(AREA_SLUGS[a], a);
  });
  if (dup.length) {
    throw new Error('エリアのslugが重複しています:\n  - ' + dup.join('\n  - '));
  }
}

// ============================================================
// 日程表(生成時=Node と 閲覧時=ブラウザ で同じ1本を共有する)
// ============================================================
// 店舗ページの SCHEDULE_JS を前提にしている(vpRows / vpEsc / vpBuyin / vpNum / vpWeekday を使う)。
// 埋め込む側は SCHEDULE_JS → AREA_SCHEDULE_JS の順で出すこと。
const AREA_SCHEDULE_JS = `
/* 複数店ぶんの行を1つに束ねる。行の取得そのものは店舗ページと同じ vpRows に任せ、
   ここでは店名(venueName)を添えて日付・開始時刻の順に並べ直すだけ。
   ★ 判定(定期開催の展開・自動取込との重複の間引き)をここに書き写さないこと。 */
function apRows(TOURNAMENTS, RECURRING, venues, fromIso, toIso){
  var all = [];
  for (var i = 0; i < venues.length; i++) {
    var v = venues[i];
    var rows = vpRows(TOURNAMENTS, RECURRING, v.id, fromIso, toIso);
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      all.push({ date: r.date, start: r.start, name: r.name, buyin: r.buyin, addon: r.addon,
                 stack: r.stack, guarantee: r.guarantee, tags: r.tags, recurring: r.recurring,
                 lowConfidence: r.lowConfidence, venueName: v.name, venueSlug: v.slug });
    }
  }
  return all.sort(function(a, b){
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    var sa = a.start || '99:99', sb = b.start || '99:99';
    if (sa !== sb) return sa < sb ? -1 : 1;
    /* 同じ日・同じ時刻なら店名で固定する。並びが実行のたびに変わると
       --check が理由もなく落ちる(生成物が安定しない)。 */
    return a.venueName < b.venueName ? -1 : (a.venueName > b.venueName ? 1 : 0);
  });
}

function apScheduleHtml(rows){
  if (!rows.length) {
    return '<div class="vp-empty">現在このエリアで当サイトに掲載している開催予定はありません。<br>開催状況は各店舗の公式情報・SNSをご確認ください。</div>';
  }
  var byDay = {}, order = [];
  for (var i = 0; i < rows.length; i++) {
    var d = rows[i].date;
    if (!byDay[d]) { byDay[d] = []; order.push(d); }
    byDay[d].push(rows[i]);
  }
  var out = [];
  for (var j = 0; j < order.length; j++) {
    var day = order[j], list = byDay[day], p = day.split('-');
    var head = (+p[1]) + '月' + (+p[2]) + '日（' + VP_WD[vpWeekday(day)] + '）';
    var trs = [];
    for (var k = 0; k < list.length; k++) {
      var t = list[k], extra = '';
      if (t.guarantee) extra += '<span class="gtd">GTD ' + vpNum(t.guarantee) + '</span>';
      if (t.recurring) extra += '<span class="vp-recur">毎週' + VP_WD[vpWeekday(day)] + '曜</span>';
      var tg = t.tags || [];
      if (tg.length) extra += '　<span class="vp-tags">' + tg.map(vpEsc).join('・') + '</span>';
      if (t.lowConfidence) extra += '　<span class="vp-warn">⚠ 要確認</span>';
      trs.push('<tr><td class="start">' + vpEsc(t.start || '—') + '</td>'
        + '<td class="ap-venue"><a href="/venues/' + vpEsc(t.venueSlug) + '/">' + vpEsc(t.venueName) + '</a></td>'
        + '<td>' + vpEsc(t.name) + extra + '</td>'
        + '<td class="buyin">' + vpEsc(vpBuyin(t)) + '</td></tr>');
    }
    out.push('<h3 class="vp-day">' + head + '</h3>'
      + '<div class="sched-wrap"><table class="sched">'
      + '<thead><tr><th>開始</th><th>店舗</th><th>トーナメント</th><th>バイイン</th></tr></thead>'
      + '<tbody>' + trs.join('') + '</tbody></table></div>');
  }
  return out.join('\\n');
}
`;

// Node 側から同じ関数を使う。SCHEDULE_JS と同じく、静的側と1文字も分岐させない。
const AREA_SCHED = vm.runInNewContext(
  SCHEDULE_JS + AREA_SCHEDULE_JS + '\n;({ apRows: apRows, apScheduleHtml: apScheduleHtml })',
  { RecurringDedupe });

/**
 * そのエリアの静的ページに焼き込む期間。【エリア別】。
 * そのエリアの店の日付つきトーナメントだけから決める(月単位に丸める)。
 *
 * 【定期開催しかないエリアで recurringOnlyRange を使わない理由】
 *   venue-schedule.js の recurringOnlyRange() は「全店の最古月」を起点にする代表期間で、
 *   放っておくと動かず古びる(あちらのコメントの「代償」を参照)。店舗ページでは
 *   その店の全曜日を見せるために必要だったが、エリアページでは同じ内容が
 *   各店の店舗ページに既にある。古い月をエリアページにも並べる利点が無いので、
 *   日付つきが1件も無いエリアは期間なし(=日程表は空)として扱う。
 */
function areaRange(TOURNAMENTS, venues) {
  const ids = new Set(venues.map(v => v.id));
  return monthRange(TOURNAMENTS.filter(t => ids.has(t.venueId)).map(t => t.date));
}

/** そのエリアに掲載中の日程が1行でもあるか(sitemap の掲載判定)。実行日に依存しない。 */
function hasAreaSchedule(TOURNAMENTS, RECURRING, venues) {
  const range = areaRange(TOURNAMENTS, venues);
  if (!range) return false;
  return AREA_SCHED.apRows(TOURNAMENTS, RECURRING, venues, range.from, range.to).length > 0;
}

module.exports = {
  AREA_SLUGS,
  MIN_VENUES_FOR_AREA_PAGE,
  AREA_SCHEDULE_JS,
  AREA_SCHED,
  areaVenues,
  areaList,
  validateAreaSlugs,
  areaRange,
  hasAreaSchedule
};
