'use strict';
/**
 * venue-listing-rules.js — 【店ごとの掲載ルール】
 *
 * この案件のこれまでの判定(`isClosureRow` / `isHeadingRow` / `isNonTournamentFormat`)は
 * 「行そのものの性質」を見ていた。定休日のマスはどの店でも定休日で、リングゲームは
 * どの店でもトーナメントではない。**店を知らなくても判定できる**。
 *
 * ここに置くのはそれとは種類が違う規則で、**その店の実態を人が知っていないと決められない**。
 * 2026-08-05、試験実行(run `30973996821`・dry-run・書き込み0)の結果42件を見た社長から
 * 出た3件の指示がその第1号である。
 *
 * ============================================================
 * 【この規則が守っているもの】= 利用者が誤った行動をとらないこと
 * ============================================================
 * この案件で一貫して最も重い実害は「**利用者が誤った行動をとる**」ことで、これまでも
 *   ・読み取れなかった開始時刻を `00:00` で埋めない(= 深夜0時に店へ行かせない)
 *   ・名前由来かもしれない参加費に ⚠ を付ける(= 持っていく金額を間違えさせない)
 * という形で同じ系統の判断を積んできた。**下の3件はいずれもその系統**である。
 * 掲載を1件増やす利益より、**間違った情報で利用者を動かす損失の方が大きい**、という
 * 一貫した重みづけの下でだけ、この規則は正当化される。
 *
 * ============================================================
 * 【★語による除外は「対象店だけ」に効かせる★】
 * ============================================================
 * `NON_TOURNAMENT_FORMATS`(リングゲーム/キャッシュゲーム)が全店に部分一致してよいのは、
 * 語が長く具体的で、他店の大会名と衝突しないからだった。**ここの語はそうではない**。
 *
 * 実測(2026-08-05・`data.js` の634行・相異なる大会名275通り):
 *   `大還元` … **他店に3通り6行ある** — `大還元フリロ`(v18) / `月末大還元`(v18) /
 *              `RGS大還元祭（参加条件はX/オープンチャットを要確認）`(v37)。
 *              **v18 は Instagram監視の対象6店に入っている**ので、全店に効かせると
 *              **自動経路が毎月 v18 の正当な大会を静かに落とす**。
 *   `華金`   … 現時点の `data.js` には0件。ただし「花金(金曜日)」の一般名詞なので
 *              他店に現れうる。実際 `tools/monitor-instagram-apify.test.js` は
 *              `華金` を**正当な大会名の代表例**として使っている。
 *
 * したがって **venueId で必ず絞る**。全店適用に変える改修は、上の実測をやり直してからにすること。
 * この非対称(語の判定は漏らす側に倒す)は `isClosureRow` の設計と同じ理由に立っている —
 * **過剰除外は内容が完全に失われ `lastPostedAt` も前進するので再試行されない**が、
 * 除外し漏れた行は内容が残るので⑤(人による全件照合)が拾える。
 *
 * ============================================================
 * 【★根拠の強さを規則ごとに書き分ける(`basis`)★】
 * ============================================================
 * 社長の言葉は3件それぞれ強さが違う。**同じ「除外」でも、確定した事実に基づくものと
 * 推定に基づくものを同じ顔で並べない**。将来この店の実態が分かったときに、
 * どれを見直すべきかがここだけで判断できる必要がある。
 */

/**
 * 名前の正規化(全角→半角・小文字化・区切りの揺れ吸収)。
 *
 * 【★ここが唯一の定義★】`tools/monitor-instagram-apify.js` は同名の関数をここから
 * `require` して再輸出している(二重に書くと必ず片方が古くなる)。
 * 名前を見る判定(`isClosureRow` / `isHeadingRow` / `isNonTournamentFormat` /
 * `nameContainsMoneyToken` / 下の `excludedByListingRule`)はすべてこれを通る。
 */
