#!/usr/bin/env node
/**
 * venue-schedule.js — 店舗ページの日程表を組み立てるコードの【唯一の所有者】
 *
 * 【なぜ独立したファイルなのか】
 *   「その店に掲載中の日程があるか」を、2つのスクリプトが同じ基準で判定する必要がある。
 *     - gen-venue-pages.js … 0件の店の title/description を「日程を掲載」と断定しない文面に切り替える
 *     - gen-sitemap.js     … 0件の店を sitemap から外す
 *   基準が2箇所にあるとズレて、「sitemapには載っているのに中身は空」あるいはその逆が起きる。
 *   そこで判定を1箇所に寄せた。
 *
 *   gen-venue-pages.js から require して共有する形は取れない。あちらは CLI 引数
 *   (リポジトリのパス)に依存するトップレベルのコードを持つため、require した瞬間に
 *   引数無しで走って落ちる。加えて gen-venue-pages.js は gen-sitemap.js を require
 *   しているので、逆向きに require すると循環参照になる。
 *
 * 【日付に依存させない理由】
 *   判定に「今日」を使うと、データを1文字も触っていないのに翌日には --check が落ちる。
 *   判定はすべて venueRange() が返す固定の期間内で行う。閲覧時に「今日以降」へ描き直すのは
 *   ブラウザ側の仕事で、静的HTMLの中身とは分けている。
 *
 * 【焼き込む期間は店舗ごとに独立させる】
 *   以前は「data.js 全体の最小日〜最大日」を1つ作って全店で使い回していた。これには2つの害があった。
 *     - 事実として不正確 … 9月分の日程を持つのが1店だけでも、他の34店のページに
 *       「※ この一覧は2026年7月〜9月の掲載分です」と出て、9月分の定期開催行まで焼き込まれる。
 *     - 波及が全店に及ぶ … 1店に1件足しただけで35ページ全部が書き換わる。実測で、
 *       9月の1件が消えると36ファイル、2027年3月の大会が1件載ると venues/ が 1.1MB→1.4MB。
 *       無人の日次自動取込でこれを毎朝やると、venues/ を触る他の作業と競合が常態化する。
 *   そこで期間は venueRange() が【その店の日付つきトーナメントだけ】から決める。
 *   1店の変更はその店のページにしか届かず、見出しもその店の実データと一致する。
 *   ★ ブラウザ側(SCHEDULE_JS)はこの期間を使わない。閲覧時の窓は
 *     gen-venue-pages.js が埋め込むスクリプトが「今日〜max(掲載最終日, 今日+60日)」として
 *     その場で決めている。したがってこの変更で公開サイトの描画は変わらない。
 *
 * 【ここが持たないもの: 定期開催の重複判定】
 *   「自動取込(source:'auto')と同じ枠の RECURRING を出さない」規則は、このファイルではなく
 *   リポジトリ直下の recurring-dedupe.js が所有する。トップのSPA(index.html)も同じ規則を
 *   必要とするが、あちらは SCHEDULE_JS を読めない(こちらは Node の vm で回す文字列)。
 *   同じ判定を2箇所に書けば必ず片方が古くなるので、判定だけを素のJSファイルに切り出し、
 *   Node は require、店舗ページとSPAは <script src> で【同じ1本を読む】形にした。
 */

const vm = require('vm');
const path = require('path');

/* 「自動取込(source:'auto')と同じ枠の定期開催は出さない」判定は recurring-dedupe.js が所有する。
   ここに書き写すと index.html 側と必ずズレるため、Node も店舗ページも同じファイルを読む
   (店舗ページ側は gen-venue-pages.js が <script src="/recurring-dedupe.js"> で読み込む)。 */
const RecurringDedupe = require(path.join(__dirname, '..', 'recurring-dedupe.js'));

