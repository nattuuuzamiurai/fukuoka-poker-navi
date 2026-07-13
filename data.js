/* ============================================================
 * data.js — 福岡ポーカートーナメント・アグリゲーター データ層
 *
 * VENUES: 実在調査に基づく福岡県内アミューズメントポーカー店（出典は
 *         fukuoka-venues.json を参照）。公開前に各店舗の公式情報で
 *         住所・SNS・営業状況を再確認すること。
 * TOURNAMENTS: 実際の開催日程は各店のSNS/公式LINEの告知を admin.html で
 *         取り込んで登録する（貼付→LLM整形）。実在店に対する架空の日程は
 *         載せないため、初期は空。
 *
 * ---- スキーマ ----------------------------------------------
 * Venue {
 *   id, name, area, address, access,
 *   x(twitter), line, instagram, website, tel,
 *   featured(boolean),  // PR/有料掲載枠（店舗との合意がある場合のみtrue）
 *   note,
 *   sourceLabel, sourceUrl  // 管理コンソール用: 月間スケジュールをどこから取得するか
 *                           // （例: sourceLabel:'公式LINE', sourceUrl:'https://...'）。
 *                           // 未確認の店舗は空文字のままでよい（admin.htmlから随時追記）。
 * }
 * Tournament {
 *   id, venueId, name,
 *   date('YYYY-MM-DD'), start('HH:MM'),
 *   buyin(円), addon(円|null), stack(点),
 *   guarantee(円|null), reentry(boolean|'late'),
 *   prize(文字列|null), tags([]),
 *   source('auto'|'semi'|'manual'), verified(boolean)
 * }
 * ------------------------------------------------------------ */

