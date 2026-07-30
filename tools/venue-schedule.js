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
 *   判定はすべて dataRange() が返す固定の期間内で行う。閲覧時に「今日以降」へ描き直すのは
 *   ブラウザ側の仕事で、静的HTMLの中身とは分けている。
 */

const vm = require('vm');

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
      out.push({ name: r.name, date: iso, start: r.start, buyin: r.buyin, addon: r.addon,
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
  return abs.concat(vpExpandRecurring(RECURRING, venueId, fromIso, toIso))
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
const SCHED = vm.runInNewContext(SCHEDULE_JS
  + '\n;({ vpRows: vpRows, vpScheduleHtml: vpScheduleHtml, vpToIso: vpToIso, vpParse: vpParse })');

// ---- 静的側に焼き込む期間 ----
// data.js に載っている日付の範囲(月単位に丸めたもの)。実行日に依存させない。
function dataRange(TOURNAMENTS) {
  const dates = TOURNAMENTS.map(t => t.date).filter(Boolean).sort();
  if (!dates.length) {
    // 日付つきトーナメントが1件も無い状態。定期分だけでも出せるよう当月を使う。
    throw new Error('TOURNAMENTS が空です。焼き込む期間を決められません。');
  }
  const first = dates[0], last = dates[dates.length - 1];
  const [fy, fm] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  const lastDay = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
  return {
    from: `${fy}-${String(fm).padStart(2, '0')}-01`,
    to: `${ly}-${String(lm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    label: (fy === ly && fm === lm) ? `${fy}年${fm}月` : `${fy}年${fm}月〜${ly === fy ? '' : ly + '年'}${lm}月`
  };
}
/**
 * RANGE 内にその店の掲載行が1行でもあるか。
 * 実行日に依存しない(RANGE は data.js の日付範囲そのもの)。
 */
function hasSchedule(TOURNAMENTS, RECURRING, venueId, RANGE) {
  return SCHED.vpRows(TOURNAMENTS, RECURRING, venueId, RANGE.from, RANGE.to).length > 0;
}

module.exports = { SCHEDULE_JS, SCHED, dataRange, hasSchedule };