// ============================================================
const SCHEDULE_JS = `
function vpEsc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
var VP_WD = ['日','月','火','水','木','金','土'];
function vpParse(iso){ var a = iso.split('-'); return Date.UTC(+a[0], +a[1] - 1, +a[2]); }
function vpToIso(ms){ var d = new Date(ms); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }
function vpWeekday(iso){ return new Date(vpParse(iso)).getUTCDay(); }
function vpNum(n){ return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); }

/* 毎週固定の定期トーナメント(RECURRING)を、日付つきの形に展開する。
   index.html の expandRecurring() と同じ考え方。 */
function vpExpandRecurring(RECURRING, venueId, fromIso, toIso){
  var out = [], end = vpParse(toIso);
  for (var ms = vpParse(fromIso); ms <= end; ms += 86400000) {
    var iso = vpToIso(ms), wd = new Date(ms).getUTCDay();
    for (var i = 0; i < RECURRING.length; i++) {
      var r = RECURRING[i];
      if (r.venueId !== venueId || r.weekday !== wd) continue;
      /* venueId は表には出ないが、自動取込との重複判定(recurring-dedupe.js)が鍵に使うので必ず持たせる。
         ここが欠けると判定が黙って空振りする(index.html 側の展開行は元から持っている)。 */
      out.push({ venueId: r.venueId, name: r.name, date: iso, start: r.start, buyin: r.buyin, addon: r.addon,
                 stack: r.buyinStack || 0, lateReg: r.lateReg, guarantee: null,
                 tags: r.tags || [], recurring: true });
    }
  }
  return out;
}

/* その店の [fromIso, toIso] の日程を、日付→開始時刻の順に並べて返す。 */
function vpRows(TOURNAMENTS, RECURRING, venueId, fromIso, toIso){
  var abs = [];
  for (var i = 0; i < TOURNAMENTS.length; i++) {
    var t = TOURNAMENTS[i];
    if (t.venueId !== venueId || t.date < fromIso || t.date > toIso) continue;
    abs.push(t);
  }
  /* 自動取込(source:'auto')と (日付, 開始時刻) が一致する定期開催の行は出さない。
     判定は recurring-dedupe.js が持つ(index.html の expandRecurring も同じファイルを読む)。
     ★ 抑止した行と対になる自動取込の行は必ず同じ日付 = 必ず abs に入っているので、
       この間引きで行が0件になることはない(sitemap の掲載判定 hasSchedule が壊れない)。 */
  var rec = vpExpandRecurring(RECURRING, venueId, fromIso, toIso);
  if (typeof RecurringDedupe !== 'undefined') rec = RecurringDedupe.filterExpanded(TOURNAMENTS, rec);
  return abs.concat(rec)
    .sort(function(a, b){
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      var sa = a.start || '99:99', sb = b.start || '99:99';
      return sa < sb ? -1 : (sa > sb ? 1 : 0);
    });
}

/* バイインの表示。index.html のトーナメントカードと同じ判断にそろえる。
   金額が入っていない場合に「無料」と決めつけないこと(タグにフリーロールと
   書かれているものだけフリーロールとして出し、それ以外は店舗確認に誘導する)。 */
function vpBuyin(t){
  if (t.buyin) return '\\u00a5' + vpNum(t.buyin);
  var tags = t.tags || [];
  for (var i = 0; i < tags.length; i++) {
    if (String(tags[i]).indexOf('フリーロール') >= 0) return 'フリーロール';
  }
  return '詳細は店舗SNSを確認';
}

function vpScheduleHtml(rows){
  if (!rows.length) {
    return '<div class="vp-empty">現在このサイトに掲載している開催予定はありません。<br>開催状況は店舗の公式情報・SNSをご確認ください。</div>';
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
      /* 抽出確度が低いものは黙って混ぜず、その旨を出す(READMEの編集方針)。 */
      if (t.lowConfidence) extra += '　<span class="vp-warn">⚠ 要確認</span>';
      trs.push('<tr><td class="start">' + vpEsc(t.start || '—') + '</td>'
        + '<td>' + vpEsc(t.name) + extra + '</td>'
        + '<td class="buyin">' + vpEsc(vpBuyin(t)) + '</td>'
        + '<td class="buyin">' + (t.stack ? vpNum(t.stack) + '点' : '—') + '</td></tr>');
    }
    out.push('<h3 class="vp-day">' + head + '</h3>'
      + '<div class="sched-wrap"><table class="sched">'
      + '<thead><tr><th>開始</th><th>トーナメント</th><th>バイイン</th><th>スタック</th></tr></thead>'
      + '<tbody>' + trs.join('') + '</tbody></table></div>');
  }
  return out.join('\\n');
}
`;

