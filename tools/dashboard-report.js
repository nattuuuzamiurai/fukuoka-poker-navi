'use strict';
/**
 * dashboard-report.js
 *
 * このワークフロー(GitHub Actions・無人実行)から、経営管理オフィスへの報告事項を
 * ダッシュボード(`acehigh-dashboard`, public repo)の専用ファイル `sns_monitor_alerts.json`
 * に直接書き込む。`.claude/scripts/hr-watch-daemon.js` が `hr_session_watch_status.json` を
 * 書いているのと同じ発想(＝セッションを介さず、無人実行から直接ダッシュボードへ反映する)。
 *
 * 【hr-watch-daemon.js と実装方式が違う理由】
 *   hr-watch-daemon.js はこのMac上のlaunchdから動くため、`acehigh-dashboard` の
 *   ローカルclone(既に認証済みのgit remote)に対して直接 commit/push できる。
 *   このスクリプトはGitHub Actionsのランナー上で動き、`acehigh-dashboard` のローカルcloneを
 *   持たない使い捨て環境のため、GitHubのContents API(`PUT /repos/:owner/:repo/contents/:path`)
 *   を使って対象ファイル1つだけを直接読み書きする(cloneが不要で、他ファイルに触れる余地もない)。
 *
 * 【必要シークレット】`DASHBOARD_WRITE_TOKEN`
 *   `acehigh-dashboard` への contents:write 権限を持つ GitHub PAT(Fine-grained PAT推奨、
 *   対象リポジトリをこの1つに絞ったもの)。未設定の場合は書き込みを行わず、
 *   ログにだけ内容を残す(=既存の安全設計と同じく、無いシークレットを無理に使わない)。
 *
 * 【書く内容】社内の作業内容(店舗名の詳細メモ等)は書かない。venueId・種別・時刻・
 * 短い理由だけの最小限にする(hr_session_watch_status.jsonと同じ考え方)。
 */

const OWNER = 'nattuuuzamiurai';
const REPO = 'acehigh-dashboard';
const FILE_PATH = 'sns_monitor_alerts.json';
const BRANCH = 'main';
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;
const MAX_ALERTS = 50; // 無限に肥大化しないよう直近N件だけ保持する

/**
 * @param {{ venueId: string, type: 'block_suspected'|'missed_deadline'|'cycle_give_up', message: string }} alert
 * @returns {Promise<{ skipped: boolean }>}
 */
async function reportAlert(alert) {
  const token = process.env.DASHBOARD_WRITE_TOKEN;
  const payload = { ...alert, detectedAt: new Date().toISOString() };

  if (!token) {
    console.error('[dashboard-report] DASHBOARD_WRITE_TOKEN が未設定のため、ダッシュボードへの書き込みをスキップします。');
    console.error(`[dashboard-report] 本来報告すべき内容: ${JSON.stringify(payload)}`);
    return { skipped: true };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'fukuoka-poker-navi-sns-monitor',
  };

  let sha; // 404(ファイル未作成)のときは undefined のままでよい(GitHub側が新規作成として扱う)
  let current = { alerts: [] };
  const getRes = await fetch(`${API_URL}?ref=${BRANCH}`, { headers });
  if (getRes.status === 200) {
    const body = await getRes.json();
    sha = body.sha;
    try {
      current = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
    } catch (e) {
      current = { alerts: [] };
    }
  } else if (getRes.status !== 404) {
    throw new Error(`[dashboard-report] ダッシュボードのファイル取得に失敗: HTTP ${getRes.status}`);
  }

  const alerts = [...(Array.isArray(current.alerts) ? current.alerts : []), payload].slice(-MAX_ALERTS);
  const next = { updatedAt: new Date().toISOString(), alerts };
  const content = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8').toString('base64');

  const putRes = await fetch(API_URL, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `sns-monitor: ${alert.type} (${alert.venueId})`,
      content,
      sha,
      branch: BRANCH,
    }),
  });
  if (putRes.status !== 200 && putRes.status !== 201) {
    const body = await putRes.text().catch(() => '');
    throw new Error(`[dashboard-report] ダッシュボードへの書き込みに失敗: HTTP ${putRes.status} ${body}`);
  }
  return { skipped: false };
}

module.exports = { reportAlert, FILE_PATH, OWNER, REPO };
