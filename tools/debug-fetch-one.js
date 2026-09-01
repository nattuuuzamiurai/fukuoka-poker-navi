'use strict';
/**
 * debug-fetch-one.js
 *
 * 【使い捨ての診断スクリプト】v34(King&QUEEN SUITED 黒崎店・@king806queenkurosaki)で
 * Apify取得が2026-08-06以降ずっと同じ12件を返し続けている(新着を検知できない)原因を切り分けるため、
 * 1店舗ぶんだけをApifyに素で問い合わせ、生のpermalink・投稿日時を出力する。
 * 6店舗まとめて呼ぶ monitor-instagram-apify.js の本番実行(1回で6店ぶんの課金)を避け、
 * このハンドル1件だけ(課金は12件分のみ)で済ませるための一時ツール。
 * 診断が終わったらこのファイル・専用ワークフローごと削除する(mainにはマージしない)。
 */
const { fetchInstagramPosts } = require('./fetch-venue-posts-apify.js');

const HANDLE = process.argv[2] || 'king806queenkurosaki';

(async () => {
  console.log(`[debug-fetch-one] handle=${HANDLE} を取得します...`);
  const stats = {};
  const posts = await fetchInstagramPosts(HANDLE, { stats });
  console.log(`[debug-fetch-one] 取得完了: ${posts.length}件 / 所要 ${stats.elapsedMs}ms / 試行 ${stats.attempts}回`);
  console.log(`[debug-fetch-one] rawCount(正規化前)=${stats.rawCount} / malformed(正規化失敗)=${stats.malformed}`);
  console.log('');
  posts.forEach((p, i) => {
    console.log(
      `[${i}] postedAt=${p.postedAt} permalink=${p.permalink} captionLen=${p.caption ? p.caption.length : 0}`
    );
  });
})().catch((e) => {
  console.error('[debug-fetch-one] ERROR:', e.message);
  process.exit(1);
});