// Node側から同じ関数を使う。SCHEDULE_JS を書き換えれば静的側も自動で追随する。
// RecurringDedupe はブラウザではグローバル(<script src>)なので、vm 側にも同じ名前で渡す
// = 静的ページに埋め込むコードと Node が走らせるコードを1文字も分岐させない。
const SCHED = vm.runInNewContext(SCHEDULE_JS
  + '\n;({ vpRows: vpRows, vpScheduleHtml: vpScheduleHtml, vpToIso: vpToIso, vpParse: vpParse })',
  { RecurringDedupe });

// ---- 静的側に焼き込む期間 ----

/**
 * YYYY-MM-DD の配列 → 月単位に丸めた期間。1件も無ければ null。実行日に依存させない。
 *
 * 【書式を検査する理由】並べ替えは文字列の辞書順で行う(その書式なら辞書順=時系列順になる)。
 *   ゼロ埋めされていない日付が1件混ざると前提が崩れ、'2026-9-5' が '2026-10-01' より後ろに
 *   並んで from > to の逆転した期間と「2026年10月〜9月」という見出しが静かに出来上がる。
 *   data.js のスキーマはゼロ埋めを要求しているので、外れた入力は黙って通さず落とす。
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function monthRange(dates) {
  const sorted = dates.filter(Boolean).slice().sort();
  const bad = sorted.filter(d => !ISO_DATE.test(String(d)));
  if (bad.length) {
    throw new Error(`日付は YYYY-MM-DD（ゼロ埋め）で書いてください。想定外の値: ${bad.slice(0, 3).join(', ')}`);
  }
  if (!sorted.length) return null;
  const [fy, fm] = sorted[0].split('-').map(Number);
  const [ly, lm] = sorted[sorted.length - 1].split('-').map(Number);
  const lastDay = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
  return {
    from: `${fy}-${String(fm).padStart(2, '0')}-01`,
    to: `${ly}-${String(lm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    label: (fy === ly && fm === lm) ? `${fy}年${fm}月` : `${fy}年${fm}月〜${ly === fy ? '' : ly + '年'}${lm}月`
  };
}

/**
 * 定期開催(RECURRING)しか持たない店に使う代表期間。
 *
 * 【なぜ必要か】その店由来の日付が1つも無いので、店舗別の期間を作れない。
 *   かといって期間を決めないとページが空になる(定期開催は日付に展開して初めて行になる)。
 *
 * 【窓の長さが1ヶ月である理由】
 *   定期開催は毎週繰り返すので、1ヶ月あればその店の全曜日が1回以上出る。
 *   3ヶ月分並べても同じ行が増えるだけで情報は増えない(むしろ重複コンテンツになる)。
 *
 * 【窓を「サイト全体の掲載期間の先頭の月」に置く理由】
 *   ★ サイズの問題ではない。1ヶ月窓なら最終月に置いても行数はほぼ同じ
 *     (実測: 先頭月35行 / 最終月34行。2027年3月の外れ値がある状態でも最終月窓35行)。
 *     「最終日側に置くと数倍に膨らむ」のは窓の長さを固定しない場合の話で、ここには当てはまらない。
 *   最終月に置けない本当の理由は2つ:
 *     - 遠い未来の月を、あたかもその月の開催予定であるかのように表示してしまう
 *       (どこかの店に2027年3月の大会が1件載っただけで、定期開催しかない店のページに
 *        2027年3月の日付が並ぶ)。その店のデータとは何の関係もない月である。
 *     - 他店の最遠日が動くたびにこの3店のページも書き換わる = 今回直した波及が戻る。
 *
 * 【この選び方の代償(必ず理解しておくこと)】
 *   先頭の月はサイト全体の最古の掲載日で、日次の自動取込では動かない
 *   (取込は今日以降しか作らず、過去日のエントリには一切触れないため)。
 *   つまり【起点は放っておくと永久に動かず、焼き込まれる月は古びていく。自己修復しない】。
 *   例: 6ヶ月ぶんの取込を重ねても v5 の窓は 2026-07-01〜2026-07-31 のまま。
 *   そのため呼び出し側(gen-venue-pages.js)は、この期間を
 *   「◯月の掲載分です」のような【時が経つと嘘になる断定】に使ってはいけない。
 *   定期開催しかない店では「毎週の定期開催を1ヶ月ぶん日付に展開した例」として出すこと
 *   (recurringOnly フラグを返しているのはこの分岐のため)。
 *   古い月が並ぶこと自体を解消したい場合は、過去日の焼き込み下限を入れる等の別の手当てが要る。
 *
 * 【全店ぶんを見ることについて】
 *   全店の日付を見るのはこの1ヶ月の起点を決めるためだけで、行の中身は各店のRECURRINGのみ。
 *   ただし「1店の変更が他店に波及しない」は、該当店に関しては構造的な保証ではなく
 *   「取込が過去日を作らない/消さない」という別の性質に依存している(上記)。
 * 該当は v5 / v41 の2店(2026-07-31時点)。v19 は同日にWaitinglistの自動取込対象になり、
 * 日付つきトーナメントが入ったのでこちらの分岐から外れた。
 * 【この一覧は自動で追随しない】ある店が取込対象になると黙って該当から外れるので、
 * STORES を増やすときはここも見直すこと。実際の該当店は
 * `VENUES.filter(v => venueRange(T, R, v.id)?.recurringOnly)` で数えられる。
 */
