// SPADIE FUKUOKA 1st (2026/11/12-11/15, UNITEDLAB 福岡市中央区大名)
// 出典（一次情報）: 公式Players Guide（Webアプリ）
//   トーナメントリスト: https://spadiefukuoka.netlify.app/schedule/
//     … 各トーナメントの START / REG OPEN / REG CLOSE / CLOSE LV. / END(予定) / ENTRY FEE / CHIPS
//   トーナメント別シート画像: https://spadiefukuoka.netlify.app/img/guide/pg/pg-<番号>.webp
//     … Prize(Total / In Prize)・ストラクチャー全レベル・ブレイク位置・Note(ドリンク代・特別ルール)
// 取得日: 2026-11-12（開催初日）。公式は画像で公開しているため、当サイトが目視で転記した。
//
// 注1: 深夜開始（翌0:00/翌2:00）のトーナメントは公式トーナメントリストと同じく「その夜が始まる日」の
//      枠に置き、時刻は「翌HH:MM」表記で統一（jopt-data.js の注5と同じ）。
// 注2: Prize は公式表記のまま米ドル。JOPTと同じく賞金ではなく「選手契約（委託料）」で、公式シートに
//      「仮レート163.19円/$。実施日3日前に発表する固定為替レートで再計算」と明記されている。
//      円換算はページ側で FX_TEMP から計算して「約◯円（仮レート換算）」とだけ出す（ここに円を手打ちしない）。
// 注3: ストラクチャーは公式シートの全レベル。BB Ante は全レベルで BB と同額（NLH系）。
//      PLO / FL 2-7 TD & Badugi のシートには Ante 列が無いため ante:false。
//      FL の「Blinds」列はシート表記のまま（リミットの小/大）。
// 注4: #34 NLH Employees（11/15 19:00・¥4,000）は公式シートに『本イベントで勤務した方のみエントリー可能』
//      と明記された関係者限定イベントのため収録対象外（jopt-data.js の注6と同じ扱い）。
// 注5: #01 Day 1C の END は、トーナメントリストでは 20:30、#01のシートでは「20:40 End of Day 1」。
//      シート側の値を採用し、notes に食い違いを残す。
// 注6: #30 NLH Elite 1000 は公式トーナメントリストに REG OPEN の記載が無い（空欄のまま）。

