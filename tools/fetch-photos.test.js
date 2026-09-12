'use strict';

/**
 * fetch-photos.test.js
 *
 * 純粋関数(ホットペッパーID抽出・プレースホルダー画像判定・fukuoka-venues.json↔data.js の
 * 名寄せ)の単体テストと、APIキー未設定時に正常終了して空マップを書き出すことの実測。
 * 本物のホットペッパーAPIは一切叩かない。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mod = require('./fetch-photos.js');

// ============================================================
// HP_ID_RE / extractHpId
// ============================================================

test('extractHpId: ホットペッパーURLから店舗IDを抽出する', () => {
  assert.equal(mod.extractHpId(['https://www.hotpepper.jp/strJ003736010/']), 'J003736010');
});

test('extractHpId: ホットペッパー以外のURLだけなら null', () => {
  assert.equal(mod.extractHpId(['https://x.com/example', 'https://example.com/']), null);
});

test('extractHpId: sources が無くても落ちない', () => {
  assert.equal(mod.extractHpId(undefined), null);
  assert.equal(mod.extractHpId([]), null);
});

test('extractHpId: 複数sourcesの中からホットペッパーのものだけ拾う', () => {
  const sources = ['https://example.com/official', 'https://www.hotpepper.jp/strJ001232528/', 'https://x.com/foo'];
  assert.equal(mod.extractHpId(sources), 'J001232528');
});

// ============================================================
// isPlaceholderImage
// ============================================================

test('isPlaceholderImage: 空文字・未定義はプレースホルダー扱い', () => {
  assert.equal(mod.isPlaceholderImage(''), true);
  assert.equal(mod.isPlaceholderImage(undefined), true);
});

test('isPlaceholderImage: /SYS/cmn/ 配下の共通NO IMAGE画像は除外', () => {
  assert.equal(mod.isPlaceholderImage('https://imgfp.hotp.jp/SYS/cmn/images/common/diary/custom/m30_img_noimage.gif'), true);
});

test('isPlaceholderImage: noimage/dummy を含むURLは除外', () => {
  assert.equal(mod.isPlaceholderImage('https://example.com/no_image.png'), true);
  assert.equal(mod.isPlaceholderImage('https://example.com/dummy.jpg'), true);
});

test('isPlaceholderImage: 実写真・実ロゴのCDNパスは除外しない', () => {
  assert.equal(mod.isPlaceholderImage('https://imgfp.hotp.jp/IMGH/12/34/P012345678/P012345678_1.jpg'), false);
});

// ============================================================
// collectHpIds (fukuoka-venues.json ↔ data.js の名寄せ)
// ============================================================

test('collectHpIds: 店名の完全一致でdata.jsのidに対応付ける', () => {
  const venuesJson = {
    venues: [
      { name: 'Casino bar Leje 博多店', sources: ['https://www.lejehakata.com/', 'https://www.hotpepper.jp/strJ003736010/'] },
      { name: 'KAJI BAR', sources: ['https://kajibarkokura.owst.jp/', 'https://www.hotpepper.jp/strJ001232528/'] }
    ]
  };
  const dataVenues = [
    { id: 'v5', name: 'Casino bar Leje 博多店' },
    { id: 'v39', name: 'KAJI BAR' }
  ];
  const { map, unmatched } = mod.collectHpIds(venuesJson, dataVenues);
  assert.equal(map.get('v5'), 'J003736010');
  assert.equal(map.get('v39'), 'J001232528');
  assert.deepEqual(unmatched, []);
});

test('collectHpIds: ホットペッパーURLが無い店は対象外(unmatchedにも入らない)', () => {
  const venuesJson = { venues: [{ name: 'A店', sources: ['https://x.com/a'] }] };
  const dataVenues = [{ id: 'v1', name: 'A店' }];
  const { map, unmatched } = mod.collectHpIds(venuesJson, dataVenues);
  assert.equal(map.size, 0);
  assert.deepEqual(unmatched, []);
});

test('collectHpIds: data.jsに同名の店が無ければunmatchedに入り、曖昧一致はしない', () => {
  const venuesJson = {
    venues: [{ name: 'CASINO BLOW 西中洲　', sources: ['https://www.hotpepper.jp/strJ003340655/'] }]
  };
  // 末尾の全角スペースがある分だけ食い違う店名 = 完全一致しない例
  const dataVenues = [{ id: 'v9', name: 'CASINO BLOW 西中洲' }];
  const { map, unmatched } = mod.collectHpIds(venuesJson, dataVenues);
  assert.equal(map.size, 0);
  assert.deepEqual(unmatched, ['CASINO BLOW 西中洲　']);
});

test('collectHpIds: 空入力でも落ちない', () => {
  const { map, unmatched } = mod.collectHpIds({ venues: [] }, []);
  assert.equal(map.size, 0);
  assert.deepEqual(unmatched, []);
});

// ============================================================
// 実行(APIキー未設定時): 正常終了して空マップを出力する
// ============================================================

const OUT_FILE = path.join(__dirname, '..', 'data', 'photos.generated.json');

test('HOTPEPPER_API_KEY未設定: 正常終了(exit 0)し、空マップを書き出す', () => {
  const before = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf-8') : null;
  try {
    const env = { ...process.env };
    delete env.HOTPEPPER_API_KEY;
    const res = spawnSync(process.execPath, [path.join(__dirname, 'fetch-photos.js')], { env, encoding: 'utf-8' });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(fs.existsSync(OUT_FILE), 'data/photos.generated.json が生成されていない');
    const written = JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8'));
    assert.deepEqual(written, {});
  } finally {
    // このテストが実データ(実行環境でキーが設定されている場合の生成結果)を消さないよう復元する。
    if (before === null) {
      fs.rmSync(OUT_FILE, { force: true });
    } else {
      fs.writeFileSync(OUT_FILE, before);
    }
  }
});
