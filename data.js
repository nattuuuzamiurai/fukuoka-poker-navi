/* ============================================================
 * data.js — 福岡ポーカートーナメント・アグリゲーター データ層
 *
 * このファイルは「表示用の正規化済みデータ」を持つ。
 * 実運用では以下の3系統から生成される想定:
 *   1. auto  … 店舗公式サイト / Googleビジネス / 一部Xを自動スクレイプ
 *   2. semi  … LINE公式・Instagram等の告知テキストを管理画面に貼付 →
 *              LLMで日付/大会名/バイイン等を抽出して正規化(下記スキーマ)
 *   3. manual … 手動入力
 *
 * ※ 現段階のデータはすべて構造デモ用のサンプル。実在店舗の主張ではない。
 *
 * ---- スキーマ ----------------------------------------------
 * Venue {
 *   id, name, area, address, access,
 *   x(twitter), line, instagram, website, tel,
 *   featured(boolean),  // PR/有料掲載枠
 *   note
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

// --- 日付ヘルパ: 実行時の「今日」を基準に相対日付を生成（デモが常に新鮮に見えるように） ---
function _d(offsetDays) {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() + offsetDays);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const d = String(t.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const VENUES = [
  { id: 'v1', name: 'アミューズメントポーカー 天神スクエア', area: '天神', address: '福岡市中央区天神2-x-x ○○ビル5F', access: '地下鉄天神駅 徒歩3分', x: 'https://x.com/', line: 'https://line.me/', instagram: 'https://instagram.com/', website: '#', tel: '', featured: true,  note: 'サンプル店舗' },
  { id: 'v2', name: 'POKER ROOM 中洲ロイヤル',           area: '中洲', address: '福岡市博多区中洲x-x-x ○○ビル3F', access: '地下鉄中洲川端駅 徒歩2分', x: 'https://x.com/', line: 'https://line.me/', instagram: 'https://instagram.com/', website: '#', tel: '', featured: true,  note: 'サンプル店舗' },
  { id: 'v3', name: '博多カードクラブ',                   area: '博多', address: '福岡市博多区博多駅前x-x-x ○○ビル7F', access: 'JR博多駅 徒歩5分', x: 'https://x.com/', line: 'https://line.me/', instagram: '', website: '#', tel: '', featured: false, note: 'サンプル店舗' },
  { id: 'v4', name: '大名ポーカーラウンジ',               area: '大名', address: '福岡市中央区大名x-x-x ○○ビル2F', access: '地下鉄赤坂駅 徒歩6分', x: 'https://x.com/', line: 'https://line.me/', instagram: 'https://instagram.com/', website: '', tel: '', featured: false, note: 'サンプル店舗' },
  { id: 'v5', name: 'CLUB ACE 小倉',                     area: '北九州', address: '北九州市小倉北区x-x-x ○○ビル4F', access: 'JR小倉駅 徒歩4分', x: 'https://x.com/', line: 'https://line.me/', instagram: '', website: '#', tel: '', featured: false, note: 'サンプル店舗' },
  { id: 'v6', name: '久留米ポーカースポット',             area: '久留米', address: '久留米市x-x-x ○○ビル2F', access: 'JR久留米駅 徒歩7分', x: '', line: 'https://line.me/', instagram: '', website: '', tel: '', featured: false, note: 'サンプル店舗' },
];

const TOURNAMENTS = [
  // 直近
  { id: 't1',  venueId: 'v1', name: 'AceHigh Daily NLH',            date: _d(0),  start: '19:00', buyin: 3000,  addon: 1000,  stack: 20000, guarantee: null,    reentry: 'late', prize: null,                 tags: ['デイリー'],          source: 'auto',   verified: true },
  { id: 't2',  venueId: 'v2', name: '中洲サンデースペシャル',        date: _d(0),  start: '13:00', buyin: 5000,  addon: 2000,  stack: 30000, guarantee: 300000,  reentry: true,   prize: '賞金 + トロフィー',  tags: ['大型','ゲスト参戦'], source: 'semi',   verified: true },
  { id: 't3',  venueId: 'v3', name: '博多ナイトターボ',              date: _d(1),  start: '20:00', buyin: 2000,  addon: null,  stack: 15000, guarantee: null,    reentry: true,   prize: null,                 tags: ['ターボ'],            source: 'auto',   verified: true },
  { id: 't4',  venueId: 'v4', name: '大名 Bounty Hunter',           date: _d(2),  start: '19:30', buyin: 4000,  addon: 1000,  stack: 25000, guarantee: null,    reentry: 'late', prize: 'ノックアウト賞',     tags: ['バウンティ'],        source: 'semi',   verified: false },
  { id: 't5',  venueId: 'v1', name: '週末メイン GTD50万',            date: _d(3),  start: '12:00', buyin: 8000,  addon: 3000,  stack: 40000, guarantee: 500000,  reentry: true,   prize: '賞金 + 次回シード',  tags: ['大型','メイン'],     source: 'semi',   verified: true },
  { id: 't6',  venueId: 'v5', name: '小倉 Friday NLH',              date: _d(4),  start: '19:00', buyin: 3000,  addon: 1000,  stack: 20000, guarantee: null,    reentry: 'late', prize: null,                 tags: ['デイリー'],          source: 'auto',   verified: true },
  { id: 't7',  venueId: 'v2', name: '中洲ハイローラー',              date: _d(5),  start: '13:00', buyin: 15000, addon: 5000,  stack: 50000, guarantee: 1000000, reentry: true,   prize: '賞金 + タイトル',    tags: ['大型','ハイロー'],   source: 'semi',   verified: true },
  { id: 't8',  venueId: 'v6', name: '久留米 週末オープン',            date: _d(6),  start: '13:00', buyin: 2500,  addon: 1000,  stack: 18000, guarantee: null,    reentry: 'late', prize: null,                 tags: ['デイリー'],          source: 'manual', verified: false },
  { id: 't9',  venueId: 'v3', name: '博多レディースDay',             date: _d(7),  start: '14:00', buyin: 2000,  addon: null,  stack: 20000, guarantee: null,    reentry: true,   prize: 'アメニティ',         tags: ['女性歓迎'],          source: 'semi',   verified: true },
  { id: 't10', venueId: 'v4', name: '大名 Deep Stack',              date: _d(9),  start: '12:00', buyin: 6000,  addon: 2000,  stack: 45000, guarantee: 300000,  reentry: true,   prize: null,                 tags: ['ディープ','大型'],   source: 'auto',   verified: true },
  { id: 't11', venueId: 'v1', name: '月例チャンピオンシップ',         date: _d(12), start: '11:00', buyin: 12000, addon: 4000,  stack: 50000, guarantee: 1500000, reentry: true,   prize: '賞金 + 年間PT',      tags: ['大型','メイン','月例'], source: 'semi', verified: true },
  { id: 't12', venueId: 'v5', name: '小倉 Bounty Sunday',           date: _d(13), start: '13:00', buyin: 4000,  addon: 1000,  stack: 25000, guarantee: null,    reentry: 'late', prize: 'ノックアウト賞',     tags: ['バウンティ'],        source: 'auto',   verified: true },
];

// area の表示順（フィルタUI用）
const AREAS = ['天神', '博多', '中洲', '大名', '北九州', '久留米'];

if (typeof module !== 'undefined') { module.exports = { VENUES, TOURNAMENTS, AREAS }; }
