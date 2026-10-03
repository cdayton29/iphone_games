#!/usr/bin/env python3
"""Serve the game locally:  python3 serve.py   then open http://localhost:8000
localhost counts as a secure origin, so the app can be installed from here too."""
import http.server, socketserver, os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
H = http.server.SimpleHTTPRequestHandler
H.extensions_map.update({'.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript'})
with socketserver.ThreadingTCPServer(('', port), H) as s:
    print(f'Space Cadet Pinball running at http://localhost:{port}  (Ctrl+C to stop)')
    s.serve_forever()
