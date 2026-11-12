/* 外部リンクのクリック計測(GA4イベント)。本番ドメイン以外では何も送らない。
   - app_click        : 自社アプリへの導線(utm_medium をそのまま link_medium に載せる)
   - venue_link_click : 店舗・主催者の公式サイト/SNSへの外部リンク
   GA4のキーイベント(コンバージョン)としてこの2つを登録している。 */
(function () {
  if (location.hostname !== 'fukuokapoker.com' || typeof gtag !== 'function') return;
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var u;
    try { u = new URL(a.href, location.href); } catch (_) { return; }
    if (u.protocol.indexOf('http') !== 0 || u.hostname === location.hostname) return;
    var isApp = u.hostname.indexOf('poker-tourney-log') === 0;
    gtag('event', isApp ? 'app_click' : 'venue_link_click', {
      link_domain: u.hostname,
      link_url: u.origin + u.pathname,
      link_medium: isApp ? (u.searchParams.get('utm_medium') || '') : '',
      transport_type: 'beacon'
    });
  }, true);
})();
