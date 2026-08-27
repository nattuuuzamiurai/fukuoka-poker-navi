/* ============================================================
 * big-events.js — 大型イベント(WJPT / JOPT / FST …)のレジストリと掲載期間の共通判定
 *
 * ■ このファイルが「会期(days)」と「掲載期間ルール」の唯一の正。
 *   - トップページ(index.html)のバナー           … visibleBigEvents() が返す全件
 *   - トップページのフッター「大会特集」          … footerBigEvent()   が返す1件
 *   - 静的イベントページ(events/<slug>/)のフッター … footerBigEvent()   が返す1件
 *   判定を各所に書き散らさない(終了した大会が出しっぱなしになる事故を防ぐ)。
 *
 * ■ 掲載期間ルール(社長指示・2026-07-29)
 *   各イベントの掲載ウィンドウは **他のイベントを一切参照せず独立** して決まる。
 *     - 掲載開始日 = そのイベントの **初日 − 14日**
 *     - 掲載終了日 = そのイベントの **最終日 + 1日**(その日は含む)
 *         … 大型大会は日付を跨いで進行することがあるため、最終日の翌日までは載せ続ける
 *   ⇒ 掲載期間は **重なってよい**。トップのバナーは同時に複数件出る(社長了承済み)。
 *   ⇒ 逆に、どのウィンドウにも入らない期間はバナー0件になる(例: 2026-08-18〜09-04)。
 *      これは仕様であってバグではない。埋めようとしないこと。
 *
 * ■ フッターの「大会特集」だけは掲載ウィンドウに縛られない(footerBigEvent を参照)。
 *   バナーが0件の期間でも「次の大会」を1件出し続ける。
 *
 * ■ 大会を追加するときは下の BIG_EVENTS に1エントリ足すだけでよい。
 *   掲載期間は会期から自動計算されるので、個別の表示ロジックは書かないこと。
 *   詳しい手順は README.md「大型イベントの追加手順と掲載期間ルール」を参照。
 * ============================================================ */

