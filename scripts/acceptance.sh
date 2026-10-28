#!/usr/bin/env bash
# End-to-end acceptance gate for relabeld. Run from repo root.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
fail=0
step() { printf '\n== %s ==\n' "$1"; }
check() { if [ "$1" -eq 0 ]; then echo "PASS: $2"; else echo "FAIL: $2"; fail=1; fi; }

step "build"
npm run build >/tmp/relabel-build.log 2>&1; check $? "tsc build clean"
tail -3 /tmp/relabel-build.log

step "tests"
node --test test/ >/tmp/relabel-test.log 2>&1; check $? "node --test test/"
grep -E "^# (pass|fail|tests)" /tmp/relabel-test.log | tail -3

step "cli version/help"
node dist/cli.js --version >/dev/null 2>&1; check $? "relabeld --version"
node dist/cli.js --help >/dev/null 2>&1; check $? "relabeld --help"

step "scan fixture (json)"
if [ -d test/fixtures/demo-app ]; then
  node dist/cli.js scan test/fixtures/demo-app --json >/tmp/relabel-scan.json 2>/dev/null
  check $? "scan --json exit 0"
  python3 - <<'PY' && check 0 "scan JSON valid" || check 1 "scan JSON valid"
import json
d = json.load(open('/tmp/relabel-scan.json'))
assert isinstance(d.get('findings'), list) and d.get('brandTokens')
print('scannedFiles=%s findings=%s assets=%s' % (d.get('scannedFiles'), len(d.get('findings', [])), len(d.get('assets', []))))
PY
else
  echo "SKIP: test/fixtures/demo-app missing"; fail=1
fi

step "recipes"
node dist/cli.js recipe list >/dev/null 2>&1; check $? "recipe list"

step "report render"
if [ -f demo/reports/verify.json ]; then
  node dist/cli.js report --input demo/reports/verify.json --out /tmp/relabel-report.html >/dev/null 2>&1; check $? "report from demo verify.json"
  ext=$(grep -oE 'https?://' /tmp/relabel-report.html | wc -l); [ "$ext" -eq 0 ]; check $? "report has no external refs ($ext)"
fi

step "packaging"
npm pack --dry-run >/tmp/relabel-pack.log 2>&1; check $? "npm pack --dry-run"
grep -E "Tarball Contents|package size|unpacked size" /tmp/relabel-pack.log | head -3

step "action + workflows yaml"
python3 - <<'PY'
import yaml
ok = True
for f in ["action.yml", ".github/workflows/ci.yml", ".github/workflows/publish.yml"]:
    try:
        yaml.safe_load(open(f)); print("yaml ok:", f)
    except Exception as e:
        print("yaml FAIL:", f, e); ok = False
raise SystemExit(0 if ok else 1)
PY
check $? "action/workflows parse"

step "docker build (optional)"
if command -v docker >/dev/null && [ -f Dockerfile ] && [ "${SKIP_DOCKER:-0}" != "1" ]; then
  docker build -q -t relabeld:accept . >/tmp/relabel-docker.log 2>&1; check $? "docker build"
else
  echo "SKIP: docker build (SKIP_DOCKER=1 or no Dockerfile)"
fi

step "mcp tools/list (stdio smoke)"
python3 - <<'PY'
import json, subprocess, sys
req = {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"acc","version":"0"}}}
p = subprocess.Popen(["node","dist/cli.js","mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
out, _ = p.communicate(json.dumps(req)+"\n", timeout=20)
ok = '"result"' in out and 'protocolVersion' in out
print("mcp initialize ok" if ok else out[:300])
sys.exit(0 if ok else 1)
PY
check $? "mcp initialize"

printf '\n== RESULT: %s ==\n' "$([ $fail -eq 0 ] && echo ALL-PASS || echo FAILURES)"
exit $fail
