// FST 5.0 (FUKUOKA SUPER TOURNAMENT) メイン会場(ホテルニューオータニ博多)の全日程
// (2026年9月19日〜9月23日の5日間・全56トーナメント)。
//
// 出典(一次情報): 主催者公式Linktree(https://linktr.ee/fukuokasupertounament)に掲載されているPDF
//   「EVENT SCHEDULE 2026.09.19-23」。社長が2026-09-01にPDFの書き起こしデータを提供し、
//   当ファイルはそれをそのまま転記したもの(当方の目視・推測による書き換えはしていない)。
// 取得日: 2026-09-01 / 開発部
//
// entry フィールドの型は3種類ある(表示側は index.html の fstScheduleCards() /
// tools/gen-event-pages.js の schedTableFst() を参照。どちらも型で分岐して描画する):
//   - number … PDFのENTRY欄に金額が数値で書かれていた行。fstMoney() で「¥●●●」表示する。
//   - string … PDF側では数値・アイコン/バッジ表記で個別の金額を特定できなかったが、
//              社長が別途確認した既知の複合表記をそのまま文字列で当てた行(下記MAIN_DAY1参照)。
//              すでに「¥50,000 ／ …」のような完成した表記のため、円マーク等を二重に付けずそのまま表示する。
//   - null   … PDF・社長確認のいずれからも金額を特定できていない行。金額を推測で埋めず、
//              画面上は「PDF未記載」であることが分かる表現にする。
//
// 注1: MAIN EVENTの各Day1フライト(no:"1", flight:"MAIN_DAY1"、計5行)の entry は、
//      PDF上のENTRY欄が数値ではなくアイコン/バッジ表記だったため当初 null にしていたが、
//      社長確認(2026-09-01)により、既存の const FST.events[0].entry(index.html。MAIN EVENT概要欄)と
//      同一の「¥50,000 ／ FSTチケット2枚 ／ ¥25,000＋FSTチケット1枚」であることが判明したため、
//      この文字列を明示的に設定している(推測ではなく確認済みの値)。
// 注1': FST Championshipの各Day1フライト(no:"22", flight:"CHAMP_DAY1"、計5行)も、
//      PDF上のENTRY欄が数値ではなくアイコン/バッジ表記だったため当初 null にしていたが、
//      社長確認(2026-09-01)により、既存の const FST.events[1].entry(index.html。CHAMPIONSHIP概要欄)と
//      同一の「¥30,000 ／ FSTチケット2枚 ／ ¥20,000＋FSTチケット1枚」であることが判明したため、
//      この文字列を明示的に設定している(推測ではなく確認済みの値)。
// 注2: close が "-" の行は、PDFのCLOSE欄がダッシュ表記(レイトレジ無し/最後まで続行の意)だった行。
// 注3: series は各行のTOURNAMENT列先頭に付いていた角カッコ表記のバッジ([EC]/[F100]/[XPT])を
//      そのまま保持したもの。それぞれの正式名称・詳細は公式に未確認のため、当サイトで意味を
//      補って言い換えていない。
// 注4: MAIN EVENT(No.1)は Day1A〜E・Day2・Day3 FINAL、FST Championship(No.22)は
//      Day1A〜E・Day2 FINAL に分かれているため、同じNo.が複数の日にまたがって登場する
//      (NIPPON SERIESのMAIN EVENT #17がDay1A〜Dに分かれているのと同じ扱い。nippon-series-data.js 注1参照)。
// 注5: flight は当サイトが本数字段の同一トーナメント(MAIN EVENT / FST Championship)の
//      フライトをグルーピングするために付けた注釈用の値で、PDFに印字された表記ではない。
//
// このファイルは #fst を開いたときにだけ動的読み込みされる(index.html の loadFstScheduleData)。
const FST_SCHEDULE = {
  days: ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"],
  tournaments: [
  { day:"2026-09-19", no:"0", start:"11:00", close:"14:00", name:"FST Invitational Tournament", entry:0, series:null },
  { day:"2026-09-19", no:"2", start:"11:00", close:"15:40", name:"FSL Festival -EC100-", entry:30000, series:"EC" },
  { day:"2026-09-19", no:"1", start:"11:30", close:"17:10", name:"Main Event Day1A", entry:"¥50,000 ／ FSTチケット2枚 ／ ¥25,000＋FSTチケット1枚", series:null, flight:"MAIN_DAY1" },
  { day:"2026-09-19", no:"3", start:"12:00", close:"17:20", name:"Super Big KO Bounty", entry:20000, series:null },
  { day:"2026-09-19", no:"4", start:"14:00", close:"19:20", name:"THE WATCH -EC24-", entry:100000, series:"EC" },
  { day:"2026-09-19", no:"5", start:"16:00", close:"21:10", name:"Tag Team", entry:30000, series:null },
  { day:"2026-09-19", no:"6", start:"16:30", close:"20:50", name:"High Roller -6max-", entry:100000, series:null },
  { day:"2026-09-19", no:"1", start:"17:30", close:"21:50", name:"Main Event Day1B", entry:"¥50,000 ／ FSTチケット2枚 ／ ¥25,000＋FSTチケット1枚", series:null, flight:"MAIN_DAY1" },
  { day:"2026-09-19", no:"7", start:"17:30", close:"22:55", name:"Monster Stack", entry:25000, series:null },
  { day:"2026-09-19", no:"8", start:"20:30", close:"1:00", name:"H.O.R.S.E", entry:15000, series:null },
  { day:"2026-09-19", no:"9", start:"21:30", close:"1:50", name:"Tag Team Turbo", entry:15000, series:null },
  { day:"2026-09-19", no:"10", start:"23:00", close:"1:25", name:"Midnight Turbo", entry:15000, series:null },
  { day:"2026-09-19", no:"11", start:"1:30", close:"3:00", name:"Deepstack Hyper", entry:10000, series:null },

  { day:"2026-09-20", no:"S1", start:"10:00", close:"11:30", name:"High Roller -ZEUS- SATELLITE 1/10 3枠保証", entry:15000, series:null },
  { day:"2026-09-20", no:"12", start:"10:00", close:"12:10", name:"Warm Up", entry:10000, series:null },
  { day:"2026-09-20", no:"13", start:"11:00", close:"14:40", name:"Under 25", entry:15000, series:null },
  { day:"2026-09-20", no:"1", start:"11:30", close:"17:10", name:"Main Event Day1C", entry:"¥50,000 ／ FSTチケット2枚 ／ ¥25,000＋FSTチケット1枚", series:null, flight:"MAIN_DAY1" },
  { day:"2026-09-20", no:"14", start:"12:00", close:"16:30", name:"Deep Stack", entry:20000, series:null },
  { day:"2026-09-20", no:"1", start:"17:30", close:"21:50", name:"Main Event Day1D", entry:"¥50,000 ／ FSTチケット2枚 ／ ¥25,000＋FSTチケット1枚", series:null, flight:"MAIN_DAY1" },
  { day:"2026-09-20", no:"15", start:"16:30", close:"21:55", name:"Mystery Bounty", entry:25000, series:null },
  { day:"2026-09-20", no:"16", start:"16:30", close:"20:50", name:"High Roller -ZEUS-", entry:150000, series:null },
  { day:"2026-09-20", no:"17", start:"20:30", close:"1:00", name:"2-7TD & BADUGI", entry:15000, series:null },
  { day:"2026-09-20", no:"18", start:"22:00", close:"1:40", name:"Night Stack", entry:20000, series:null },
  { day:"2026-09-20", no:"19", start:"1:30", close:"3:00", name:"Deepstack Hyper", entry:10000, series:null },

  { day:"2026-09-21", no:"20", start:"10:00", close:"15:10", name:"FST NLH -EC100-", entry:30000, series:"EC" },
  { day:"2026-09-21", no:"1", start:"10:00", close:"12:30", name:"Main Event Day1E -After R5 Day2-", entry:"¥50,000 ／ FSTチケット2枚 ／ ¥25,000＋FSTチケット1枚", series:null, flight:"MAIN_DAY1" },
  { day:"2026-09-21", no:"21", start:"11:00", close:"16:20", name:"Classic NLH", entry:15000, series:null },
  { day:"2026-09-21", no:"1", start:"13:00", close:"-", name:"Main Event Day2", entry:3000, series:null, flight:"MAIN_DAY2" },
  { day:"2026-09-21", no:"22", start:"14:00", close:"19:40", name:"FST Championship Day1A", entry:"¥30,000 ／ FSTチケット2枚 ／ ¥20,000＋FSTチケット1枚", series:null, flight:"CHAMP_DAY1" },
  { day:"2026-09-21", no:"23", start:"16:00", close:"21:40", name:"High Roller -PRIDE-", entry:200000, series:null },
  { day:"2026-09-21", no:"24", start:"16:30", close:"21:55", name:"6max NLH", entry:25000, series:null },
  { day:"2026-09-21", no:"22", start:"20:00", close:"23:40", name:"FST Championship Day1B", entry:"¥30,000 ／ FSTチケット2枚 ／ ¥20,000＋FSTチケット1枚", series:null, flight:"CHAMP_DAY1" },
  { day:"2026-09-21", no:"25", start:"20:30", close:"1:00", name:"5PLO", entry:15000, series:null },
  { day:"2026-09-21", no:"26", start:"22:00", close:"1:40", name:"Night Stack", entry:20000, series:null },
  { day:"2026-09-21", no:"27", start:"1:30", close:"3:00", name:"Deepstack Hyper", entry:10000, series:null },

  { day:"2026-09-22", no:"28", start:"10:00", close:"14:30", name:"Road to Heads-up 550 -EC80-", entry:55000, series:"EC" },
  { day:"2026-09-22", no:"29", start:"10:30", close:"15:50", name:"FST Field of 100", entry:20000, series:"F100" },
  { day:"2026-09-22", no:"22", start:"11:30", close:"17:10", name:"FST Championship Day1C", entry:"¥30,000 ／ FSTチケット2枚 ／ ¥20,000＋FSTチケット1枚", series:null, flight:"CHAMP_DAY1" },
  { day:"2026-09-22", no:"30", start:"12:00", close:"17:20", name:"XPT×FST", entry:15000, series:"XPT" },
  { day:"2026-09-22", no:"31", start:"13:00", close:"18:20", name:"LADIES Championship", entry:20000, series:null },
  { day:"2026-09-22", no:"32", start:"14:00", close:"18:20", name:"High Roller -POSEIDON-", entry:100000, series:null },
  { day:"2026-09-22", no:"1", start:"16:00", close:"-", name:"Main Event Day3 FINAL", entry:0, series:null, flight:"MAIN_FINAL" },
  { day:"2026-09-22", no:"22", start:"17:30", close:"21:50", name:"FST Championship Day1D", entry:"¥30,000 ／ FSTチケット2枚 ／ ¥20,000＋FSTチケット1枚", series:null, flight:"CHAMP_DAY1" },
  { day:"2026-09-22", no:"33", start:"17:30", close:"22:55", name:"KO Bounty", entry:25000, series:null },
  { day:"2026-09-22", no:"34", start:"20:30", close:"1:00", name:"NL 2-7SD", entry:15000, series:null },
  { day:"2026-09-22", no:"35", start:"23:00", close:"1:10", name:"Midnight Turbo", entry:15000, series:null },
  { day:"2026-09-22", no:"36", start:"1:00", close:"2:30", name:"Deepstack Hyper", entry:10000, series:null },

  { day:"2026-09-23", no:"22", start:"10:00", close:"11:40", name:"FST Championship Day1E -After R5 Day2-", entry:"¥30,000 ／ FSTチケット2枚 ／ ¥20,000＋FSTチケット1枚", series:null, flight:"CHAMP_DAY1" },
  { day:"2026-09-23", no:"37", start:"10:00", close:"12:10", name:"FST Final Day Kickoff", entry:10000, series:null },
  { day:"2026-09-23", no:"38", start:"12:00", close:"16:30", name:"PLO", entry:15000, series:null },
  { day:"2026-09-23", no:"22", start:"12:00", close:"-", name:"FST Championship Day2 FINAL", entry:3000, series:null, flight:"CHAMP_DAY2" },
  { day:"2026-09-23", no:"39", start:"12:00", close:"17:25", name:"Mini Main", entry:30000, series:null },
  { day:"2026-09-23", no:"40", start:"13:00", close:"17:20", name:"High Roller 1100 -EC100-", entry:110000, series:"EC" },
  { day:"2026-09-23", no:"41", start:"17:00", close:"19:50", name:"Freeze Out", entry:25000, series:null },
  { day:"2026-09-23", no:"42", start:"17:30", close:"20:10", name:"The Closer", entry:15000, series:null },
  { day:"2026-09-23", no:"43", start:"20:00", close:"21:50", name:"XPT AOF", entry:5000, series:"XPT" }
  ]
};

// トップレベルの const は window に載らないため、明示的に公開する。
if (typeof window !== 'undefined') { window.FST_SCHEDULE_DATA = FST_SCHEDULE; }
if (typeof module !== 'undefined' && module.exports) { module.exports = FST_SCHEDULE; }