const BIG_EVENTS = [
  {
    id: 'wjpt',
    label: 'WJPT 2026',                       // フッター「大会特集」の表示名
    days: ['2026-07-18', '2026-07-19', '2026-07-20'],
    featureUrl: '/events/wjpt-2026/',         // フッターのリンク先(サイトルート起点)
    hash: '#wjpt',                            // トップページ内の特集ページ(バナーのリンク先)
    banner: 'img/wjpt/wjpt-banner.jpg',
    bannerAlt: 'WJPT West Japan Poker Tour 7.18-7.20 北九州',
    bannerDesc: '北九州・全21トーナメント',
    bannerClass: 'ev-wjpt',
    // ---- WJPT 2026 サテライト開催実績(依頼4・2026-08-28。終了済み大会のアーカイブ) ----
    // FSTの satelliteVenueIds(下記)と同じ機械走査で集計。判定基準は「大会名(name)または
    // タグ(tags)に『サテライト』『satellite』を含み、かつ大会名またはタグに『WJPT』を含む」こと。
    // 再集計用のワンライナー(再実行するときは正規表現の FST → WJPT に読み替える):
    //   node -e "const D=require('./data.js');const sat=/サテライト|satellite/i,re=/WJPT/i;
    //     const hit=t=>(sat.test(t.name||'')||(t.tags||[]).some(x=>sat.test(x)))&&
    //       (re.test(t.name||'')||(t.tags||[]).some(x=>re.test(x)));
    //     const ids=new Set([...D.TOURNAMENTS,...D.RECURRING].filter(hit).map(t=>t.venueId));
    //     console.log([...ids].sort())"
    // 企画部の参考情報(目視)はKENポーカー久留米(v21)・KKPOKER FUKUOKA(v2)の2店舗のみだったが、
    // 機械走査ではv13(PokerBar NUWLAND)・v18(Poker Bar IRIS)・v25(72 -SevenTwo-)の3店舗が
    // 追加で見つかり、計5店舗が正(FSTのv25除外とは別件。WJPTは会期が終了しており「現在開催中」
    // という現在形の主張をしないアーカイブ表示のみのため、FSTの30日基準・タグ整合性チェックは適用しない)。
    // 【会期は既に終了済み(7/18-20)】このリストは「現在開催中」ではなく「過去に開催していた」
    // という過去形・アーカイブ表示にのみ使うこと(tools/gen-event-pages.js の
    // satelliteVenuesBlock() / tools/gen-venue-pages.js の venuePastSatelliteEvents() を参照)。
    pastSatelliteVenueIds: ['v2', 'v13', 'v18', 'v21', 'v25']
  },
  {
    id: 'jopt',
    label: 'JOPT 2026 福岡',
    days: ['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'],
    featureUrl: '/events/jopt-2026-fukuoka-01/',
    hash: '#jopt',
    banner: 'img/jopt/jopt-banner.jpg',
    bannerAlt: 'JOPT 2026 Fukuoka #01 7.30-8.2 UNITEDLAB 福岡・大名',
    // 件数はデータ読み込み後に index.html 側が上書きする(jopt-data.js は #jopt を開くまで読まないため)
    bannerDesc: '福岡・大名／全44トーナメント',
    bannerClass: 'ev-jopt',
    // ---- JOPT 2026 福岡 #01 サテライト開催実績(依頼4・2026-08-28。終了済み大会のアーカイブ) ----
    // 判定基準・再集計方法はWJPTと同じ(正規表現を JOPT に読み替える)。
    // 企画部の参考情報(目視)はKKPOKER FUKUOKA(v2)・RAFTEL CASINO(v37)・Poker room SKY(v33)の
    // 3店舗のみだったが、機械走査ではv8(RAISE BLUE 天神)・v22(CRownCLown)・v25(72 -SevenTwo-)・
    // v26(JOKER♠️ 福岡大橋)・v35(A&K)の5店舗が追加で見つかり、計8店舗が正。
    // ★v25は「SP ギルガメッシュ（JOPT福岡 or FST5.0 / …）」(tags: サテライト/ハイローラー/JOPT/FST)
    //   の1件がJOPT/FST両対応の併記形。FSTの satelliteVenueIds では継続確認が取れず除外しているが、
    //   このJOPTアーカイブ一覧は「開催実績」の記録であり、tagsに'JOPT'を含む事実は動かないため含めている
    //   (FST側の除外理由=「現在開催中」という現在形の主張を続けられるかどうかとは別の論点)。
    // 【会期は既に終了済み(7/30-8/2)】過去形・アーカイブ表示にのみ使うこと。
    pastSatelliteVenueIds: ['v2', 'v8', 'v22', 'v25', 'v26', 'v33', 'v35', 'v37']
  },
  {
    id: 'nippon',
    label: 'NIPPON SERIES 福岡 2026',
    days: ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'],
    featureUrl: '/events/nippon-series-2026-fukuoka/',
    hash: '#nippon',
    banner: 'img/nippon-series/nippon-series-banner.svg',
    bannerAlt: 'NIPPON SERIES FUKUOKA 2026 8.11-8.16 福岡 トヨタホールスカラエスパシオ',
    bannerDesc: '福岡・渡辺通／全38イベント',
    bannerClass: 'ev-nippon',
    // ---- 日本シリーズ 2026 福岡 サテライト開催実績(依頼4・2026-08-28) ----
    // WJPT/JOPTと同じ機械走査(正規表現を「日本シリーズ|NIPPON|nippon」に読み替え)を実行したが、
    // data.js の TOURNAMENTS/RECURRING に該当エントリは1件も無かった(0件)。名前に「NIPPON」を
    // 含む2件("NIPPON SERIES タッグトナメ（ボルCUP体験会）" v21・"m NIPPON SERIES KICK OFF" v3)は
    // 存在するが、いずれもtagsに「サテライト」を含まない特別開催イベントで、チケット獲得を
    // 目的としたサテライトではない。企画部の過去調査でも日本シリーズの候補店舗は報告されていない
    // (WJPT/JOPTと違って参考情報が無かった)ため、この0件は集計漏れではなく実態と判断する。
    // pastSatelliteVenueIds は意図的に空配列にしてある(フィールド自体を省略すると「集計していない」
    // のか「集計して0件だった」のか区別が付かないため、0件であることを明示する)。
    // data.js が更新されて該当エントリが増えたら、上記ワンライナーを再実行してここを埋めること。
    pastSatelliteVenueIds: []
  },
  {
    id: 'fst',
    // ナンバリング「5.0」は主催者公式X(@fst_202408)の2026-07-21の告知で確認済み。
    //   https://x.com/fst_202408/status/2079519350244225267
    //     「【FST5.0ディーラー大募集】…【大会概要】📍ホテルニューオータニ博多 🗓️2026年9月19日-9月23日」
    //     → ナンバリングと会期・会場が同一投稿で結び付いている(過去大会との取り違えなし)
    // 表記の詳細と他の裏取りは index.html の const FST のコメントを参照。
    label: 'FST 5.0 2026 福岡',
    days: ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'],
    // 個別トーナメントは未発表だが、会期・会場・プライズ概要だけの静的ページを用意している
    // (ハッシュURLだと検索エンジンに個別ページとしてインデックスされないため)。
    // 中身は tools/gen-event-pages.js が index.html の const FST から生成する。
    featureUrl: '/events/fst-2026-fukuoka/',
    hash: '#fst',
    banner: 'img/fst/fst-banner.svg',
    bannerAlt: 'FST 5.0 FUKUOKA SUPER TOURNAMENT 9.19-9.23 ホテルニューオータニ博多',
    // ★ここにナンバリング(FST 5.0)を入れないこと。キャプションは狭い画面で末尾が省略されるため、
    //   「FST 5.」のように【数字の途中で切れる】(トップ375px・#majors で実測)。
    //   ナンバリングはバナー画像内のバッジと bannerAlt が持っているので、ここで重ねる必要はない。
    bannerDesc: '福岡・渡辺通／怒涛の5日間',
    bannerClass: 'ev-fst',
    // ---- FST 5.0 サテライト開催店舗(社長方針・2026-08-27) ----
    // data.js の TOURNAMENTS / RECURRING を機械的に走査して集計した結果(手打ちではない)。
    // 判定基準: 大会名(name)またはタグ(tags)に「サテライト」「satellite」を含み、
    //   かつ 大会名またはタグに「FST」を含むエントリ(他大会=JOPT/WJPT向けサテライトは除外)。
    // 集計に使ったワンライナー(再集計する場合はこれを再実行する):
    //   node -e "const D=require('./data.js');const sat=/サテライト|satellite/i,fst=/FST/i;
    //     const hit=t=>(sat.test(t.name||'')||(t.tags||[]).some(x=>sat.test(x)))&&
    //       (fst.test(t.name||'')||(t.tags||[]).some(x=>fst.test(x)));
    //     const ids=new Set([...D.TOURNAMENTS,...D.RECURRING].filter(hit).map(t=>t.venueId));
    //     console.log([...ids].sort())"
    // 企画部の目視確認(TOURNAMENTS配列の7割ほど)では13店舗+note記載のみ2店舗(v28/v34)だったが、
    // 上記の機械走査で v14・v18・v20・v21・v35 の5店舗が追加で見つかったため、このリストが正。
    // 新しく満たさなくなったら(店舗が開催をやめたら)、上のワンライナーを再実行して更新すること。
    //
    // ★ v25(72 -SevenTwo-)は上記ワンライナーの結果には含まれる(2026-07-29の1件
    //   「SP ギルガメッシュ（JOPT福岡 or FST5.0 / …）」タグ["サテライト","ハイローラー","JOPT","FST"]
    //   が該当)が、【意図的に除外】している(品質管理部の指摘・2026-08-28)。
    //   - その1件はJOPT/FST5.0のどちらでも通用する併記形で、FST専用のサテライトと言い切れない。
    //   - それ以降(8月)も「選べるサクッとサテライト」「夏の王者決定戦サテライト」等が続くが、
    //     いずれも tags に "FST" が付いておらず、対象大会が読み取れない(店舗ページ側の
    //     venueHasCurrentFstSatellite() の判定基準でも「直近30日以内にFSTタグ付きの
    //     エントリが無い」ため「現在開催中」を出さない)。
    //   - 当社は店舗の公式SNS等に直接アクセスする手段(WebFetch/WebSearch)を持たないため、
    //     継続の有無を追加で確認できなかった。ここに含めたまま店舗ページ側だけ表示しないと
    //     大会ページ「サテライト開催店舗」とのあいだで「開催中/していない」の主張が矛盾する
    //     ため、確認が取れるまでは【大会ページ側も含めない】(過大表示より過小表示を選ぶ)。
    //   - 店舗ページ側の再スキャンで、TOURNAMENTS の該当エントリに "FST" タグが確実に補われる
    //     (企画部・マーケティング部等が公式SNSで継続を確認できる)か、または上記ワンライナーの
    //     判定基準そのものを見直すまでは、ここに v25 を戻さないこと。
    satelliteVenueIds: [
      'v2', 'v7', 'v8', 'v13', 'v14', 'v18', 'v19', 'v20', 'v21',
      'v22', 'v26', 'v27', 'v28', 'v33', 'v34', 'v35', 'v37', 'v40'
    ]
  }
];