function normalizeName(name) {
  return String(name == null ? '' : name)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[・/\-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 【規則1】参加費を一切記録しない店。
 *
 * 社長の指示(2026-08-05):
 *   「**A&K は参加費が店内通過価格で書いてあるのでわかりづらいので、全部参加費は書かなくていいです。**」
 *
 * 【なぜ「無料(0)」も消すのか】試験実行 run `30973996821` の v35 27行のうち11行に参加費が付き、
 * 内訳は **無料(0) 7行(FREE ROLL 系) / 金額あり 4行(¥400 / ¥600 / ¥300 / ¥400)**だった。
 * `0` は「**0円で参加できる**」という円建ての主張であり、この店のカレンダーの数字が
 * 円と対応していない以上、**その主張の裏付けが無い**。金額ありの4件だけ消して0を残すと、
 * 「金額は分からないが無料であることは分かっている」という**実際には持っていない知識**を
 * 表明することになる。**社長にも「無料の0円も含めて全部消す」で確認済み**。
 *
 * 【★表示がどう変わるかを正確に書いておく(過大にも過小にも言わない)★】
 * サイトの参加費表示は `index.html` と `tools/venue-schedule.js` の `vpBuyin` がどちらも
 * `if (t.buyin)` で分岐しており、**`0` は falsy なので `null` と同じ扱い**になる。したがって:
 *   ・無料(0)の行 … 表示は**変わらない**(元から `フリーロール` か `詳細は店舗SNSを確認`)。
 *     変わるのは【データの意味】と【⚠が付かなくなること】
 *   ・金額ありの行 … `¥400` → `詳細は店舗SNSを確認` に**変わる**(ここが実際の是正)
 * 「表示から金額が消える」と一言で書くと前者について事実と違うので、分けて書くこと。
 *
 * 【★「金額に類する表示が一切出なくなる」わけではない★】タグに `フリーロール` が付いた行は
 * 参加費欄に `フリーロール` と出る。このタグは**大会名(例: `FREE ROLL`)から来ており**、
 * 大会名は社長の指示どおりそのまま載せる。参加費(円)の主張ではないので触っていない。
 *
 * 【この規則が及ばない範囲】
 *   ・`addon` / `stack` / `guarantee` は対象外(社長の指示は参加費)。
 *     ★参考として、いま `data.js` にある v35 の34行では `addon` は1件も入っていない
 *       (2026-08-05 に実データを数えた)。**試験実行の結果については addon を数えていない**ので、
 *       「Vision は v35 の addon を返さない」とは言えない。ここを広げるなら改めて指示を仰ぐこと
 *   ・**人が admin.html で入れた参加費は上書きしない**。機械が書いた値の控え
 *     (`tools/machine-write-state.js`)との突き合わせで「人が直した項目」は復元されるため、
 *     この規則が消すのは**機械が書こうとした値だけ**である
 */
const BUYIN_NOT_RECORDED = [
  {
    venueId: 'v35',
    label: 'A&K',
    basis: '店の掲載様式(社長が実物を確認)',
    instructedAt: '2026-08-05',
    reason:
      'この店のカレンダーの金額は【店内通過価格(チップ等)】で書かれており、円と対応しない。' +
      '数値をそのまま円として載せると【利用者が持っていく金額を誤る】。' +
      'この案件で最も重い実害は一貫して「利用者が誤った行動をとること」で、これはその系統。' +
      '0(無料)も「0円で参加できる」という円建ての主張なので同じ理由で記録しない。',
  },
];

/**
 * 【規則2・3】大会名に特定の語を含む行を、その店に限って除外する。
 *
 * ★`term` は `normalizeName` を通したうえでの**部分一致**。
 *   `大還元` は `チップ大還元` `スーパー大還元` の両方に当たる(社長に確認済み)。
 *   `華金` は `華金トナメ` のような複合にも当たる。
 * ★逆に `チップ大・還元` のように語の内側に区切りが入ると当たらない(`normalizeName` が
 *   `・` を空白にするため)。**当たらない側=行が残る側**なので⑤で拾える。ここも
 *   「漏らす側に倒す」に沿っている。
 */
const NAME_EXCLUSIONS = [
  {
    venueId: 'v40',
    label: 'TripleBarrel 折尾店',
    term: '大還元',
    // 【★これは推定である。確定した事実ではない★】
    basis: '社長の推定(「おそらく」)',
    instructedAt: '2026-08-05',
    reason:
      '社長の言葉は「折尾のチップ大還元は【おそらく】リングの話なのでこれは無視で」。' +
      '推定であって確認された事実ではない。リングゲームなら大会ではないので載せない方が正しく、' +
      '仮に大会だったとしても内容が分からないまま載せると利用者が誤った前提で来店する。' +
      '★実態が判明したら、この行を消して規則を撤回できる(除外した行は毎回ログに件数が出る)。',
    // 試験実行 run `30973996821` で該当した行(2026-08分・計8行)。
    // ★これは「この規則が何に当たったか」の記録であって、テストの期待値ではない
    //   (実データの件数をテストに書かない、という README の規律に従う)。
    observed: {
      run: '30973996821',
      rows: ['チップ大還元 ×7 (8/6, 8/10, 8/14, 8/17, 8/23, 8/28, 8/31)', 'スーパー大還元 ×1 (8/16)'],
    },
  },
  {
    venueId: 'v20',
    label: 'KING&QUEEN SUITED 直方店',
    term: '華金',
    // 【★「分からない」が理由。除外できる根拠を持っているわけではない★】
    basis: '内容が不明(社長が把握できていない)',
    instructedAt: '2026-08-05',
    reason:
      '社長の言葉は「直方の華金は【なにかわからない】ので無視で」。' +
      '大会ではないと分かったのではなく、何なのかが分からない。' +
      '内容の分からない開催を日程として載せると、利用者は「大会がある」という前提で来店する。' +
      '★将来この店の実態が分かったら戻せるように、除外の理由を「不明」のまま残してある。',
    observed: {
      run: '30973996821',
      rows: ['華金 ×3 (8/7, 8/21, 8/28)'],
    },
  },
];

/**
 * その店が「参加費を記録しない」対象か。対象なら規則を、そうでなければ null を返す。
 * @param {string} venueId
 * @returns {object|null}
 */
function buyinNotRecorded(venueId) {
  if (!venueId) return null;
  return BUYIN_NOT_RECORDED.find((r) => r.venueId === venueId) || null;
}

/**
 * その店で、その大会名が掲載ルールにより除外されるか。除外されるなら規則を返す。
 *
 * 【★venueId を必ず見る★】語だけで判定に変えないこと(ファイル冒頭の実測)。
 * @param {string} venueId
 * @param {string} name
 * @returns {object|null}
 */
function excludedByListingRule(venueId, name) {
  if (!venueId) return null;
  const key = normalizeName(name);
  if (!key) return null;
  return NAME_EXCLUSIONS.find((r) => r.venueId === venueId && key.includes(normalizeName(r.term))) || null;
}

/** 除外の理由を、破棄ログにそのまま出せる1行の文にする。 */
function exclusionReasonText(rule) {
  return (
    `店ごとの掲載ルールで除外(${rule.label} / 「${rule.term}」を含む行 / 根拠: ${rule.basis} / ` +
    `${rule.instructedAt} 社長指示)`
  );
}

/**
 * 【事後条件】機械が書こうとしているエントリ群が、掲載ルールに違反していないか。
 *
 * 【なぜ「規則を適用する場所」とは別に置くのか】
 * 規則の適用は `toTournament` の中にあるが、**エントリを作る経路は1つとは限らない**
 * (現に `tools/import-venue-image.js` は自前の `toTournament` を持っている)。
 * 適用箇所だけを見ていると、経路が増えた日に静かに素通りする。
 * **書き込みの直前に、出来上がった物そのものを見る**のがこの関数の役目。
 *
 * 返すのは違反の一覧で、**空配列が正常**。呼び出し側は `assertListingRulesApplied` を使う。
 * @param {Array<object>} entries
 * @returns {Array<{ kind: string, id: string, venueId: string, name: string, detail: string }>}
 */
function listingRuleViolations(entries) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e) continue;
    const noBuyin = buyinNotRecorded(e.venueId);
    if (noBuyin && e.buyin != null) {
      out.push({
        kind: 'buyin-not-suppressed',
        id: e.id,
        venueId: e.venueId,
        name: e.name,
        detail: `参加費を記録しない店(${noBuyin.label})なのに buyin=${JSON.stringify(e.buyin)} が入っています`,
      });
    }
    const excluded = excludedByListingRule(e.venueId, e.name);
    if (excluded) {
      out.push({
        kind: 'excluded-row-present',
        id: e.id,
        venueId: e.venueId,
        name: e.name,
        detail: `掲載ルールで除外すべき行(${excluded.label} / 「${excluded.term}」)が残っています`,
      });
    }
  }
  return out;
}

