#!/bin/sh
# test-curl.sh - Automated test suite verifying bin/codefori.sh against Code for IBM i Bridge server
set -e

PORT="${CODEFORI_PORT:-5588}"
TOKEN="${CODEFORI_TOKEN:-test-secret-token-1234567890abcdef1234567890abcdef}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_SH="$ROOT_DIR/vscode-bridge/bin/codefori.sh"

echo "--- Testing Zero-Dependency curl script (codefori.sh) against port $PORT ---"

run_cli() {
  "$CLI_SH" -p "$PORT" -t "$TOKEN" "$@"
}

# 1. Status
echo "\n[Curl Test 1] codefori.sh status --json"
OUT=$(run_cli status --json)
echo "$OUT" | grep -E -q '"ready":[[:space:]]*true'
echo "[PASS] status --json returned valid response"

# 2. List Actions
echo "\n[Curl Test 2] codefori.sh list-actions --json"
OUT=$(run_cli list-actions --json)
echo "$OUT" | grep -q 'CRTBNDRPG'
echo "[PASS] list-actions returned actions list"

# 3. Run Action
echo "\n[Curl Test 3] codefori.sh run-action -n \"Create Bound RPG Program (CRTBNDRPG)\""
run_cli run-action -n "Create Bound RPG Program (CRTBNDRPG)" --json | grep -E -q '"success":[[:space:]]*true'
echo "[PASS] run-action executed successfully"

# 4. Run Action with targetFile and deployMethod
echo "\n[Curl Test 4] codefori.sh run-action with -f and -m options"
run_cli run-action -n "Create Bound RPG Program (CRTBNDRPG)" -f "src/myprog.rpgle" -m "changes" --json | grep -q 'src/myprog.rpgle'
echo "[PASS] run-action passed file and deployMethod"

# 5. Deploy Guardrail
echo "\n[Curl Test 5] codefori.sh deploy requires --files or --confirm"
if run_cli deploy -w 0 -m changes --json 2>/dev/null; then
  echo "Expected unconfirmed blanket deploy to fail!" >&2
  exit 1
fi
run_cli deploy -w 0 -m changes --confirm --json | grep -E -q '"success":[[:space:]]*true'
run_cli deploy -w 0 --files "src/myprog.rpgle" --json | grep -E -q '"success":[[:space:]]*true'
echo "[PASS] deploy guardrail correctly required selection/confirmation and succeeded"

# 6. Set & Get Deploy Location
echo "\n[Curl Test 6] codefori.sh set-deploy-location & get-deploy-location"
run_cli set-deploy-location -r "/home/USER/builds/project1" --json | grep -q '/home/USER/builds/project1'
run_cli get-deploy-location --json | grep -q '/home/USER/builds/project1'
echo "[PASS] deploy location configured and retrieved"

# 7. Connect & Disconnect
echo "\n[Curl Test 7] codefori.sh connect & disconnect"
run_cli connect -c "PUB400" --json | grep -E -q '"connectedTo":[[:space:]]*"PUB400"'
run_cli disconnect --json | grep -E -q '"success":[[:space:]]*true'
echo "[PASS] connect and disconnect succeeded"

# 8. Diagnostics
echo "\n[Curl Test 8] codefori.sh diagnostics"
run_cli diagnostics --json | grep -q 'RNF7030'
echo "[PASS] diagnostics retrieved compiler errors"

# 9. Read EVFEVENT
echo "\n[Curl Test 9] codefori.sh read-eventf -o \"MYLIB/TESTPGM\""
run_cli read-eventf -o "MYLIB/TESTPGM" --json | grep -q 'RNF7030'
echo "[PASS] read-eventf retrieved EVFEVENT diagnostics"

# 10. CL Command Guardrail (promptAllClCommands: true)
echo "\n[Curl Test 10] codefori.sh run-cl requires --confirm"
if run_cli run-cl -c "WRKSYSSTS" --json 2>/dev/null; then
  echo "Expected unconfirmed CL command to fail!" >&2
  exit 1
fi
run_cli run-cl -c "WRKSYSSTS" --confirm --json | grep -q 'Executed WRKSYSSTS'
echo "[PASS] run-cl correctly required confirmation and succeeded with --confirm"