const VENUES = [
  { id: 'v1',  name: 'じゃんけんポーカー福岡天神店',                 area: '天神',   address: '福岡市中央区天神3-1-12 北天神ビル4F',        access: '西鉄福岡（天神）駅 徒歩4分',   x: 'https://x.com/jyanken_tenjin',   line: '', instagram: 'https://www.instagram.com/jyanken.fukuoka/', website: '',                                 tel: '092-401-1467', featured: false, note: '移転中の情報あり・要確認', sourceLabel: '', sourceUrl: '' },
  { id: 'v2',  name: 'KKPOKER FUKUOKA',                            area: '天神',   address: '福岡市中央区春吉3-21-19 ARBRE天神4F',        access: '天神南駅 徒歩3分',             x: 'https://x.com/kkpoker_fukuoka',  line: '', instagram: 'https://www.instagram.com/kkpoker_fukuoka/', website: '',                               tel: '',             featured: false, note: 'KKPOKER系・6卓RFID', sourceLabel: '', sourceUrl: '' },
  { id: 'v3',  name: "m HOLD'EM 中洲",                             area: '中洲',   address: '福岡市博多区中洲3-7-24 ゲイツビル3F',        access: '中洲川端駅4番出口直結',        x: 'https://x.com/m_holdem_nakasu',  line: '', instagram: '',                                          website: 'https://mpj-portal.jp/official/nakasu/', tel: '',    featured: false, note: 'サミー系・2025/6開店', sourceLabel: '', sourceUrl: '' },
  { id: 'v4',  name: 'ONECASINO 福岡中洲',                         area: '中洲',   address: '福岡市博多区中洲4-7-7 中洲リッチビル2F',     access: '中洲川端駅 徒歩2分',           x: 'https://x.com/onecasino477',     line: '', instagram: 'https://www.instagram.com/onecasino_fuk/',    website: 'https://one-casino.jp/',          tel: '092-292-9917', featured: false, note: '木曜フリーロールあり', sourceLabel: '', sourceUrl: '' },
  { id: 'v5',  name: 'Casino bar Leje 博多店',                     area: '中洲',   address: '福岡市博多区中洲3-7-10 若松ビル4F',          access: '中洲川端駅 徒歩2分',           x: '',                               line: '', instagram: '',                                          website: 'https://www.lejehakata.com/',     tel: '092-291-9200', featured: false, note: '入場1,000円飲み放題', sourceLabel: '', sourceUrl: '' },
  { id: 'v6',  name: 'グランドミラージュポーカー',                 area: '天神',   address: '福岡市中央区今泉1-17-16',                    access: '西鉄福岡（天神）駅 徒歩4分',   x: 'https://x.com/poker_mirage',     line: '', instagram: '',                                          website: '',                                 tel: '',             featured: false, note: 'テキサスホールデム専門', sourceLabel: '', sourceUrl: '' },
  { id: 'v7',  name: 'ポーカーハウスFUXK 福岡天神店',              area: '天神',   address: '福岡市中央区春吉3-21-18 2F',                access: '天神南駅 徒歩5分',             x: 'https://x.com/poker_fuxk',       line: '', instagram: 'https://www.instagram.com/poker_fuxk/',       website: '',                                 tel: '',             featured: false, note: '無料初心者講習あり', sourceLabel: '', sourceUrl: '' },
  { id: 'v8',  name: 'RAISE BLUE 天神ポーカーハウス',              area: '天神',   address: '',                                          access: '天神駅 徒歩約10分',           x: 'https://x.com/RAISEBLUE_poker',  line: '', instagram: 'https://www.instagram.com/raise_blue/',       website: '',                                 tel: '',             featured: false, note: '営業状況要確認・住所未確認', sourceLabel: '', sourceUrl: '' },
  { id: 'v9',  name: 'CASINO BLOW 西中洲',                         area: '中洲',   address: '福岡市中央区西中洲1-21 GIOビル2F',           access: '中洲川端駅 徒歩5分',           x: '',                               line: '', instagram: 'https://www.instagram.com/casino_nishinakasu/', website: 'https://blow-casino.com/shop/detail.html?id=251', tel: '092-733-8899', featured: false, note: 'カジノバー・トーナメント要確認', sourceLabel: '', sourceUrl: '' },
  { id: 'v10', name: 'POKER BAR U',                                area: '天神',   address: '福岡市中央区渡辺通（番地要確認）',           access: '天神南駅 徒歩1分',             x: '',                               line: '', instagram: '',                                          website: '',                                 tel: '070-9075-2740', featured: false, note: 'バー寄り・開催有無要確認', sourceLabel: '', sourceUrl: '' },
  { id: 'v11', name: 'ゲームバー SAVE 天神店',                     area: '天神',   address: '福岡市中央区天神3-6-16 クレール8F',          access: '天神駅 徒歩5分',               x: '',                               line: '', instagram: '',                                          website: 'https://fbfg900.gorp.jp/',        tel: '050-5487-0779', featured: false, note: '総合ゲームバー・専門会場ではない', sourceLabel: '', sourceUrl: '' },
  { id: 'v12', name: 'CASINO Bar ACES 久留米',                     area: '久留米', address: '久留米市日吉町12-63',                        access: 'JR/西鉄久留米駅の中間繁華街',  x: 'https://x.com/casino_aces_',     line: '', instagram: 'https://www.instagram.com/aces_a_group/',     website: '',                                 tel: '',             featured: false, note: 'トーナメント開催要確認', sourceLabel: '', sourceUrl: '' },
  { id: 'v13', name: 'アミューズメントPokerBar NUWLAND',           area: '北九州', address: '北九州市小倉北区京町2-4-27 ロックビル3F',    access: '小倉駅 徒歩2分',               x: '',                               line: '', instagram: '',                                          website: 'https://nuwland.com/',            tel: '',             featured: false, note: 'NLH中心・毎日開催', sourceLabel: '', sourceUrl: '' },
  { id: 'v14', name: 'TripleBarrel 小倉店',                        area: '北九州', address: '北九州市小倉北区鍛治町1-7-4 鍛治町会館3F',   access: 'JR小倉駅 徒歩約4分',           x: 'https://x.com/triplebarrel2',    line: '', instagram: 'https://www.instagram.com/triplebarrel_kokura/', website: 'https://triplebarrel.jimdofree.com/', tel: '080-9109-4036', featured: false, note: '『オルカ』主催トーナメント毎日', sourceLabel: '', sourceUrl: '' },
  { id: 'v15', name: 'KAJI BAR（カジバー）',                       area: '北九州', address: '北九州市小倉北区鍛治町1-5-11 第18エルザビル4F', access: 'モノレール平和通駅 徒歩約3分', x: '',                               line: '', instagram: '',                                          website: 'https://kajibarkokura.owst.jp/',  tel: '093-521-9876', featured: false, note: 'サテライトトーナメントあり', sourceLabel: '', sourceUrl: '' },
  { id: 'v16', name: 'てきさすほーるでむ。',                       area: '北九州', address: '北九州市小倉南区北方2-24-1',                 access: '小倉競馬場前 徒歩1分',         x: 'https://x.com/texasholdem3000',  line: '', instagram: 'https://www.instagram.com/texasholdem3000/',   website: 'https://texaspoker.pro/',         tel: '080-6340-3000', featured: false, note: 'リング/トーナメント両方', sourceLabel: '', sourceUrl: '' },
  { id: 'v17', name: 'テキサスホールデムAA',                       area: '北九州', address: '北九州市小倉北区片野新町1-10-23 3F',         access: '',                             x: 'https://x.com/texasaanet',       line: '', instagram: '',                                          website: 'https://texasaa.net/',            tel: '',             featured: false, note: '1部13:15/2部17:30・入場2,000円', sourceLabel: '', sourceUrl: '' },
  { id: 'v18', name: 'Poker Bar IRIS',                             area: '北九州', address: '北九州市八幡西区黒崎2-6-3 2F',               access: 'JR黒崎駅周辺',                 x: 'https://x.com/pokerbar_iris',    line: '', instagram: '',                                          website: '',                                 tel: '',             featured: false, note: 'FST会場・トーナメント実績あり', sourceLabel: '', sourceUrl: '' },
  { id: 'v19', name: 'CASINO Arrows 小倉店',                       area: '北九州', address: '北九州市小倉北区堺町1-9-20 ナカノビル3F',    access: 'モノレール平和通駅 徒歩5分',   x: 'https://x.com/CASINO_Arrows',    line: '', instagram: 'https://www.instagram.com/casino_arrows2025/', website: '',                                 tel: '',             featured: false, note: '2025/8開店・トーナメント要確認', sourceLabel: '', sourceUrl: '' },
  { id: 'v20', name: 'KING&QUEEN SUITED 直方店',                   area: '筑豊',   address: '',                                          access: '直方市（住所未確認）',         x: 'https://x.com/king_queen1312',   line: '', instagram: 'https://www.instagram.com/king2485queen/',     website: '',                                 tel: '080-7987-1213', featured: false, note: 'ハウス+大型サテライト・黒崎に系列店', sourceLabel: '', sourceUrl: '' },
  { id: 'v21', name: 'KENポーカー（久留米）',                        area: '久留米', address: '福岡県久留米市東町34-71',                    access: '西鉄久留米駅 徒歩5分',         x: '',                               line: '', instagram: 'https://www.instagram.com/kurume_ken_poker/', website: '',                                 tel: '080-3904-2698', featured: false, note: '営業18:00-24:00・初心者講習あり。JOPT/WJPT・MASAKICHI SUPER LEAGUE系。卓状況はオープンチャットで更新中。住所/電話はポーカー店ディレクトリ情報のため要確認。', sourceLabel: '', sourceUrl: '' },
];