/**
 * 違反があれば例外を投げる。**これは自分のコードのバグを見つけるための検査**で、
 * 良性の入力では鳴らない。鳴ったら書き進めない方が正しい
 * (`assertOnlyTargetChanged` / `assertHumanEditsPreserved` と同じ扱い。
 *  店単位の隔離を受けない点は README リスク台帳 #20 のとおり)。
 * @param {Array<object>} entries
 * @param {string} where 呼び出し元を示す短い文字列(エラー文に出す)
 */
function assertListingRulesApplied(entries, where) {
  const v = listingRuleViolations(entries);
  if (v.length === 0) return;
  const lines = v.map((x) => `  - [${x.kind}] ${x.venueId} / ${JSON.stringify(x.name)} / ${x.detail}`);
  throw new Error(
    `店ごとの掲載ルールが適用されていない行が ${v.length}件 あります(${where})。` +
      'この規則は【利用者が誤った金額・誤った開催を信じる】のを防ぐためのものなので、' +
      '違反したまま書き進めません。tools/venue-listing-rules.js を参照。\n' +
      lines.join('\n')
  );
}

module.exports = {
  normalizeName,
  BUYIN_NOT_RECORDED,
  NAME_EXCLUSIONS,
  buyinNotRecorded,
  excludedByListingRule,
  exclusionReasonText,
  listingRuleViolations,
  assertListingRulesApplied,
};
