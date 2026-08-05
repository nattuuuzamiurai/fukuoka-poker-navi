'use strict';

/**
 * venue-listing-rules.test.js — 店ごとの掲載ルール(社長指示)の両方向を固定する。
 *
 * 【この規則は「鳴らない警報」になりやすい】v40 の `大還元` は月8行前後、v20 の `華金` は月3行程度、
 * v35 の参加費は月11行程度しか動かない。**平常時の本番ログはほとんど変わらない**ので、
 * 判定が丸ごと死んでも気づけない。この案件が繰り返し踏んできた罠なので、必ず両方向を固定する:
 *   ・除外すべき行が除外される / 参加費が消える
 *   ・**除外すべきでない行が残る / 対象外の店の参加費は消えない**
 *
 * 【変異試験(2026-08-05・`node --test 'tools/*.test.js'` を変異ごとに1回ずつ実走して数えた)】
 * ベースラインは 448本すべて緑。件数は **落ちたテストの本数**(スイート全体での実測)。
 *
 *   | # | 変異 | 落ちた |
 *   |---|---|---:|
 *   | M1 | `excludedByListingRule` を `return null` に潰す | 15 |
 *   | M2 | **venueId の絞り込みを外して全店一致にする**(= v18 を巻き込む改修) | 6 |
 *   | M3 | `buyinNotRecorded` を `return null` に潰す | 8 |
 *   | M4 | `listingRuleViolations` を `return []` に潰す(**検知器そのもの**) | 5 |
 *   | M5 | `term` の部分一致を完全一致(`===`)にする | 13 |
 *   | M6 | 事後条件の呼び出しを2経路とも削除(**検知器への配線**) | 4 |
 *   | M7 | 参加費を捨てた行を数えない(保存則の項) | 2 |
 *   | M8 | 全行除外の投稿を専用バケツに入れない | 1 |
 *   | M9 | 参加費を載せない行にも ⚠ を付ける | 2 |
 *   | M10 | 掲載ルールのログを `main()` から消す(**報告の配線**) | 2 |
 *
 * ★M6 と M10 は「検知器を試したら、そこに値を渡す【配線】にも変異を当てる」という
 *   このリポジトリの定型に従って足したもの。**M10 は最初この形のテストが無く、実際に
 *   変異が素通りした**(スイート全体が緑のままだった)。CLI の stdout を見るテストを
 *   足して初めて落ちるようになった。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rules = require('./venue-listing-rules');

// ============================================================
// 規則1: 参加費を一切記録しない店(v35 / A&K)
// ============================================================

test('★規則1: 参加費を記録しない店として v35 が登録されている(理由つき)', () => {
  const r = rules.buyinNotRecorded('v35');
  assert.ok(r, 'v35 が対象から外れている(社長指示 2026-08-05)');
  assert.equal(r.venueId, 'v35');
  // 【理由は「社長の指示」だけにしない】なぜそうするのかが無いと、後から誰も再評価できない。
  assert.match(r.reason, /店内通過価格/, 'この店の数字が円と対応しないことが理由として残っていること');
  assert.match(r.reason, /持っていく金額/, '実害(利用者が誤った金額を持っていく)が残っていること');
  assert.match(r.reason, /0\(無料\)/, '0も消す判断の根拠が残っていること');
});

test('★規則1(逆方向): 他の店は参加費を記録する(規則が全店に広がっていないこと)', () => {
  // ここが null でなくなる = 他店の参加費が静かに消える。表示は「詳細は店舗SNSを確認」に
  // 変わるだけなので、**サイトを見ても壊れたと分からない**種類の退行になる。
  for (const v of ['v40', 'v20', 'v18', 'v21', 'v34', 'v3', 'v19', '']) {
    assert.equal(rules.buyinNotRecorded(v), null, `参加費を消してはいけない店: ${JSON.stringify(v)}`);
  }
  assert.equal(rules.buyinNotRecorded(null), null);
  assert.equal(rules.buyinNotRecorded(undefined), null);
});

// ============================================================
// 規則2・3: 大会名による除外(v40 の `大還元` / v20 の `華金`)
// ============================================================

test('★規則2/3: 対象店の該当行は除外される(試験実行 run 30973996821 で実際に出た名前)', () => {
  // v40 … チップ大還元 ×7 / スーパー大還元 ×1
  for (const name of ['チップ大還元', 'スーパー大還元', 'チップ大還元!', 'ﾁｯﾌﾟ大還元']) {
    const hit = rules.excludedByListingRule('v40', name);
    assert.ok(hit, `除外すること: v40 / ${name}`);
    assert.equal(hit.term, '大還元');
  }
  // v20 … 華金 ×3
  for (const name of ['華金', '華金トナメ', ' 華金 ']) {
    const hit = rules.excludedByListingRule('v20', name);
    assert.ok(hit, `除外すること: v20 / ${name}`);
    assert.equal(hit.term, '華金');
  }
});

test('★規則2/3(逆方向): 対象店の正当な大会は残る', () => {
  // 実データにある v40 / v20 の大会名(この規則が当たってはいけない側)。
  for (const name of ['FST SATELLITE', 'フリロ（PLOトナメ）', 'FST × DEEP', 'FST フリーズアウト ターボ', 'TAGマッチ']) {
    assert.equal(rules.excludedByListingRule('v40', name), null, `落としてはいけない: v40 / ${name}`);
  }
  for (const name of ['Chip Entry Tournament', 'Tuesday Night Tournament', 'FSTサテライト', '1K Tournament', 'DEEP STACK']) {
    assert.equal(rules.excludedByListingRule('v20', name), null, `落としてはいけない: v20 / ${name}`);
  }
  assert.equal(rules.excludedByListingRule('v40', ''), null, '空の名前で除外しない');
  assert.equal(rules.excludedByListingRule('', 'チップ大還元'), null, 'venueId が無いなら判定しない');
});

test('★規則2/3(逆方向・これが本命): 語は【対象店以外】には当たらない', () => {
  // 【実データにある衝突(2026-08-05実測)】`大還元` は他店の正当な大会名に3通り存在する。
  //   v18 `大還元フリロ` / v18 `月末大還元` / v37 `RGS大還元祭（参加条件はX/オープンチャットを要確認）`
  // ★v18 は Instagram監視の対象6店に入っている。全店に効かせると【自動経路が毎月
  //   v18 の正当な大会を静かに落とす】。ここは固定フィクスチャで押さえる
  //   (実データの件数をテストに書かない、という README の規律に従い、名前だけを写す)。
  const collisions = [
    ['v18', '大還元フリロ'],
    ['v18', '月末大還元'],
    ['v37', 'RGS大還元祭（参加条件はX/オープンチャットを要確認）'],
    ['v21', 'チップ大還元'], // 同じ名前でも店が違えば落とさない
    ['v34', 'スーパー大還元'],
  ];
  for (const [venueId, name] of collisions) {
    assert.equal(
      rules.excludedByListingRule(venueId, name),
      null,
      `他店の大会を落としてはいけない: ${venueId} / ${name}`
    );
  }
  // `華金` は「花金(金曜日)」の一般名詞で、他店にも現れうる
  // (実際 monitor-instagram-apify.test.js は `華金` を正当な大会名の代表例として使っている)。
  for (const venueId of ['v40', 'v18', 'v21', 'v34', 'v35']) {
    assert.equal(rules.excludedByListingRule(venueId, '華金'), null, `他店の華金は落とさない: ${venueId}`);
  }
  // 【対をなす主張】同じ名前でも【対象店なら】落ちること = 上の null が
  // 「判定そのものが死んでいる」ことによる null ではないと言える。
  assert.ok(rules.excludedByListingRule('v40', '大還元フリロ'), 'v40 でなら落ちること');
  assert.ok(rules.excludedByListingRule('v20', '華金'), 'v20 でなら落ちること');
});

test('規則2/3: 部分一致であること(「大還元」を含む未知の名前も対象店では落とす)', () => {
  // 社長が挙げたのは `チップ大還元` と `スーパー大還元` の2通りだが、店が来月別の修飾を
  // 付ける可能性がある。**対象店に限れば**部分一致で受ける方が指示に忠実。
  assert.ok(rules.excludedByListingRule('v40', '月末チップ大還元デー'));
  assert.ok(rules.excludedByListingRule('v20', '金曜華金スペシャル'));
});

test('規則2/3: 根拠の強さが規則ごとに記録されている(推定と不明を同じ顔で並べない)', () => {
  const orio = rules.NAME_EXCLUSIONS.find((r) => r.venueId === 'v40');
  const nogata = rules.NAME_EXCLUSIONS.find((r) => r.venueId === 'v20');
  // 社長は「おそらくリングの話」と【推定】で言われている。確定した事実ではない。
  assert.match(orio.basis, /推定/, '推定であることが記録に残っていること');
  assert.match(orio.reason, /おそらく/, '社長の言葉づかい(推定)がそのまま残っていること');
  // 直方の華金は「なにかわからないので無視」= 内容不明が理由。
  assert.match(nogata.basis, /不明/, '「分からないから除外」という理由が残っていること');
  assert.match(nogata.reason, /なにかわからない/, '社長の言葉がそのまま残っていること');
});

// ============================================================
// ★誤ヒット走査: 実データの全大会名に当てる
// ============================================================
// 【README「テストに実データの件数を書かないこと」に従う】data.js は無人の日次ジョブが
// 毎日書き換えるので、固定の件数を期待値に置くと店を1つ足すたびに理由なく赤くなる。
// ここで見るのは **いつ・どの店が増えても成り立つ性質** だけ:
//   「この規則が発火してよいのは、その規則の venueId のときだけ」
// この性質は、規則を全店一致に変える改修(= 実データで v18 を巻き込む改修)で必ず落ちる。

test('★誤ヒット: data.js の全大会名 × 全店の総当たりで、発火は規則の対象店だけ', () => {
  const { TOURNAMENTS } = require('../data.js');
  const names = [...new Set(TOURNAMENTS.map((t) => t.name))];
  const venueIds = [...new Set(TOURNAMENTS.map((t) => t.venueId))];
  // 【空振りで緑にならないようにする】走査対象が消えたら、この検査は何も見ていない。
  assert.ok(names.length >= 100, `大会名が少なすぎる(走査が成立していない): ${names.length}`);
  assert.ok(venueIds.length >= 10, `店が少なすぎる(走査が成立していない): ${venueIds.length}`);

  // 【総当たりの意味】「もしその店にその名前が来たら落ちるか」を全組み合わせで見る。
  // 発火してよいのは規則の対象店のときだけ。**それ以外の店で1件でも発火したら誤ヒット。**
  const wrongVenue = [];
  for (const name of names) {
    for (const venueId of venueIds) {
      const hit = rules.excludedByListingRule(venueId, name);
      if (!hit) continue;
      if (hit.venueId !== venueId) wrongVenue.push(`${venueId} / ${name} → ${hit.term}`);
    }
  }
  assert.deepEqual(wrongVenue, [], '規則の対象店以外で発火している(全店一致になっていないか確認すること)');

  // 【いま data.js に載っている行に、この規則が当たるものは無い】= 誤ヒット0件。
  // ★ここは「行」で見る(名前と店の実際の組み合わせ)。上の総当たりは
  //   「もしその店にその名前が来たら」の話なので、両方を見て初めて意味がある。
  const hitRows = TOURNAMENTS.filter((t) => rules.excludedByListingRule(t.venueId, t.name));
  assert.deepEqual(
    hitRows.map((t) => `${t.venueId} / ${t.date} / ${t.name}`),
    [],
    'いま掲載している行に規則が当たっている(人が admin.html で入れた行なら、規則の是非を再確認すること)'
  );

  // 【「1件も当たらなかった」を「判定が死んでいる」と区別する】
  // ★上の2つは【当たらないこと】しか見ていないので、`return null` に潰す変異でも緑になる。
  //   同じ関数が、規則の語をその店に当てたときには必ず発火することをここで押さえる
  //   (これは実データに依存しないので、data.js が変わっても意味を失わない)。
  for (const r of rules.NAME_EXCLUSIONS) {
    assert.ok(rules.excludedByListingRule(r.venueId, r.term), `規則そのものが発火しない: ${r.venueId} / ${r.term}`);
  }

  // 【★他店に語を含む名前が実在することを、走査の中でも確かめる】
  //   これが 0 になったら「衝突が無いから通っている」だけの空振りテストに変わるので、
  //   そのときは上の固定フィクスチャ側(★規則2/3(逆方向・これが本命))だけが主張を支えている、
  //   と分かるようにログを残す。**件数は期待値にしない**(data.js は日次で変わるため)。
  const crossVenueTermRows = TOURNAMENTS.filter(
    (t) =>
      rules.NAME_EXCLUSIONS.some(
        (r) => rules.normalizeName(t.name).includes(rules.normalizeName(r.term)) && r.venueId !== t.venueId
      )
  );
  for (const t of crossVenueTermRows) {
    assert.equal(
      rules.excludedByListingRule(t.venueId, t.name),
      null,
      `他店の正当な大会を落としてはいけない: ${t.venueId} / ${t.name}`
    );
  }
});

// ============================================================
// 事後条件(出来上がったエントリそのものを見る検査)
// ============================================================

test('★事後条件: 規則が適用されていないエントリを検出する(両方向)', () => {
  // (a) 正常 = 違反0件
  const ok = [
    { id: 'a', venueId: 'v35', name: 'FREE ROLL', buyin: null },
    { id: 'b', venueId: 'v40', name: 'FST SATELLITE', buyin: 3000 },
    { id: 'c', venueId: 'v18', name: '大還元フリロ', buyin: 0 }, // 他店なので残ってよい
    { id: 'd', venueId: 'v20', name: 'DEEP STACK', buyin: null },
  ];
  assert.deepEqual(rules.listingRuleViolations(ok), []);
  assert.doesNotThrow(() => rules.assertListingRulesApplied(ok, 'テスト'));

  // (b) 参加費が残っている(0 も違反 — 「0円で参加できる」という円建ての主張になるため)
  const withBuyin = rules.listingRuleViolations([{ id: 'x', venueId: 'v35', name: 'FREE ROLL', buyin: 0 }]);
  assert.equal(withBuyin.length, 1);
  assert.equal(withBuyin[0].kind, 'buyin-not-suppressed');

  // (c) 除外すべき行が残っている
  const withExcluded = rules.listingRuleViolations([{ id: 'y', venueId: 'v40', name: 'チップ大還元', buyin: null }]);
  assert.equal(withExcluded.length, 1);
  assert.equal(withExcluded[0].kind, 'excluded-row-present');

  // (d) 例外の文面に、どの行が・なぜ駄目かが出ること(落ちたログだけで原因に到達できること)
  assert.throws(
    () => rules.assertListingRulesApplied([{ id: 'z', venueId: 'v35', name: 'X', buyin: 400 }], 'テスト経路'),
    (e) => /テスト経路/.test(e.message) && /buyin-not-suppressed/.test(e.message) && /400/.test(e.message)
  );
  assert.deepEqual(rules.listingRuleViolations(null), [], '配列でない入力で落ちないこと');
});

test('正規化: 名前の判定は NFKC・小文字化・区切りの揺れを吸収したうえで行う', () => {
  assert.equal(rules.normalizeName('ＦＳＴ・ＳＡＴＥＬＬＩＴＥ'), 'fst satellite');
  assert.equal(rules.normalizeName(null), '');
  // 全角の店名表記でも同じ規則に当たること
  assert.ok(rules.excludedByListingRule('v40', 'ﾁｯﾌﾟ大還元'));
});
