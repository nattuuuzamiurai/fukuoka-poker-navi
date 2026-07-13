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
import json
import os
import subprocess
import tempfile

PORT = 8787
DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(DIR, 'data.js')

# data.js から VENUES/TOURNAMENTS/RECURRING の件数を数えるための小さなNodeスクリプト。
# 複数のブラウザタブを開いていると、古いタブ(まだ少ない店舗数しか読み込んでいない状態)
# からの保存で新しいタブが追加した店舗が消えてしまう事故が実際に起きたため、
# 「店舗数が減る保存」は事故とみなして拒否する安全装置。
COUNT_SCRIPT = (
    "const p = require(process.argv[1]);"
    "console.log(JSON.stringify({"
    "venues: (p.VENUES||[]).length,"
    "tournaments: (p.TOURNAMENTS||[]).length,"
    "recurring: (p.RECURRING||[]).length"
    "}));"
)


def count_entities(path):
    try:
        out = subprocess.run(
            ['node', '-e', COUNT_SCRIPT, path],
            capture_output=True, text=True, timeout=10, cwd=DIR
        )
        if out.returncode != 0:
            return None
        return json.loads(out.stdout.strip())
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
            new_counts = count_entities(tmp_path)
            if new_counts is None:
                self.reject('保存を拒否しました: 送信内容が正しいJSとして読み込めません')
                return
            old_counts = count_entities(DATA_FILE)
            if old_counts and new_counts['venues'] < old_counts['venues']:
                self.reject(
                    f"保存を拒否しました: 店舗数が {old_counts['venues']} → {new_counts['venues']} に減っています"
                    "(古いタブからの保存の可能性)。ページを再読み込みしてからやり直してください。"
                )
                return
        finally:
            os.remove(tmp_path)

        with open(DATA_FILE, 'w', encoding='utf-8') as f:
            f.write(body)
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
