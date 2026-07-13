#!/usr/bin/env python3
"""
管理コンソール(admin.html)用のローカル開発サーバー。

素の `python3 -m http.server` と違い、POST /save-data を受け付けて
このディレクトリの data.js を直接上書きする。これにより admin.html 側で
「生成 → ダウンロード → 手動でファイルを差し替え」という手順を踏まなくても、
画面上の操作がその場で実ファイルに反映されるようにする。

使い方: このファイルがあるディレクトリで `python3 dev-server.py` を実行し、
http://localhost:8787/admin.html を開く。
"""
import http.server
import os
import subprocess
import tempfile

PORT = 8787
DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(DIR, 'data.js')

# 保存内容が壊れたJSでないか、VENUES件数がいくつあるかを確認する。
# 閉店等での数件程度の意図的な削除は正当な操作なので保存自体は常に許可するが、
# 「空に近いデータで丸ごと上書き」のような壊滅的な減り方だけは異常とみなし、
# 保存はしつつ警告を返す(ブロックはしない。ブロックすると正当な削除の邪魔になるため)。
COUNT_SCRIPT = "const p = require(process.argv[1]); console.log((p.VENUES||[]).length);"


def venue_count(path):
    """壊れたJS/読み込み不能なら None を返す。"""
    try:
        out = subprocess.run(
            ['node', '-e', COUNT_SCRIPT, path],
            capture_output=True, text=True, timeout=10, cwd=DIR
        )
        if out.returncode != 0:
            return None
        return int(out.stdout.strip())
    except Exception:
        return None


class Handler(http.server.SimpleHTTPRequestHandler):
    def reject(self, message):
        body = message.encode('utf-8')
        self.send_response(409)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/save-data':
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8')

        with tempfile.NamedTemporaryFile('w', suffix='.js', dir=DIR, delete=False) as tmp:
            tmp.write(body)
            tmp_path = tmp.name
        try:
            new_count = venue_count(tmp_path)
            if new_count is None:
                self.reject('保存を拒否しました: 送信内容が正しいJSとして読み込めません')
                return
        finally:
            os.remove(tmp_path)

        old_count = venue_count(DATA_FILE)

        with open(DATA_FILE, 'w', encoding='utf-8') as f:
            f.write(body)

        # 半分以下に激減した場合のみ警告(保存自体は行う)。数件程度の意図的な削除は対象外。
        if old_count and new_count < old_count * 0.5:
            resp = f'WARN:店舗数が {old_count} → {new_count} に大きく減りました。意図した変更か確認してください。'.encode('utf-8')
        else:
            resp = 'ok'.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def log_message(self, fmt, *args):
        # 保存イベントだけ分かればよいので通常のアクセスログは静かにする
        if self.path == '/save-data':
            http.server.SimpleHTTPRequestHandler.log_message(self, fmt, *args)


if __name__ == '__main__':
    os.chdir(DIR)
    with http.server.HTTPServer(('localhost', PORT), Handler) as httpd:
        print(f'管理コンソール: http://localhost:{PORT}/admin.html (Ctrl+Cで終了)')
        httpd.serve_forever()