# 11. Destructive Command Guardrail
echo "\n[Curl Test 11] codefori.sh run-cl with destructive command requires --confirm"
if run_cli run-cl -c "DLTLIB MYLIB" --json 2>/dev/null; then
  echo "Expected unconfirmed destructive command to fail!" >&2
  exit 1
fi
run_cli run-cl -c "DLTLIB MYLIB" --confirm --json | grep -q 'Executed DLTLIB MYLIB'
echo "[PASS] destructive command required confirmation and succeeded with --confirm"

# 12. QSH Hard Restriction
echo "\n[Curl Test 12] QSH commands strictly blocked"
if run_cli run-command -c "echo hello" -e qsh --json 2>/dev/null; then
  echo "Expected QSH command to be strictly blocked!" >&2
  exit 1
fi
if run_cli run-cl -c "STRQSH CMD('ls')" --confirm --json 2>/dev/null; then
  echo "Expected STRQSH command to be strictly blocked!" >&2
  exit 1
fi
echo "[PASS] QSH environment and STRQSH invocation strictly blocked"

# 12b. PASE Hard Restriction
echo "\n[Curl Test 12b] PASE commands strictly blocked"
if run_cli run-command -c "uname -a" -e pase --json 2>/dev/null; then
  echo "Expected PASE command to be strictly blocked!" >&2
  exit 1
fi
echo "[PASS] PASE environment command strictly blocked"

# 13. Exec Command
echo "\n[Curl Test 13] codefori.sh exec-command"
run_cli exec-command -c "test.validCommand" -a "MYLIB/MYPGM" --json | grep -q 'MYLIB/MYPGM'
echo "[PASS] exec-command succeeded"

# 14. Tab and Quote Escaping in json_escape (Bug 1)
echo "\n[Curl Test 14] json_escape handles tabs, quotes, and newlines portably without dropping field values"
TAB_NAME="Action$(printf '\t')WithTab"
OUT=$(run_cli run-action -n "$TAB_NAME" --json 2>&1 || true)
# Verify it was received by server and not dropped to empty string ("Field 'actionName' is required")
if echo "$OUT" | grep -q "Field 'actionName' is required"; then
  echo "FAIL: Action name containing tab was dropped by json_escape!" >&2
  exit 1
fi
echo "[PASS] json_escape safely preserved action name with tab"

# 15. Bridge Auto-discovery and Fallback Error (Bug 2)
echo "\n[Curl Test 15] codefori.sh bridge.json parsing and port error reporting"
TMP_DIR="$SCRIPT_DIR/tmp_mock_home"
mkdir -p "$TMP_DIR/.codefori"
cat << EOF > "$TMP_DIR/.codefori/bridge.json"
{
  "host": "127.0.0.1",
  "port": $PORT,
  "token": "$TOKEN"
}
EOF
AUTO_OUT=$(CODEFORI_PORT="" CODEFORI_TOKEN="" HOME="$TMP_DIR" USERPROFILE="$TMP_DIR" "$CLI_SH" status --json)
echo "$AUTO_OUT" | grep -E -q '"ready":[[:space:]]*true'
echo "[PASS] bridge auto-discovery from mock bridge.json succeeded"

# When no bridge.json in fake HOME, must error out cleanly, NOT fall back to 5588
ERR_OUT=$(CODEFORI_PORT="" CODEFORI_TOKEN="" HOME="/dev/null" USERPROFILE="/dev/null" "$CLI_SH" status 2>&1 || true)
echo "$ERR_OUT" | grep -q "Bridge port not specified"
rm -rf "$TMP_DIR"
echo "[PASS] bridge auto-discovery and port error handling verified"

# 16. Raw Curl Block Guardrail Test
echo "\n[Curl Test 16] Direct raw curl without X-CodeForIBMi-Client header is blocked"
RAW_OUT=$(curl -s -S -X GET "http://127.0.0.1:$PORT/status" -H "X-CodeForIBMi-Token: $TOKEN" 2>&1 || true)
echo "$RAW_OUT" | grep -q "Direct raw curl/HTTP access to the bridge server is disabled"
echo "[PASS] direct raw curl safely blocked with 403 and guidance"

echo "\n========================================================"
echo " ALL CURL SCRIPT VERIFICATION TESTS PASSED! (100%)"
echo "========================================================"