// ---- 日付ユーティリティ(YYYY-MM-DD の文字列比較で完結させる) ----
// 端末のローカル日付。UTCに変換すると日本の深夜に前日扱いになるため必ずローカルで組み立てる。
function localTodayGlobal() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
// YYYY-MM-DD を n 日ずらす(月またぎ・年またぎは Date に任せる)
function shiftDateStr(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
// イベントの会期は days(YYYY-MM-DD の配列)で表す。並び順に依存しないよう端ではなく最小値・最大値で求める。
const eventFirstDay = days => (Array.isArray(days) && days.length) ? days.reduce((a, b) => a < b ? a : b) : null;
const eventLastDay = days => (Array.isArray(days) && days.length) ? days.reduce((a, b) => a > b ? a : b) : null;
// ★★ 掲載ウィンドウと「開催中/終了」の判定は、しきい値が意図的に1日ずれている ★★
//   これはバグではなく社長指示による仕様(2026-07-29)。将来「ズレている」と思って揃えないこと。
//
//   ┌ 掲載ウィンドウ(出すか出さないか) … 最終日の【翌日】まで = eventShowUntil()
//   │   大型大会は日付を跨いで進行することがあるため、翌日までは載せ続ける。
//   └ 開催中/終了(どう見せるか)        … 最終日までが開催中、【翌日から終了】 = isEventArchived()
//       社長の言葉:「掲載してほしいだけで次の日はバナーは終了でいいです」
//
//   ⇒ 最終日の翌日は「バナーは出るが、終了状態(暗転・終了バッジ)で表示される」が正解。
//     同じ日、イベント専用ページには通常どおり「このイベントは終了しました」を出す。

// 掲載開始日 = 会期初日の14日前 / 掲載終了日 = 会期最終日の翌日(どちらもその日を含む)
const BANNER_LEAD_DAYS = 14;
const eventShowFrom = days => {
  const first = eventFirstDay(days);
  return first ? shiftDateStr(first, -BANNER_LEAD_DAYS) : null;
};
const eventShowUntil = days => {
  const last = eventLastDay(days);
  return last ? shiftDateStr(last, 1) : null;
};
// 会期最終日を過ぎたイベントは「終了(アーカイブ=開催当時の記録)」として扱う。
// バナーの見た目もページ内の文言の出し分けも、日付比較を各所に書かず必ずこの関数を通すこと。
const isEventArchived = (days, today) => {
  const last = eventLastDay(days);
  return !!last && (today || localTodayGlobal()) > last;
};
// 会期中(初日〜最終日)か
const isEventOngoing = (days, today) => {
  const t = today || localTodayGlobal();
  const first = eventFirstDay(days), last = eventLastDay(days);
  return !!first && t >= first && t <= last;
};

// ---- 掲載期間(掲載開始日〜掲載終了日)の計算 ----
// 各イベント独立。他イベントを参照しないので、レジストリの並び順にも依存しない。
// 戻り値: [{ event, from, to }] を掲載開始日の昇順で返す。
function bigEventWindows(events) {
  return (events || BIG_EVENTS)
    .filter(e => eventFirstDay(e.days) && eventLastDay(e.days))
    .map(e => ({ event: e, from: eventShowFrom(e.days), to: eventShowUntil(e.days) }))
    .sort((a, b) => a.from.localeCompare(b.from));
}

// トップのバナー領域に出すイベント(0件〜複数件)。掲載ウィンドウに入っているものすべて。
// 並び順は ①開催中 → ②まもなく(初日の近い順) → ③終了(猶予日) で、終了したものを末尾に置く。
function visibleBigEvents(today, events) {
  const t = today || localTodayGlobal();
  const rank = e => isEventOngoing(e.days, t) ? 0 : (isEventArchived(e.days, t) ? 2 : 1);
  return bigEventWindows(events)
    .filter(w => t >= w.from && t <= w.to)
    .map(w => w.event)
    .sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      // 開催中どうしは終わりが早い順、まもなくは初日が近い順、終了は新しい順
      if (ra === 0) return eventLastDay(a.days).localeCompare(eventLastDay(b.days));
      if (ra === 1) return eventFirstDay(a.days).localeCompare(eventFirstDay(b.days));
      return eventLastDay(b.days).localeCompare(eventLastDay(a.days));
    });
}

