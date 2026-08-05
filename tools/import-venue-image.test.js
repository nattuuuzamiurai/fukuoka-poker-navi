'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const importer = require('./import-venue-image');
const merge = require('./tournament-merge');

const TODAY = '2026-08-01';

test('toTournament: source=semi/verified=falseで、amountはnumber化・reentry/tagsは正規化される', () => {
  const t = importer.toTournament(
    { date: '2026-09-10', start: '19:00', name: ' 月間スケジュール ', buyin: '2000', reentry: 'late', tags: ['ターボ'] },
    'v40'
  );
  assert.equal(t.venueId, 'v40');
  assert.equal(t.name, '月間スケジュール');
  assert.equal(t.buyin, 2000);
  assert.equal(t.reentry, 'late');
  assert.equal(t.source, 'semi');
  assert.equal(t.verified, false);
  assert.ok(t.id.startsWith('photo-v40-2026-09-10-1900-'));
});

// 金額が読み取れなかったときの既定値は 0 ではなく null。0 は「0円=無料」という
// 【読み取れた値】であり、「読み取れなかった」を表せるのは null だけ(表示はどちらも
// 「詳細は店舗SNSを確認」だが、データとしての意味が逆になる)。
test('toTournament: start省略時は00:00、reentry省略時はfalse、金額は0ではなくnullになる', () => {
  const t = importer.toTournament({ date: '2026-09-10', name: 'テスト' }, 'v40');
  assert.equal(t.start, '00:00');
  assert.equal(t.reentry, false);
  assert.strictEqual(t.buyin, null);
  assert.strictEqual(t.stack, null);
  assert.equal(t.addon, null);
  assert.equal(t.guarantee, null);
});

test('parseArgs: --venue/--image/--dry-run/--posted-date を読み取る', () => {
  const args = importer.parseArgs(['--venue', 'v40', '--image', './a.jpg', '--dry-run', '--posted-date', '2026-09-01']);
  assert.equal(args.venue, 'v40');
  assert.equal(args.image, './a.jpg');
  assert.equal(args.dryRun, true);
  assert.equal(args.postedDate, '2026-09-01');
});