function recurringOnlyRange(TOURNAMENTS) {
  const all = monthRange(TOURNAMENTS.map(t => t.date));
  if (!all) {
    // data.js に日付つきトーナメントが1件も無い。起点が決められないので黙って何かを焼かない。
    throw new Error('TOURNAMENTS が空です。定期開催のみの店舗に焼き込む期間を決められません。');
  }
  const [y, m] = all.from.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: all.from,
    to: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    label: `${y}年${m}月`
  };
}

/**
 * その店の静的ページに焼き込む期間。【店舗別】。
 *   - 日付つきトーナメントがある店 … その店の日付の範囲(月単位に丸めたもの)。他店の影響を受けない
 *   - 定期開催しか無い店           … recurringOnlyRange()(上記。全店の最古月に依存する点に注意)
 *   - どちらも無い店               … null(焼き込む日程が無い。期間の見出しも出さない)
 *
 * 返り値の recurringOnly は「この期間はその店のデータから決まったものではなく、
 * 定期開催を展開して見せるための代表期間である」という印。
 * これが true のとき、期間を「◯月の掲載分です」と断定に使ってはいけない(上記の代償を参照)。
 */
function venueRange(TOURNAMENTS, RECURRING, venueId) {
  const own = monthRange(TOURNAMENTS.filter(t => t.venueId === venueId).map(t => t.date));
  if (own) return { ...own, recurringOnly: false };
  if (RECURRING.some(r => r.venueId === venueId)) {
    return { ...recurringOnlyRange(TOURNAMENTS), recurringOnly: true };
  }
  return null;
}

/**
 * その店に掲載中の日程が1行でもあるか。
 * 期間の決定ごとこの関数が持つ(呼び出し側が別々に期間を作ると基準がズレるため)。
 * 実行日に依存しない(期間は data.js の日付そのものから決まる)。
 */
function hasSchedule(TOURNAMENTS, RECURRING, venueId) {
  const range = venueRange(TOURNAMENTS, RECURRING, venueId);
  if (!range) return false;
  return SCHED.vpRows(TOURNAMENTS, RECURRING, venueId, range.from, range.to).length > 0;
}

module.exports = { SCHEDULE_JS, SCHED, monthRange, venueRange, hasSchedule, RecurringDedupe };