(function (root) {
  // ---- ブラインドの並び（公式シートから転記。各トーナメントの levels は下の検証で件数を確認する） ----
  const STD = ['100-200', '200-300', '200-400', '300-500', '300-600', '400-800', '500-1,000', '600-1,200',
    '1,000-1,500', '1,000-2,000', '1,500-3,000', '2,000-4,000', '2,500-5,000', '3,000-6,000', '4,000-8,000',
    '5,000-10,000', '6,000-12,000', '10,000-15,000', '10,000-20,000', '15,000-30,000', '20,000-40,000',
    '25,000-50,000', '30,000-60,000', '40,000-80,000', '50,000-100,000', '60,000-120,000', '75,000-150,000',
    '100,000-200,000', '150,000-300,000', '200,000-400,000', '250,000-500,000', '300,000-600,000',
    '400,000-800,000', '500,000-1,000,000', '600,000-1,200,000', '1,000,000-1,500,000', '1,000,000-2,000,000'];
  const without = (arr, drop) => arr.filter(b => !drop.includes(b));
  const fromIdx = b => STD.slice(STD.indexOf(b));
  const LADDERS = {
    std: STD,                                                                  // 37 Lv
    np: without(STD, ['2,500-5,000', '25,000-50,000', '250,000-500,000']),    // 34 Lv
    team: without(STD, ['300-500', '2,500-5,000', '25,000-50,000', '250,000-500,000']), // 33 Lv
    mid: without(STD, ['300-500', '2,500-5,000', '6,000-12,000', '25,000-50,000', '60,000-120,000',
      '250,000-500,000', '600,000-1,200,000']),                                // 30 Lv
    ft: without(STD, ['100-200', '200-300', '300-500', '600-1,200', '2,500-5,000', '6,000-12,000',
      '25,000-50,000', '60,000-120,000', '250,000-500,000', '600,000-1,200,000']), // 27 Lv
    elite: fromIdx('300-600'),                                                 // 33 Lv
    diamond: ['400-800', '500-1,000', '600-1,200', '1,000-1,500', '1,000-2,000', '1,500-2,500', '1,500-3,000',
      '2,000-4,000', '2,500-5,000'].concat(fromIdx('3,000-6,000')),            // 33 Lv
    elite1000: ['400-800', '500-1,000', '600-1,200', '1,000-1,500', '1,000-2,000', '1,500-3,000',
      '2,000-4,000', '2,500-5,000'].concat(fromIdx('3,000-6,000')),            // 32 Lv
    supernova: ['1,000-1,500', '1,000-2,000', '1,500-2,500', '1,500-3,000', '2,000-4,000', '2,500-5,000']
      .concat(fromIdx('3,000-6,000'), ['1,500,000-3,000,000', '2,000,000-4,000,000', '2,500,000-5,000,000']), // 33 Lv
    sat: ['100-200', '200-400', '300-600', '400-800', '500-1,000', '1,000-1,500', '1,000-2,000', '1,500-3,000',
      '2,000-4,000', '3,000-6,000', '4,000-8,000', '5,000-10,000', '10,000-15,000', '10,000-20,000',
      '15,000-30,000', '20,000-40,000', '30,000-60,000', '40,000-80,000', '50,000-100,000'], // 19 Lv
    fl: ['200-400', '300-500', '300-600', '400-800', '500-1,000', '600-1,200', '800-1,500', '1,000-2,000',
      '1,500-3,000', '2,000-4,000', '2,500-5,000', '3,000-6,000', '4,000-8,000', '5,000-10,000', '6,000-12,000',
      '8,000-15,000', '10,000-20,000', '15,000-30,000', '20,000-40,000', '25,000-50,000', '30,000-60,000',
      '40,000-80,000', '50,000-100,000', '60,000-120,000', '75,000-150,000', '100,000-200,000',
      '150,000-300,000', '200,000-400,000', '250,000-500,000', '300,000-600,000', '400,000-800,000',
      '500,000-1,000,000', '600,000-1,200,000', '800,000-1,500,000', '1,000,000-2,000,000'], // 35 Lv
    mainD1: STD.slice(0, 10).concat(['1,500-2,500'], STD.slice(10, 17)),       // 18 Lv (Day 1)
    mainD2: fromIdx('10,000-15,000').concat(['1,500,000-3,000,000', '2,000,000-4,000,000', '2,500,000-5,000,000',
      '3,000,000-6,000,000', '4,000,000-8,000,000', '5,000,000-10,000,000', '6,000,000-12,000,000',
      '10,000,000-15,000,000', '10,000,000-20,000,000'])                      // 29 Lv (Lv19〜47)
  };

  // structure: { ladder, firstLevel, minutes:[[fromLv, minutes], ...], breaksAfter:[Lv...], ante }
  //   minutes は「この Lv から何分」を並べたもの（途中で短縮される大会があるため）。
  const S = (ladder, minutes, breaksAfter, extra) => Object.assign({ ladder, firstLevel: 1, minutes, breaksAfter, ante: true }, extra || {});
  const m = n => [[1, n]];

  const MAIN_NOTES = [
    '同一Day 1でのリエントリーは3度まで',
    '複数のDay 1を通過した場合は最も多いスタックのDay 1を採用（他のDay 1の通過スタックは放棄）',
    'Day 2に進出したプレイヤーのみプライズ獲得の権利あり',
    '各Day 1のファーストエントリー時とDay 2開始時に別途ドリンク代1,000円',
    'シートリドローはDay 2スタート時・ファイナルテーブルスタート時など'
  ];
  const MAIN_PRIZE = { total: '$61,278.21', itm: '80位', gtd: '1,000万円保証（公式トーナメントリスト表記「1000万GTD」）' };
  const mainD1 = minutes => S('mainD1', m(minutes), minutes === 30 ? [4, 8, 12, 16] : [6, 12]);
  const DRINK = '別途ドリンク代1,000円（ファーストエントリー時）';
  const TEAM_NOTES = ['2人1組で参加するトーナメント（エントリー時は代表者1名が受付）', 'リエントリー時にチームの組み替え可',
    'チーム内でハンド情報の共有・プレイの相談が可能', 'プライズはチームの2名それぞれに付与',
    'エントリーごとにドリンク代2,000円（プレイ中ドリンク飲み放題）'];
  const SAT_NOTES = n => [`エントリー数の1/${n}が入賞（通過）人数`, '規定チップ数に達したらフロアに自己申告で通過可',
    '規定チップ数を超える等で通過条件を満たした場合は、対象トーナメントの金額分の50,000円・10,000円Voucherで付与',
    'Voucherの有効期限はSPADIE FUKUOKA 2ndまで（SPADIE Fukuokaでのみ使用可）', '1エントリーで獲得できる権利は1つ'];

  const tournaments = [
    // ---- 11/12(木) ----
    { no: '01', day: '2026-11-12', name: 'NLH Main Event', flight: 'Day 1A', start: '18:00', regOpen: '17:30', regClose: '23:20', closeLv: 10, end: '翌03:40', entry: '2 Tickets + ¥5,000', stack: '50,000', prize: MAIN_PRIZE, structure: mainD1(30), notes: MAIN_NOTES, guide: ['pg-01', 'pg-02'] },
    { no: '02', day: '2026-11-12', name: 'NLH Emotional Heart', start: '18:00', regOpen: '17:30', regClose: '21:30', closeLv: 10, end: '翌04:50', entry: '¥8,000', stack: '30,000', prize: { total: '$5,615.34', itm: '17位' }, structure: S('std', m(20), [5, 11, 17]), notes: [DRINK], guide: ['pg-03'] },
    { no: '03', day: '2026-11-12', name: 'NLH Team Battle -3on3-', start: '19:00', regOpen: '18:00', regClose: '18:45', closeLv: null, end: '翌06:00', entry: '¥30,000（1チーム3名）', stack: '20,000 ×3', prize: { total: '$2,662.27', itm: '3位' }, structure: S('team', m(15), []), notes: ['3名1チーム。各ラウンドで勝ち上がった1チームが次へ進出（計3回戦）', 'ラウンドごとのスタック: 1st 20,000（100-200）／2nd 60,000（400-800）／Final 180,000（1,000-2,000）', 'REG CLOSE 18:45 はチーム受付の締切', '事前予約制（状況により当日受付あり）', 'エントリー時に別途ドリンク代3,000円'], guide: ['pg-04'] },
    { no: '04', day: '2026-11-12', name: 'NLH Elite 500', start: '20:00', regOpen: '19:30', regClose: '23:10', closeLv: 9, end: '翌04:40', entry: '¥50,000', stack: '80,000', prize: { total: '$12,032.81', itm: '7位' }, structure: S('elite', m(20), [6, 12]), notes: [DRINK], guide: ['pg-05'] },
    { no: '05', day: '2026-11-12', name: 'NLH Night Parade Sponsored by CHILLERS', start: '21:00', regOpen: '20:30', regClose: '翌00:30', closeLv: 10, end: '翌04:40', entry: '¥10,000', stack: '30,000', prize: { total: '$3,509.57', itm: '9位', extra: ['1位: CHILLERS Special Gift Set（スポンサー賞品）'] }, structure: S('np', [[1, 20], [11, 15]], [7, 13]), notes: [DRINK], guide: ['pg-06'] },
    { no: '06', day: '2026-11-12', name: 'NLH Midnight', start: '翌00:00', regOpen: '23:30', regClose: '翌02:25', closeLv: 9, end: '翌05:40', entry: '¥8,000', stack: '30,000', prize: { total: '$1,804.91', itm: '7位' }, structure: S('mid', m(15), [8]), notes: [DRINK], guide: ['pg-07'] },
    { no: '07', day: '2026-11-12', name: 'NLH Final Turbo Ⅰ', start: '翌02:00', regOpen: '翌01:30', regClose: '翌03:20', closeLv: 8, end: '翌05:20', entry: '¥7,000', stack: '50,000', prize: { total: '$1,403.83', itm: '6位' }, structure: S('ft', m(10), []), notes: [DRINK], guide: ['pg-08'] },
    // ---- 11/13(金) ----
    { no: '08', day: '2026-11-13', name: 'NLH Casualstack', start: '12:00', regOpen: '11:30', regClose: '15:30', closeLv: 10, end: '21:40', entry: '¥7,000', stack: '30,000', prize: { total: '$2,105.76', itm: '8位' }, structure: S('std', m(20), [6, 12]), notes: [DRINK], guide: ['pg-09'] },
    { no: '01', day: '2026-11-13', name: 'NLH Main Event', flight: 'Day 1B', start: '13:00', regOpen: '12:30', regClose: '18:20', closeLv: 10, end: '22:40', entry: '2 Tickets + ¥5,000', stack: '50,000', prize: MAIN_PRIZE, structure: mainD1(30), notes: MAIN_NOTES, guide: ['pg-01', 'pg-02'] },
    { no: '09', day: '2026-11-13', name: 'NLH Water Rush Sponsored by のむシリカ', start: '15:00', regOpen: '14:30', regClose: '18:30', closeLv: 10, end: '翌00:20', entry: '¥10,000', stack: '30,000', prize: { total: '$4,010.94', itm: '11位', extra: ['1位: のむシリカ 半年分（スポンサー賞品）'] }, structure: S('np', m(20), [6, 12]), notes: [DRINK, 'プレイ中はのむシリカが飲み放題'], guide: ['pg-10'] },
    { no: 'S01', day: '2026-11-13', name: 'Satellite to #10 NLH Crazy Diamond', start: '16:00', regOpen: '15:30', regClose: '17:00', closeLv: 4, end: '19:00', entry: '¥10,000', stack: '10,000', prize: { seat: '#10 NLH Crazy Diamond の参加権（120,000点で通過）', itm: 'エントリー数の1/12' }, structure: S('sat', m(15), []), notes: SAT_NOTES(12), guide: ['pg-11'] },
    { no: '10', day: '2026-11-13', name: 'NLH Crazy Diamond', start: '18:00', regOpen: '17:30', regClose: '21:55', closeLv: 9, end: '翌04:45', entry: '¥100,000', stack: '100,000', prize: { total: '$32,755.98', itm: '8位' }, structure: S('diamond', m(25), [5, 10]), notes: [DRINK], guide: ['pg-12'] },
    { no: '11', day: '2026-11-13', name: 'NLH Noctis', start: '18:00', regOpen: '17:30', regClose: '21:30', closeLv: 10, end: '翌03:40', entry: '¥15,000', stack: '50,000', prize: { total: '$3,008.20', itm: '6位' }, structure: S('std', m(20), [6, 12]), notes: [DRINK], guide: ['pg-13'] },
    { no: '12', day: '2026-11-13', name: 'NLH Melty☆Twins -Tag Team-', start: '19:00', regOpen: '18:30', regClose: '23:00', closeLv: 12, end: '翌05:20', entry: '¥20,000（2人1組）', stack: '60,000', prize: { total: '$6,517.80', itm: '9位' }, structure: S('std', m(20), []), notes: TEAM_NOTES, guide: ['pg-14'] },
    { no: '13', day: '2026-11-13', name: 'PLO Deep', start: '20:00', regOpen: '19:30', regClose: '23:30', closeLv: 10, end: '翌05:00', entry: '¥12,000', stack: '40,000', prize: { total: '$1,203.29', itm: '4位' }, structure: S('std', m(20), [6, 12], { ante: false }), notes: [DRINK], guide: ['pg-15'] },
    { no: '14', day: '2026-11-13', name: 'NLH Night Parade Sponsored by Succubus WISP × 龍幻楼', start: '21:00', regOpen: '20:30', regClose: '翌00:30', closeLv: 10, end: '翌04:40', entry: '¥10,000', stack: '30,000', prize: { total: '$2,757.52', itm: '8位', extra: ['1位: 15,000円分／2位: 8,000円分／3位: 5,000円分の店内利用券（スポンサー賞品。WISPまたは龍幻楼のいずれか1店舗で1回限り）'] }, structure: S('np', [[1, 20], [11, 15]], [7, 13]), notes: [DRINK], guide: ['pg-16'] },
    { no: '15', day: '2026-11-13', name: 'NLH Candy☆Twins -Tag Team Turbo-', start: '23:00', regOpen: '22:30', regClose: '翌02:00', closeLv: 12, end: '翌05:45', entry: '¥12,000（2人1組）', stack: '60,000', prize: { total: '$2,406.59', itm: '6位' }, structure: S('np', m(15), []), notes: TEAM_NOTES, guide: ['pg-17'] },
    { no: '16', day: '2026-11-13', name: 'NLH Midnight', start: '翌00:00', regOpen: '23:30', regClose: '翌02:25', closeLv: 9, end: '翌05:55', entry: '¥8,000', stack: '30,000', prize: { total: '$2,206.00', itm: '8位' }, structure: S('mid', m(15), [8]), notes: [DRINK], guide: ['pg-18'] },
    { no: '17', day: '2026-11-13', name: 'NLH Final Turbo Ⅱ', start: '翌02:00', regOpen: '翌01:30', regClose: '翌03:20', closeLv: 8, end: '翌05:30', entry: '¥7,000', stack: '50,000', prize: { total: '$1,579.31', itm: '7位' }, structure: S('ft', m(10), []), notes: [DRINK], guide: ['pg-19'] },
    // ---- 11/14(土) ----
    { no: '01', day: '2026-11-14', name: 'NLH Main Event', flight: 'Day 1C', start: '11:00', regOpen: '10:30', regClose: '16:20', closeLv: 10, end: '20:40', entry: '2 Tickets + ¥5,000', stack: '50,000', prize: MAIN_PRIZE, structure: mainD1(30), notes: MAIN_NOTES.concat(['終了予定はシート表記（公式トーナメントリストでは20:30）']), guide: ['pg-01', 'pg-02'] },
    { no: '18', day: '2026-11-14', name: 'NLH Megastack', start: '11:00', regOpen: '10:30', regClose: '15:30', closeLv: 10, end: '翌01:00', entry: '¥15,000', stack: '50,000', prize: { total: '$6,392.43', itm: '11位' }, structure: S('std', m(25), [4, 9, 14, 19]), notes: [DRINK], guide: ['pg-20'] },
    { no: '19', day: '2026-11-14', name: 'FL 2-7 TD & Badugi', start: '13:00', regOpen: '12:30', regClose: '16:55', closeLv: 9, end: '23:45', entry: '¥15,000', stack: '40,000', prize: { total: '$1,880.12', itm: '4位' }, structure: S('fl', m(25), [5, 10], { ante: false }), notes: ['FL 2-7 Triple Draw → FL Badugi を6ハンドごとに交互', '最大7max', DRINK], guide: ['pg-21'] },
    { no: 'S02', day: '2026-11-14', name: 'Satellite to #21 NLH Supernova', start: '14:00', regOpen: '13:30', regClose: '15:00', closeLv: 4, end: '17:00', entry: '¥10,000', stack: '10,000', prize: { seat: '#21 NLH Supernova の参加権（180,000点で通過）', itm: 'エントリー数の1/18' }, structure: S('sat', m(15), []), notes: SAT_NOTES(18), guide: ['pg-22'] },
    { no: '20', day: '2026-11-14', name: 'NLH Sugar Rush', start: '15:00', regOpen: '14:30', regClose: '18:30', closeLv: 10, end: '翌00:00', entry: '¥10,000', stack: '30,000', prize: { total: '$3,258.87', itm: '9位' }, structure: S('np', m(20), [6, 12]), notes: [DRINK], guide: ['pg-23'] },
    { no: '21', day: '2026-11-14', name: 'NLH Supernova', start: '16:00', regOpen: '15:30', regClose: '20:50', closeLv: 9, end: '翌04:40', entry: '¥150,000', stack: '200,000', prize: { total: '$45,624.42', itm: '9位' }, structure: S('supernova', m(30), [4, 8, 12, 16]), notes: ['プレイ中ドリンク飲み放題'], guide: ['pg-24'] },
    { no: '01', day: '2026-11-14', name: 'NLH Main Event', flight: 'Day 1D Turbo', start: '17:00', regOpen: '16:30', regClose: '20:30', closeLv: 10, end: '23:20', entry: '2 Tickets + ¥5,000', stack: '50,000', prize: MAIN_PRIZE, structure: mainD1(20), notes: MAIN_NOTES, guide: ['pg-01', 'pg-02'] },
    { no: '22', day: '2026-11-14', name: 'NLH Lucky Clover -Mystery Bounty-', start: '18:00', regOpen: '17:30', regClose: '21:30', closeLv: 10, end: '翌05:30', entry: '¥20,000', stack: '50,000', prize: { total: '$6,729.46', itm: '11位', extra: ['Bounty: 200,000 COIN（$1,225.57）×1／100,000 COIN（$612.78）×1／50,000 COIN（$306.39）×2／30,000 COIN（$183.83）×5／10,000 COIN（$61.28）×38'] }, structure: S('std', m(20), [6, 12, 18]), notes: ['エントリー受付終了後、残り47名になった時点でBounty Cardを1人1枚配布', '相手をシートアウトさせるとそのBountyを1枚獲得', DRINK], guide: ['pg-25'] },
    { no: '23', day: '2026-11-14', name: 'PLO Monster', start: '18:00', regOpen: '17:30', regClose: '22:30', closeLv: 10, end: '翌04:20', entry: '¥20,000', stack: '50,000', prize: { total: '$2,161.44', itm: '4位' }, structure: S('std', [[1, 25], [11, 20]], [5, 10, 16], { ante: false }), notes: [DRINK], guide: ['pg-26'] },
    { no: '24', day: '2026-11-14', name: 'NLH Elite 700', start: '21:00', regOpen: '20:30', regClose: '翌00:10', closeLv: 9, end: '翌05:40', entry: '¥70,000', stack: '80,000', prize: { total: '$16,845.93', itm: '7位' }, structure: S('elite', m(20), [6, 12]), notes: [DRINK], guide: ['pg-27'] },
    { no: '25', day: '2026-11-14', name: 'NLH Night Parade', start: '21:00', regOpen: '20:30', regClose: '翌00:30', closeLv: 10, end: '翌05:55', entry: '¥10,000', stack: '30,000', prize: { total: '$4,010.94', itm: '11位' }, structure: S('np', [[1, 20], [11, 15]], [7, 13]), notes: [DRINK], guide: ['pg-28'] },
    { no: '26', day: '2026-11-14', name: 'NLH Midnight', start: '翌00:00', regOpen: '23:30', regClose: '翌02:25', closeLv: 9, end: '翌05:25', entry: '¥8,000', stack: '30,000', prize: { total: '$2,406.56', itm: '8位' }, structure: S('mid', m(15), [8]), notes: [DRINK], guide: ['pg-29'] },
    { no: '27', day: '2026-11-14', name: 'NLH Final Turbo Ⅲ', start: '翌02:00', regOpen: '翌01:30', regClose: '翌03:20', closeLv: 8, end: '翌05:30', entry: '¥7,000', stack: '50,000', prize: { total: '$1,754.78', itm: '7位' }, structure: S('ft', m(10), []), notes: [DRINK], guide: ['pg-30'] },
    // ---- 11/15(日) ----
    { no: '28', day: '2026-11-15', name: 'NLH Noble Spade', start: '11:00', regOpen: '10:30', regClose: '14:30', closeLv: 10, end: '22:10', entry: '¥20,000', stack: '50,000', prize: { total: '$10,807.23', itm: '13位' }, structure: S('std', m(20), [6, 12, 18]), notes: [DRINK], guide: ['pg-31'] },
    { no: '01', day: '2026-11-15', name: 'NLH Main Event', flight: 'Day 2', start: '11:00', regOpen: '10:30', regClose: null, closeLv: null, end: '22:00', entry: 'Day 1通過者のみ', stack: 'Day 1の持ち越し', prize: MAIN_PRIZE, structure: S('mainD2', m(30), [22, 26, 30], { firstLevel: 19 }), notes: ['Day 2はLv.19から再開（11:00 Restart）', 'Day 2開始時に別途ドリンク代1,000円'], guide: ['pg-01', 'pg-02'] },
    { no: '29', day: '2026-11-15', name: 'FL 2-7 TD & Badugi', start: '12:00', regOpen: '11:30', regClose: '15:10', closeLv: 9, end: '20:40', entry: '¥12,000', stack: '40,000', prize: { total: '$1,504.10', itm: '4位' }, structure: S('fl', m(20), [5, 10], { ante: false }), notes: ['FL 2-7 Triple Draw → FL Badugi を6ハンドごとに交互', '最大7max', DRINK], guide: ['pg-32'] },
    { no: '30', day: '2026-11-15', name: 'NLH Elite 1000', start: '12:00', regOpen: null, regClose: '15:30', closeLv: 8, end: '21:25', entry: '¥100,000', stack: '100,000', prize: { total: '$28,076.56', itm: '7位' }, structure: S('elite1000', [[1, 25], [10, 20]], [5, 10]), notes: [DRINK], guide: ['pg-33'] },
    { no: '31', day: '2026-11-15', name: 'NLH Princess -Ladies-', start: '13:00', regOpen: '12:30', regClose: '16:10', closeLv: 9, end: '21:40', entry: '¥15,000', stack: '30,000', prize: { total: '$1,880.12', itm: '4位' }, structure: S('std', m(20), [6, 12]), notes: ['戸籍上女性の方のみ参加可（性別を確認できる本人確認書類を持参）', DRINK], guide: ['pg-34'] },
    { no: '32', day: '2026-11-15', name: 'NLH Last Parade', start: '15:00', regOpen: '14:30', regClose: '17:25', closeLv: 9, end: '21:50', entry: '¥12,000', stack: '30,000', prize: { total: '$4,512.31', itm: '9位' }, structure: S('team', m(15), [8, 16]), notes: [DRINK], guide: ['pg-35'] },
    { no: '33', day: '2026-11-15', name: 'NLH Finale', start: '17:00', regOpen: '16:30', regClose: '19:10', closeLv: 8, end: '21:30', entry: '¥5,000', stack: '20,000', prize: { total: '$1,128.07', itm: '7位' }, structure: S('mid', [[1, 15], [9, 10]], [8]), notes: [DRINK], guide: ['pg-36'] }
  ];

  // ---- トーナメント個別ページのURL(/events/spadie-fukuoka-1st/<slug>/) ----
  // ★一度公開したslugは変更しない(URLが変わると被リンク・検索評価を失う。VENUESのslugと同じ原則)。
  //   Main Event は全フライト(Day 1A〜1D・Day 2)を1ページにまとめる。
  const SLUGS = {
    '01': '01-nlh-main-event', '02': '02-nlh-emotional-heart', '03': '03-nlh-team-battle-3on3',
    '04': '04-nlh-elite-500', '05': '05-nlh-night-parade-chillers', '06': '06-nlh-midnight',
    '07': '07-nlh-final-turbo-1', '08': '08-nlh-casualstack', '09': '09-nlh-water-rush',
    'S01': 's01-satellite-to-crazy-diamond', '10': '10-nlh-crazy-diamond', '11': '11-nlh-noctis',
    '12': '12-nlh-melty-twins-tag-team', '13': '13-plo-deep', '14': '14-nlh-night-parade-wisp',
    '15': '15-nlh-candy-twins-tag-team-turbo', '16': '16-nlh-midnight', '17': '17-nlh-final-turbo-2',
    '18': '18-nlh-megastack', '19': '19-fl-27td-badugi', 'S02': 's02-satellite-to-supernova',
    '20': '20-nlh-sugar-rush', '21': '21-nlh-supernova', '22': '22-nlh-lucky-clover-mystery-bounty',
    '23': '23-plo-monster', '24': '24-nlh-elite-700', '25': '25-nlh-night-parade', '26': '26-nlh-midnight',
    '27': '27-nlh-final-turbo-3', '28': '28-nlh-noble-spade', '29': '29-fl-27td-badugi',
    '30': '30-nlh-elite-1000', '31': '31-nlh-princess-ladies', '32': '32-nlh-last-parade', '33': '33-nlh-finale'
  };
  const BASE_PATH = '/events/spadie-fukuoka-1st/';
  // 個別ページの単位(=イベント番号ごと)。並びは最初のフライトが始まる順(公式トーナメントリストの並び)。
  const events = [];
  tournaments.forEach(t => {
    let e = events.find(x => x.no === t.no);
    if (!e) {
      if (!SLUGS[t.no]) throw new Error('spadie-data.js: #' + t.no + ' の slug がありません');
      e = { no: t.no, name: t.name, slug: SLUGS[t.no], path: BASE_PATH + SLUGS[t.no] + '/', flights: [] };
      events.push(e);
    }
    e.flights.push(t);
  });

  const SPADIE = {
    id: 'spadie',
    name: 'SPADIE FUKUOKA 1st',
    venue: 'UNITEDLAB',
    address: '〒810-0041 福岡県福岡市中央区大名1-3-36',
    days: ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'],
    asOf: '2026年11月12日',
    guideUrl: 'https://spadiefukuoka.netlify.app/',
    scheduleUrl: 'https://spadiefukuoka.netlify.app/schedule/',
    guideImgBase: 'https://spadiefukuoka.netlify.app/img/guide/pg/',
    x: 'https://x.com/SPADIE_FUKUOKA',
    fxTemp: 163.19,   // 公式シートの「仮レート 163.19円/$」
    ladders: LADDERS,
    basePath: BASE_PATH,
    tournaments,
    events
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SPADIE;
  else root.SPADIE_DATA = SPADIE;
})(typeof window !== 'undefined' ? window : this);