test('importVenueImage: Vision抽出結果をsemi/verified:falseでdata.jsにmergeする(dry-runでは書き換えない)', async () => {
  const dataJsPath = path.join(os.tmpdir(), `data-test-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  // TOURNAMENTS の終端検出は「\n];」のリテラル探索のため、空配列でも改行を挟んでおく
  // (JSON.stringifyされた実データでは非空配列なら自然にこの形になる)。
  fs.writeFileSync(dataJsPath, 'const VENUES = [];\nconst TOURNAMENTS = [\n];\nconst AREAS = [];\n');
  try {
    const fakeVisionLib = {
      async extractTournaments() {
        return [{ date: '2026-08-10', start: '19:00', name: 'テストトナメ', buyin: 3000 }];
      },
    };

    const before = fs.readFileSync(dataJsPath, 'utf8');
    const dryRunResult = await importer.importVenueImage(
      { venueId: 'v40', imageBuffer: Buffer.from('fake'), dryRun: true, dataJsPath, today: TODAY },
      { visionLib: fakeVisionLib, mergeLib: merge }
    );
    assert.equal(dryRunResult.tournaments.length, 1);
    assert.equal(dryRunResult.tournaments[0].source, 'semi');
    assert.equal(dryRunResult.tournaments[0].verified, false);
    assert.equal(dryRunResult.stats, null);
    assert.equal(fs.readFileSync(dataJsPath, 'utf8'), before, '--dry-run相当ではdata.jsを書き換えない');

    const writeResult = await importer.importVenueImage(
      { venueId: 'v40', imageBuffer: Buffer.from('fake'), dryRun: false, dataJsPath, today: TODAY },
      { visionLib: fakeVisionLib, mergeLib: merge }
    );
    assert.equal(writeResult.stats.added, 1);
    const { arr } = merge.readDataJs(dataJsPath);
    assert.equal(arr.length, 1);
    assert.equal(arr[0].source, 'semi');
    assert.equal(arr[0].verified, false);
    assert.equal(arr[0].venueId, 'v40');
  } finally {
    fs.unlinkSync(dataJsPath);
  }
});

// 規則の所有者は tools/validate-data.js の1つ、呼び出し側は3つ(このCLI / Instagram監視 / ゲート)。
// 3つ目の呼び出し側でも「不正な行だけが落ちる」ことを1件だけ確かめておく
// (ここの検査を外しても全スイートが緑のままだと、静かに退化していても気づけない)。
test('importVenueImage: 不正な行(日付書式・id重複)だけを捨て、正しい行は取り込む', async () => {
  const dataJsPath = path.join(os.tmpdir(), `data-test-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(dataJsPath, 'const VENUES = [];\nconst TOURNAMENTS = [\n];\nconst AREAS = [];\n');
  try {
    const good = { date: '2026-09-10', start: '19:00', name: 'テストトナメ', buyin: 3000 };
    const fakeVisionLib = {
      async extractTournaments() {
        return [
          good,
          { ...good },                                             // id重複
          { date: '2026-9-11', start: '19:00', name: 'ゼロ埋めなし' }, // 日付書式
          { date: '2026-09-12', start: '7pm', name: '時刻が読めない' },  // start書式
          { date: '2026-09-13', start: '25:00', name: '時刻が範囲外' },  // 正規化しても直らない
        ];
      },
    };
    const result = await importer.importVenueImage(
      { venueId: 'v40', imageBuffer: Buffer.from('fake'), dryRun: false, dataJsPath, today: TODAY },
      { visionLib: fakeVisionLib, mergeLib: merge }
    );
    assert.equal(result.tournaments.length, 1, '正しい1件だけが取り込まれる');
    const { arr } = merge.readDataJs(dataJsPath);
    assert.equal(arr.length, 1);
    assert.equal(arr[0].name, 'テストトナメ');
    assert.equal(new Set(arr.map((t) => t.id)).size, arr.length, 'idが重複していないこと');
  } finally {
    fs.unlinkSync(dataJsPath);
  }
});

// 正規化(tools/validate-data.js の normalizeExtractedRow)もこのCLIが呼ぶ。
// 呼び忘れるとこのCLIだけが `9:00` や `"3,500"` の行を捨て続ける(Instagram監視と挙動がズレる)。
test('importVenueImage: ゼロ埋め漏れの開始時刻・読めない金額でも行を捨てず、正規化して取り込む', async () => {
  const dataJsPath = path.join(os.tmpdir(), `data-test-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(dataJsPath, 'const VENUES = [];\nconst TOURNAMENTS = [\n];\nconst AREAS = [];\n');
  try {
    const fakeVisionLib = {
      async extractTournaments() {
        return [
          { date: '2026-09-10', start: '9:00', name: 'モーニング', buyin: '3,500' },
          { date: '2026-09-10', start: '19：00', name: 'ナイト', buyin: 3000, stack: '20k' },
        ];
      },
    };
    const result = await importer.importVenueImage(
      { venueId: 'v40', imageBuffer: Buffer.from('fake'), dryRun: false, dataJsPath, today: TODAY },
      { visionLib: fakeVisionLib, mergeLib: merge }
    );
    assert.equal(result.tournaments.length, 2, '2件とも取り込まれること');
    const byName = Object.fromEntries(result.tournaments.map((t) => [t.name, t]));
    assert.equal(byName['モーニング'].start, '09:00');
    assert.ok(byName['モーニング'].id.includes('-0900-'), byName['モーニング'].id);
    assert.strictEqual(byName['モーニング'].buyin, null, '読めない金額はその項目だけ null');
    assert.equal(byName['ナイト'].start, '19:00');
    assert.equal(byName['ナイト'].buyin, 3000);
    assert.strictEqual(byName['ナイト'].stack, null);
  } finally {
    fs.unlinkSync(dataJsPath);
  }
});

test('importVenueImage: Vision抽出が0件なら例外を投げ、data.jsは書き換えない', async () => {
  const dataJsPath = path.join(os.tmpdir(), `data-test-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(dataJsPath, 'const VENUES = [];\nconst TOURNAMENTS = [];\nconst AREAS = [];\n');
  try {
    const before = fs.readFileSync(dataJsPath, 'utf8');
    const fakeVisionLib = { async extractTournaments() { return []; } };
    await assert.rejects(
      () =>
        importer.importVenueImage(
          { venueId: 'v40', imageBuffer: Buffer.from('fake'), dryRun: false, dataJsPath, today: TODAY },
          { visionLib: fakeVisionLib, mergeLib: merge }
        ),
      /0件/
    );
    assert.equal(fs.readFileSync(dataJsPath, 'utf8'), before);
  } finally {
    fs.unlinkSync(dataJsPath);
  }
});

// ---------- CLIとして(子プロセスで)実行する結合テスト ----------
// 安全弁(不正な引数・未知の店舗・ファイル不在・APIキー未設定)が、実際にVision/Instagram APIへ
// アクセスする前に安全に止まり、data.js を一切書き換えないことを確認する。

const TOOLS_DIR = __dirname;
const FILES_TO_COPY = [
  'import-venue-image.js',
  'tournament-merge.js',
  'venue-schedule-vision.js',
  'instagram-oembed.js',
  'validate-data.js',
  // 「機械が最後に書いた値」の控えと所有判定。tournament-merge.js が require するので必須。
  'machine-write-state.js',
  // 店ごとの掲載ルール(社長指示)。import-venue-image.js が require するので必須。
  // 【★require を足したらここも足すこと★】足し忘れると全CLIテストが
  //   「Cannot find module」で終了コード1になり、落ち方が原因を示さない。
  'venue-listing-rules.js',
];

function makeTempRepoRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-venue-image-cli-'));
  fs.mkdirSync(path.join(root, 'tools'));
  for (const f of FILES_TO_COPY) {
    fs.copyFileSync(path.join(TOOLS_DIR, f), path.join(root, 'tools', f));
  }
  fs.writeFileSync(
    path.join(root, 'data.js'),
    'const VENUES = [{"id":"v40","name":"TripleBarrel 折尾店"}];\nconst TOURNAMENTS = [];\nconst AREAS = [];\n' +
      'if (typeof module !== "undefined") { module.exports = { VENUES, TOURNAMENTS, AREAS }; }\n'
  );
  return root;
}

function runCli(root, cliArgs, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  return execFileSync('node', ['tools/import-venue-image.js', ...cliArgs], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('CLI: --venueが無ければdata.jsを書き換えず異常終了する', () => {
  const root = makeTempRepoRoot();
  try {
    const before = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
    assert.throws(() => runCli(root, ['--image', 'x.jpg']));
    assert.equal(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: 存在しないvenueIdならdata.jsを書き換えず異常終了する', () => {
  const root = makeTempRepoRoot();
  try {
    const before = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
    assert.throws(() => runCli(root, ['--venue', 'v999', '--image', 'x.jpg']));
    assert.equal(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: 画像ファイルが存在しなければdata.jsを書き換えず異常終了する', () => {
  const root = makeTempRepoRoot();
  try {
    const before = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
    assert.throws(() => runCli(root, ['--venue', 'v40', '--image', 'no-such-file.jpg']));
    assert.equal(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: ANTHROPIC_API_KEY未設定ならVision呼び出し前(ネットワークアクセス無し)に安全終了する', () => {
  const root = makeTempRepoRoot();
  const imgPath = path.join(root, 'sample.jpg');
  fs.writeFileSync(imgPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // 最小のJPEGバイト列(内容の妥当性はチェックされない)
  try {
    const before = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    assert.throws(() => runCli(root, ['--venue', 'v40', '--image', 'sample.jpg'], env));
    assert.equal(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: --image と --instagram-url の同時指定は異常終了する', () => {
  const root = makeTempRepoRoot();
  try {
    const before = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
    assert.throws(() =>
      runCli(root, ['--venue', 'v40', '--image', 'x.jpg', '--instagram-url', 'https://www.instagram.com/p/AAAA/'])
    );
    assert.equal(fs.readFileSync(path.join(root, 'data.js'), 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// 漏洩走査: コミットされる出力面に、抽出元の余計な文字列が出ないこと
// ============================================================
// 【なぜこの経路にも要るか】このツールも public リポジトリにコミットされるファイルを
// 2つ書く(`data.js` と `venue-image-write-state.json`)。**現時点の実リスクは低い** —
// この経路には自由文の入力面が無く、`--instagram-url` も oEmbed から【サムネイル画像だけ】を
// 取り、`title` / `author_name` は使わない。控えの中身も `data.js` に載る項目だけである。
//
// **それでもテストを置くのは、将来の変更を捕まえるため。** 3つの状態ファイルのうち
// 1つだけ走査が無いと、そこが変更されたとき静かに素通りする
// (Instagram監視・Waitinglist取込みには同じ形の走査がある)。
//
// 【★このツールは未知のタグを落としていない(2026-08-04に本走査で判明。リスク台帳 #16)】
// `monitor-instagram-apify.js` の `toTournament` は `canonicalTags(t.tags)` を通すが、
// こちらは `Array.isArray(t.tags) ? t.tags : []` で素通しする。
// ★当初これを「サイトのタグ絞り込みを汚しうる」と報告したが【誤り】だった —
//   `index.html` の `inTag()` は UIの固定選択肢との一致を見るだけで、
//   データ由来の語が選択肢に現れることはない。
// ★また `canonicalTags` を素直に足してもいけない。`大型` `ハイローラー` `招待制` を落とすため
//   (同関数は「タグの正規化」ではなく「Vision が出力してよい語の allow-list」)。
// **この PR ではロジックを変えない。** ここでは走査の対象から tags を外し、
// 「載せないと決めた場所」だけを見る(仕様を欠陥として誤検知しないため)。詳細は README のリスク台帳 #16。
//
// 走査用の希少文字列は、Visionの生の出力のうち【data.js に載せないと決めた場所】に仕込む。
// ログにもコードにも現れない文字だけで構成し、2文字断片まで見る
// (「冒頭N字だけ出す」「末尾だけ出す」といった部分的な漏洩を取り逃がさないため)。
const VI_FRAGMENT_MARKERS = ['ZQXJVWKZ', '龗麤鑫', 'QJXZVWQK'];

function assertNoExtraTextLeak(haystacks) {
  let checked = 0;
  for (const marker of VI_FRAGMENT_MARKERS) {
    const chars = [...marker];
    for (let i = 0; i + 2 <= chars.length; i++) {
      const frag = chars.slice(i, i + 2).join('');
      checked += 1;
      for (const [name, text] of Object.entries(haystacks)) {
        assert.ok(!text.includes(frag), `${name} に抽出元の断片が漏れている: ${JSON.stringify(frag)}`);
      }
    }
    checked += 1;
    for (const [name, text] of Object.entries(haystacks)) {
      assert.ok(!text.includes(marker), `${name} に抽出元の文字列が漏れている: ${JSON.stringify(marker)}`);
    }
  }
  assert.ok(checked >= 15, `走査した断片が少なすぎる(${checked}通り)`);
}

test('★漏洩走査: CLIの全出力(stdout/stderr/data.js/控えのJSON)に、載せないと決めた文字列が1文字も出ない', () => {
  const root = makeTempRepoRoot();
  // TOURNAMENTS の終端検出は「\n];」のリテラル探索なので、空配列でも改行を挟んでおく
  // (makeTempRepoRoot の既定は1行の `[]` で、そこまで到達する他のテストが無いため
  //  この形になっている。ここは実際に書き込みまで走らせるので直して使う)。
  fs.writeFileSync(
    path.join(root, 'data.js'),
    'const VENUES = [{"id":"v40","name":"TripleBarrel 折尾店"}];\nconst TOURNAMENTS = [\n];\nconst AREAS = [];\n' +
      'if (typeof module !== "undefined") { module.exports = { VENUES, TOURNAMENTS, AREAS }; }\n'
  );
  // Vision が「data.js に載せない項目」まで返してくる状況を作る。
  // notes は長文の告知そのもの、caption/author は将来 oEmbed 由来の値が混ざりうる場所。
  fs.writeFileSync(
    path.join(root, 'tools', 'venue-schedule-vision.js'),
    `exports.mediaTypeFromPath = () => 'image/jpeg';
     exports.extractTournaments = async () => ([
       // 【tags には印を仕込まない】このツールは canonicalTags を通しておらず、
       // 未知のタグがそのまま data.js に入る(Instagram監視側とは違う。下記の注記参照)。
       // つまり tags は「載せないと決めた場所」ではないので、走査の対象にすると
       // 【実装の欠陥ではなく仕様を誤検知する】テストになってしまう。
       // 【start は '9:00'(ゼロ埋め漏れ)にしておくこと — 1文字だが意味がある】
       // 正規化(normalizeExtractedRow)を通さないと「抽出結果を正規化しました」の
       // ログ経路が1度も実行されず、そこに生の行を混ぜる変更を走査が取り逃がす。
       // このログは normalizeExtractedRow が返す【正規化前の値】を出すので、
       // 破棄ログと並んで最も混入しやすい場所である。
       { date: '2099-09-12', start: '9:00', name: '採用される大会', buyin: 3000, stack: 10000,
         tags: ['ターボ'],
         notes: 'ZQXJVWKZ 優勝は龗麤鑫さん 連絡先 QJXZVWQK',
         caption: 'ZQXJVWKZ 龗麤鑫 QJXZVWQK',
         author: '龗麤鑫' },
       { date: '2099-9-13', start: '19:00', name: '破棄される大会(日付書式)', buyin: 3000,
         notes: 'QJXZVWQK 龗麤鑫 ZQXJVWKZ' },
     ]);\n`
  );
  fs.writeFileSync(path.join(root, 'sample.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  try {
    // 【runCli ではなく spawnSync を使う】破棄ログ・正規化ログは console.warn = stderr に出る。
    // stdout だけを走査すると、最も混入しやすい経路を1つ見逃す。
    const r = spawnSync('node', ['tools/import-venue-image.js', '--venue', 'v40', '--image', 'sample.jpg'], {
      cwd: root,
      env: { ...process.env, ANTHROPIC_API_KEY: 'dummy' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `正常終了すること: ${r.stderr}`);
    const all = r.stdout + r.stderr;

    // 【走査の前に、狙った経路を実際に通ったことを確かめる】通っていなければ走査は空振りになる。
    assert.match(all, /1件を抽出しました/, '抽出のログ経路を通っていること');
    assert.match(all, /抽出結果を1件破棄しました/, '破棄ログの経路を通っていること(最も混入しやすい)');
    assert.match(
      all,
      /抽出結果を正規化しました: start: "9:00" → "09:00"/,
      '正規化ログの経路を通っていること(通っていないと走査がこの経路を素通りする)'
    );
    assert.match(all, /data\.js を更新しました/, '書き込みまで到達していること');

    const dataJs = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
    assert.ok(dataJs.includes('採用される大会'), '採用行が data.js に入っていること(空だと走査が空振りになる)');

    const stateJson = fs.readFileSync(path.join(root, 'venue-image-write-state.json'), 'utf8');
    assert.ok(
      stateJson.includes('採用される大会'),
      '控えが生成され、中身が入っていること(空だと走査が空振りになる)'
    );

    assertNoExtraTextLeak({
      stdout: r.stdout,
      stderr: r.stderr,
      'data.js': dataJs,
      'venue-image-write-state.json': stateJson,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// 店ごとの掲載ルール(社長指示・2026-08-05)
// ============================================================
// 【なぜこの経路にも要るか】このCLIは、Instagram監視が内容を取りこぼしたときの
// **手動の代替経路**として README・実行ログの両方から名指しで案内されている
// (「内容が必要なら node tools/import-venue-image.js … で手動取込みしてください」)。
// ここで規則が効かないと、**自動経路で消したはずの参加費・行が手動経路から入る**。
// 実害(利用者が持っていく金額を誤る / 内容の分からない開催を信じて来店する)は経路によらず同じ。
//
// 【両方向を固定する】除外される側と、除外されない側(とくに他店の `大還元`)。

function withTempDataJs(fn) {
  const dataJsPath = path.join(os.tmpdir(), `data-rules-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(dataJsPath, 'const VENUES = [];\nconst TOURNAMENTS = [\n];\nconst AREAS = [];\n');
  return Promise.resolve(fn(dataJsPath)).finally(() => fs.unlinkSync(dataJsPath));
}

const visionStub = (rows) => ({ async extractTournaments() { return rows; } });

test('★掲載ルール(v35): 手動取込みでも参加費は記録しない(0も金額も)', () =>
  withTempDataJs(async (dataJsPath) => {
    const result = await importer.importVenueImage(
      { venueId: 'v35', imageBuffer: Buffer.from('fake'), dryRun: false, dataJsPath, today: TODAY },
      {
        visionLib: visionStub([
          { date: '2026-09-10', start: '19:00', name: 'FREE ROLL', buyin: 0 },
          { date: '2026-09-11', start: '19:00', name: 'ハイローラーTOURNAMENT', buyin: 600 },
          { date: '2026-09-12', start: '19:00', name: 'WIN THE BUTTON' },
        ]),
        mergeLib: merge,
      }
    );
    assert.equal(result.tournaments.length, 3, '行そのものは捨てない(消すのは参加費だけ)');
    for (const t of result.tournaments) assert.strictEqual(t.buyin, null, `参加費を記録してはいけない: ${t.name}`);
    // 参加費以外は触らない
    assert.equal(result.tournaments[1].name, 'ハイローラーTOURNAMENT');
  }));

test('★掲載ルール(v35・逆方向): 他店では参加費をそのまま記録する', () =>
  withTempDataJs(async (dataJsPath) => {
    const result = await importer.importVenueImage(
      { venueId: 'v40', imageBuffer: Buffer.from('fake'), dryRun: false, dataJsPath, today: TODAY },
      {
        visionLib: visionStub([
          { date: '2026-09-10', start: '19:00', name: 'FST SATELLITE', buyin: 3000 },
          { date: '2026-09-11', start: '19:00', name: 'TAGマッチ', buyin: 0 },
        ]),
        mergeLib: merge,
      }
    );
    assert.equal(result.tournaments[0].buyin, 3000);
    assert.strictEqual(result.tournaments[1].buyin, 0, '0(無料)も他店では読み取れた値として残す');
  }));

test('★掲載ルール(v40/v20): 手動取込みでも「大還元」「華金」は除外される', () =>
  withTempDataJs(async (dataJsPath) => {
    const orio = await importer.importVenueImage(
      { venueId: 'v40', imageBuffer: Buffer.from('fake'), dryRun: false, dataJsPath, today: TODAY },
      {
        visionLib: visionStub([
          { date: '2026-09-06', start: '19:00', name: 'チップ大還元' },
          { date: '2026-09-16', start: '19:00', name: 'スーパー大還元' },
          { date: '2026-09-07', start: '19:00', name: 'FST SATELLITE' },
        ]),
        mergeLib: merge,
      }
    );
    assert.deepEqual(orio.tournaments.map((t) => t.name), ['FST SATELLITE']);
    return withTempDataJs(async (p2) => {
      const nogata = await importer.importVenueImage(
        { venueId: 'v20', imageBuffer: Buffer.from('fake'), dryRun: false, dataJsPath: p2, today: TODAY },
        {
          visionLib: visionStub([
            { date: '2026-09-07', start: '19:00', name: '華金' },
            { date: '2026-09-08', start: '19:00', name: 'Cエントリートナメ' },
          ]),
          mergeLib: merge,
        }
      );
      assert.deepEqual(nogata.tournaments.map((t) => t.name), ['Cエントリートナメ']);
    });
  }));

test('★掲載ルール(逆方向・これが本命): 他店の「大還元」は手動取込みでも落ちない', () =>
  withTempDataJs(async (dataJsPath) => {
    // v18 は実データに `大還元フリロ` `月末大還元` を持つ監視対象店。
    const result = await importer.importVenueImage(
      { venueId: 'v18', imageBuffer: Buffer.from('fake'), dryRun: false, dataJsPath, today: TODAY },
      {
        visionLib: visionStub([
          { date: '2026-09-01', start: '19:00', name: '大還元フリロ' },
          { date: '2026-09-25', start: '19:00', name: '月末大還元' },
          { date: '2026-09-07', start: '19:00', name: '華金' },
        ]),
        mergeLib: merge,
      }
    );
    assert.deepEqual(
      result.tournaments.map((t) => t.name).sort(),
      ['大還元フリロ', '月末大還元', '華金'].sort(),
      '他店の同名大会を1件も落とさないこと'
    );
  }));

test('★掲載ルール: 0件でも規則の適用結果をログに出す(鳴らない警報にしない)', () =>
  withTempDataJs(async (dataJsPath) => {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      await importer.importVenueImage(
        { venueId: 'v18', imageBuffer: Buffer.from('fake'), dryRun: true, dataJsPath, today: TODAY },
        { visionLib: visionStub([{ date: '2026-09-01', start: '19:00', name: 'FST SATELLITE' }]), mergeLib: merge }
      );
    } finally {
      console.log = orig;
    }
    const text = lines.join('\n');
    assert.match(text, /店ごとの掲載ルール.*除外した行 0件/, '0件でも出すこと');
    assert.match(text, /参加費の非記録: 対象外の店/);
  }));

test('★掲載ルール: 全行が除外対象なら、その理由がログに出てから0件で落ちる', () =>
  withTempDataJs(async (dataJsPath) => {
    // 【落ち方が原因を示すこと】規則で全部落ちた結果の0件と、画像が告知でなかった0件は
    // 同じ例外文になる。件数のログを throw より前に出しておかないと区別できない。
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      await assert.rejects(
        () =>
          importer.importVenueImage(
            { venueId: 'v40', imageBuffer: Buffer.from('fake'), dryRun: true, dataJsPath, today: TODAY },
            { visionLib: visionStub([{ date: '2026-09-06', start: '19:00', name: 'チップ大還元' }]), mergeLib: merge }
          ),
        /Vision抽出結果が0件でした/
      );
    } finally {
      console.log = orig;
    }
    assert.match(lines.join('\n'), /除外した行 1件/, '0件になった理由が直前のログから読めること');
  }));

test('★配線(変異): 除外が止まったら、書き込み前の事後条件が鳴って止まる', () =>
  withTempDataJs(async (dataJsPath) => {
    // 【仕組み】import-venue-image.js は `listingRules.excludedByListingRule(...)` と
    // モジュールオブジェクト経由で規則を引くが、事後条件 `listingRuleViolations` は
    // 同ファイル内のローカル束縛を呼ぶ。export を差し替えると【適用だけが止まる】。
    const rulesLib = require('./venue-listing-rules');
    const original = rulesLib.excludedByListingRule;
    rulesLib.excludedByListingRule = () => null;
    try {
      await assert.rejects(
        () =>
          importer.importVenueImage(
            { venueId: 'v40', imageBuffer: Buffer.from('fake'), dryRun: true, dataJsPath, today: TODAY },
            { visionLib: visionStub([{ date: '2026-09-06', start: '19:00', name: 'チップ大還元' }]), mergeLib: merge }
          ),
        (e) => /掲載ルールが適用されていない行/.test(e.message) && /excluded-row-present/.test(e.message)
      );
    } finally {
      rulesLib.excludedByListingRule = original;
    }
  }));

test('★配線(変異): 参加費の非記録が止まったら、書き込み前の事後条件が鳴って止まる', () =>
  withTempDataJs(async (dataJsPath) => {
    const rulesLib = require('./venue-listing-rules');
    const original = rulesLib.buyinNotRecorded;
    rulesLib.buyinNotRecorded = () => null;
    try {
      await assert.rejects(
        () =>
          importer.importVenueImage(
            { venueId: 'v35', imageBuffer: Buffer.from('fake'), dryRun: true, dataJsPath, today: TODAY },
            { visionLib: visionStub([{ date: '2026-09-10', start: '19:00', name: 'FREE ROLL', buyin: 0 }]), mergeLib: merge }
          ),
        (e) => /掲載ルールが適用されていない行/.test(e.message) && /buyin-not-suppressed/.test(e.message)
      );
    } finally {
      rulesLib.buyinNotRecorded = original;
    }
  }));