// 実開催データ。憲法家（v21）の2026年7月予定表（ユーザー提供の画像）から取り込み。
// source:'semi'（告知取り込み） / verified:false（未確認）。
const TOURNAMENTS = [
  { id:'k0701', venueId:'v21', name:'SUPER CHAMPIONSHIP FUKUOKA サテライト', date:'2026-07-01', start:'19:30', buyin:3500, addon:null, stack:30000, guarantee:null, reentry:true, prize:null,                 tags:['サテライト','WJPT'],            source:'semi', verified:false },
  { id:'k0702', venueId:'v21', name:'SUPER CHAMPIONSHIP FUKUOKA サテライト', date:'2026-07-02', start:'19:30', buyin:3500, addon:null, stack:30000, guarantee:null, reentry:true, prize:null,                 tags:['サテライト','WJPT'],            source:'semi', verified:false },
  { id:'k0703', venueId:'v21', name:'SUPER CHAMPIONSHIP FUKUOKA サテライト', date:'2026-07-03', start:'19:30', buyin:3500, addon:null, stack:30000, guarantee:null, reentry:true, prize:null,                 tags:['サテライト','WJPT'],            source:'semi', verified:false },
  { id:'k0704', venueId:'v21', name:'SUPER CHAMPIONSHIP FUKUOKA 店舗DAY1',  date:'2026-07-04', start:'18:30', buyin:15000, addon:null, stack:50000, guarantee:null, reentry:true, prize:null,                 tags:['店舗DAY1','大型'],              source:'semi', verified:false },
  { id:'k0705', venueId:'v21', name:'WJPT 店舗DAY1（賞金プール10万OVER）',   date:'2026-07-05', start:'',      buyin:0,    addon:null, stack:0,     guarantee:null, reentry:false, prize:'TOTAL PRIZE POOL 100,000 OVER', tags:['店舗DAY1','大型','WJPT'],   source:'semi', verified:false },
  { id:'k0706', venueId:'v21', name:'SUPER CHAMPIONSHIP FUKUOKA サテライト', date:'2026-07-06', start:'19:30', buyin:3500, addon:null, stack:30000, guarantee:null, reentry:true, prize:null,                 tags:['サテライト','WJPT','バウンティ'], source:'semi', verified:false },
  { id:'k0707', venueId:'v21', name:'SUPER CHAMPIONSHIP FUKUOKA サテライト', date:'2026-07-07', start:'19:30', buyin:3500, addon:null, stack:30000, guarantee:null, reentry:true, prize:null,                 tags:['サテライト','WJPT'],            source:'semi', verified:false },
  { id:'k0708', venueId:'v21', name:'FURURU BIRTHDAY CUP（NLH×AoF-8Mix）',   date:'2026-07-08', start:'20:00', buyin:3000, addon:null, stack:30000, guarantee:null, reentry:true, prize:'オリジナルグッズ',   tags:['ミックス'],                     source:'semi', verified:false },
  { id:'k0709', venueId:'v21', name:'SUPER CHAMPIONSHIP FUKUOKA 店舗DAY1',  date:'2026-07-09', start:'18:30', buyin:15000, addon:null, stack:50000, guarantee:null, reentry:true, prize:null,                 tags:['店舗DAY1','大型'],              source:'semi', verified:false },
  { id:'k0710', venueId:'v21', name:'FST FUKUOKA SUPER サテライト',          date:'2026-07-10', start:'19:30', buyin:3500, addon:null, stack:30000, guarantee:null, reentry:true, prize:null,                 tags:['サテライト','FST'],             source:'semi', verified:false },
  { id:'k0711', venueId:'v21', name:'てんやわんや 10.8 CUP',                 date:'2026-07-11', start:'19:30', buyin:4000, addon:null, stack:40000, guarantee:null, reentry:true, prize:null,                 tags:['大型','フリーロール特典'],      source:'semi', verified:false },
  { id:'k0712', venueId:'v21', name:'会員1000名突破記念 1000円トーナメント',  date:'2026-07-12', start:'18:00', buyin:1000, addon:null, stack:15000, guarantee:null, reentry:true, prize:null,                 tags:['記念'],                         source:'semi', verified:false },
  { id:'k0713', venueId:'v21', name:'FST FUKUOKA SUPER（PLOでサテライト）',   date:'2026-07-13', start:'19:30', buyin:3500, addon:null, stack:30000, guarantee:null, reentry:true, prize:null,                 tags:['サテライト','PLO','バウンティ'], source:'semi', verified:false },
  { id:'k0714', venueId:'v21', name:'モツ焼き横丁 CUP',                       date:'2026-07-14', start:'19:30', buyin:4000, addon:null, stack:40000, guarantee:null, reentry:true, prize:null,                 tags:['大型'],                         source:'semi', verified:false },
  { id:'k0715', venueId:'v21', name:'FST FUKUOKA SUPER サテライト',          date:'2026-07-15', start:'19:30', buyin:3500, addon:null, stack:30000, guarantee:null, reentry:true, prize:null,                 tags:['サテライト','WJPT','FST'],      source:'semi', verified:false },
  { id:'k0716', venueId:'v21', name:'FST FUKUOKA SUPER サテライト',          date:'2026-07-16', start:'19:30', buyin:3500, addon:null, stack:30000, guarantee:null, reentry:true, prize:null,                 tags:['サテライト','WJPT','FST'],      source:'semi', verified:false },
  { id:'k0717', venueId:'v21', name:'FST FUKUOKA SUPER サテライト',          date:'2026-07-17', start:'19:30', buyin:3500, addon:null, stack:30000, guarantee:null, reentry:true, prize:null,                 tags:['サテライト','WJPT','FST'],      source:'semi', verified:false },
  { id:'k0718', venueId:'v21', name:'BLIND RING（※別紙）',                    date:'2026-07-18', start:'',      buyin:0,    addon:null, stack:0,     guarantee:null, reentry:false, prize:null,                 tags:['リング'],                       source:'semi', verified:false },
  { id:'k0719', venueId:'v21', name:'BLIND RING（※別紙）',                    date:'2026-07-19', start:'',      buyin:0,    addon:null, stack:0,     guarantee:null, reentry:false, prize:null,                 tags:['リング'],                       source:'semi', verified:false },
  { id:'k0720', venueId:'v21', name:'ポルCUP（海の日）',                      date:'2026-07-20', start:'15:30', buyin:0,    addon:null, stack:0,     guarantee:null, reentry:false, prize:null,                 tags:['バウンティ'],                   source:'semi', verified:false },
  { id:'k0721', venueId:'v21', name:'MASAKICHI SUPER LEAGUE（MSL）',          date:'2026-07-21', start:'',      buyin:0,    addon:null, stack:0,     guarantee:null, reentry:false, prize:null,                 tags:['リーグ'],                       source:'semi', verified:false },
  { id:'k0722', venueId:'v21', name:'MASAKICHI SUPER LEAGUE（MSL）',          date:'2026-07-22', start:'',      buyin:0,    addon:null, stack:0,     guarantee:null, reentry:false, prize:null,                 tags:['リーグ'],                       source:'semi', verified:false },
  { id:'k0723', venueId:'v21', name:'MSL+T',                                  date:'2026-07-23', start:'',      buyin:0,    addon:null, stack:0,     guarantee:null, reentry:false, prize:null,                 tags:['リーグ'],                       source:'semi', verified:false },
  { id:'k0724', venueId:'v21', name:'MSL+T',                                  date:'2026-07-24', start:'',      buyin:0,    addon:null, stack:0,     guarantee:null, reentry:false, prize:null,                 tags:['リーグ'],                       source:'semi', verified:false },
  { id:'k0725', venueId:'v21', name:'イベント（別紙参照）',                    date:'2026-07-25', start:'',      buyin:0,    addon:null, stack:0,     guarantee:null, reentry:false, prize:null,                 tags:[],                               source:'semi', verified:false },
  { id:'k0726', venueId:'v21', name:'MSL 決勝（MASAKICHI SUPER LEAGUE）',      date:'2026-07-26', start:'',      buyin:0,    addon:null, stack:0,     guarantee:null, reentry:false, prize:null,                 tags:['リーグ','決勝'],                source:'semi', verified:false },
  { id:'k0727', venueId:'v21', name:'PLO勉強会',                              date:'2026-07-27', start:'20:00', buyin:2000, addon:null, stack:0,     guarantee:null, reentry:false, prize:null,                 tags:['PLO','勉強会'],                 source:'semi', verified:false },
  { id:'k0728', venueId:'v21', name:'FST FUKUOKA SUPER TOURNAMENT（PLOでサテライト）', date:'2026-07-28', start:'19:30', buyin:3500, addon:null, stack:30000, guarantee:null, reentry:true, prize:null,         tags:['サテライト','PLO','FST'],       source:'semi', verified:false },
  { id:'k0729', venueId:'v21', name:'FST FUKUOKA SUPER TOURNAMENT サテライト', date:'2026-07-29', start:'19:30', buyin:3500, addon:null, stack:30000, guarantee:null, reentry:true, prize:null,                 tags:['サテライト','FST'],             source:'semi', verified:false },
  { id:'k0730', venueId:'v21', name:'FST FUKUOKA SUPER TOURNAMENT サテライト', date:'2026-07-30', start:'19:30', buyin:3500, addon:null, stack:30000, guarantee:null, reentry:true, prize:null,                 tags:['サテライト','FST'],             source:'semi', verified:false },
  { id:'k0731', venueId:'v21', name:'ルーキーズ CUP',                         date:'2026-07-31', start:'19:30', buyin:2000, addon:null, stack:20000, guarantee:null, reentry:true, prize:null,                 tags:['初心者'],                       source:'semi', verified:false },
];

// area の表示順（フィルタUI用）
const AREAS = ['天神', '中洲', '北九州', '筑豊', '久留米'];

if (typeof module !== 'undefined') { module.exports = { VENUES, TOURNAMENTS, AREAS }; }