// フッター「大会特集」に出す1件。開催中があればそれ(複数なら最終日が早い方)、
// 無ければ次の大会(初日が最も近い未来)。どちらも無ければ null。
// ※ここは掲載ウィンドウ(初日−14日)に縛られない。バナーが0件の期間でも
//   「次の大会」を出し続けるため(社長指示・2026-07-29)。バナーと一致しない日がある。
//   猶予日(最終日の翌日)のイベントは終了扱いなので「開催中」には含めない。
function footerBigEvent(today, events) {
  const t = today || localTodayGlobal();
  const list = (events || BIG_EVENTS).filter(e => eventFirstDay(e.days) && eventLastDay(e.days));
  const ongoing = list.filter(e => isEventOngoing(e.days, t))
    .sort((a, b) => eventLastDay(a.days).localeCompare(eventLastDay(b.days)));
  if (ongoing.length) return ongoing[0];
  const upcoming = list.filter(e => t < eventFirstDay(e.days))
    .sort((a, b) => eventFirstDay(a.days).localeCompare(eventFirstDay(b.days)));
  return upcoming.length ? upcoming[0] : null;
}

// ---- 大型一覧(#majors)に並べるイベント ----
// 未開催・開催中は全件、終了済みは【新しい順に maxArchived 件まで】(既定3件)。それより古いものは出さない。
// 並びは会期の古い順(画面の上から 過去 → 未来)。
// レジストリにエントリを足せば自動でここに載るので、一覧側に個別の書き足しは不要。
function bigEventListForIndex(today, maxArchived) {
  const t = today || localTodayGlobal();
  const max = (maxArchived === undefined || maxArchived === null) ? 3 : maxArchived;
  const sorted = BIG_EVENTS
    .filter(e => eventLastDay(e.days))
    .slice()
    .sort((a, b) => eventLastDay(a.days).localeCompare(eventLastDay(b.days)));
  const ended = sorted.filter(e => isEventArchived(e.days, t));
  const live = sorted.filter(e => !isEventArchived(e.days, t));
  // slice(-0) は配列全体を返してしまうため、0件指定は明示的に空配列にする(境界のバグ防止)
  const keptEnded = max <= 0 ? [] : ended.slice(-max);
  return keptEnded.concat(live).map(e => ({ event: e, archived: isEventArchived(e.days, t) }));
}

