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

PORT = 8787
DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(DIR, 'data.js')


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/save-data':
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8')
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