function bigEventById(id) {
  return BIG_EVENTS.find(e => e.id === id) || null;
}
function bigEventDays(id) {
  const e = bigEventById(id);
  return e ? e.days.slice() : [];
}

// ---- フッター「大会特集」の描画(トップページ・静的ページ共通) ----
// 開催中の大会、開催中が無ければ次の大会を1件だけ出す。該当が無ければ行ごと隠す。
// トップのバナー(visibleBigEvents)とは判定条件が違うため、一致しない日がある(仕様)。
function mountBigEventFooter(elId, today) {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById(elId || 'evtFeature');
  if (!el) return null;
  const ev = footerBigEvent(today);
  if (!ev) { el.innerHTML = ''; el.style.display = 'none'; return null; }
  el.innerHTML = '大会特集: <a href="' + ev.featureUrl + '">' + ev.label + '</a>';
  el.style.display = '';
  return ev;
}

if (typeof module !== 'undefined') {
  module.exports = {
    BIG_EVENTS, BANNER_LEAD_DAYS, localTodayGlobal, shiftDateStr,
    eventFirstDay, eventLastDay, eventShowFrom, eventShowUntil,
    isEventArchived, isEventOngoing,
    bigEventWindows, visibleBigEvents, footerBigEvent,
    bigEventListForIndex, bigEventById, bigEventDays
  };
}
