#!/bin/sh
# codefori.sh - Zero-dependency curl-based CLI for Code for IBM i Bridge
# Works on any POSIX shell (Linux, macOS, WSL, IBM i PASE, Git Bash) without Node.js or npm.

set -e

# Detect Home directory across Unix and Windows environments
HOME_DIR="${HOME:-$USERPROFILE}"
BRIDGE_FILE=""

HOST=""
PORT=""
TOKEN=""
JSON_OUTPUT=0
CONFIRM=0
WORKSPACE=""
FILE=""
DEPLOY_METHOD=""
SELECTED_FILES=""
COMMAND=""
ACTION_NAME=""
REMOTE_PATH=""
OBJECT_NAME=""
ENV="ile"
CWD=""
ARGS=""
CLEAR=0

usage() {
  cat << 'EOF'
Usage: codefori.sh [options] <command> [command-options]

Zero-dependency CLI for Code for IBM i Bridge using curl.

Global Options:
  --host <host>          Bridge server host (default: 127.0.0.1)
  -p, --port <port>      Bridge server port (default: from ~/.codefori/bridge.json)
  -t, --token <token>    Authentication token (default: from ~/.codefori/bridge.json)
  --json                 Output machine-parsable JSON
  -h, --help             Show this help message

Commands:
  status                 Check connection and extension health
  list-actions           List available compilation and custom actions
  run-action             Trigger compilation or custom build actions
                         Options: -n, --name <name> (required)
                                  -w, --workspace <idx>
                                  -f, --file <file>
                                  -m, --deploy-method <method>
                                  --confirm
  deploy                 Deploy workspace files to IFS
                         Options: -w, --workspace <idx>
                                  -m, --method <method> (changes, all, staged)
                                  -f, --files <file1,file2...>
  get-deploy-location    Get active remote deployment path
                         Options: -w, --workspace <idx>
  set-deploy-location    Set remote deployment IFS directory
                         Options: -r, --remote <path> (required)
                                  -w, --workspace <idx>
  diagnostics            Fetch active compilation diagnostics & EVFEVENT errors
                         Options: -f, --file <file>
                                  -s, --severity <level>
                                  --clear
  read-eventf            Read and parse EVFEVENT errors for an object
                         Options: -o, --object <name> (required, e.g. MYLIB/MYPGM)
  run-cl                 Execute an IBM i CL command (prompts/requires --confirm by default)
                         Options: -c, --command <cmd> (required)
                                  --confirm
  run-command            Execute arbitrary CL or PASE command
                         Options: -c, --command <cmd> (required)
                                  -e, --env <env> (ile, pase)
                                  --cwd <dir>
                                  --confirm
  connect                Connect to IBM i system
                         Options: -p, --profile <name>
  disconnect             Disconnect active session
  exec-command           Execute arbitrary VS Code command
                         Options: -c, --command <id> (required)
                                  -a, --args <json>
  reset-token            Rotate bridge authentication token
EOF
  exit 0
}

# Parse Global Options and Command
SUBCOMMAND=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      HOST="$2"; shift 2 ;;
    -p|--port)
      PORT="$2"; shift 2 ;;
    -t|--token)
      TOKEN="$2"; shift 2 ;;
    --json)
      JSON_OUTPUT=1; shift ;;
    -h|--help)
      usage ;;
    status|list-actions|run-action|deploy|get-deploy-location|set-deploy-location|diagnostics|read-eventf|run-cl|run-command|connect|disconnect|exec-command|reset-token)
      SUBCOMMAND="$1"; shift; break ;;
    *)
      if [ -z "$SUBCOMMAND" ]; then
        echo "Unknown option or command: $1" >&2
        echo "Run 'codefori.sh --help' for usage." >&2
        exit 1
      fi
      ;;
  esac
done

if [ -z "$SUBCOMMAND" ]; then
  usage
fi

# Parse Subcommand Options
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--name)
      ACTION_NAME="$2"; shift 2 ;;
    -w|--workspace)
      WORKSPACE="$2"; shift 2 ;;
    -f|--file)
      FILE="$2"; shift 2 ;;
    -m|--deploy-method|--method)
      DEPLOY_METHOD="$2"; shift 2 ;;
    --files)
      SELECTED_FILES="$2"; shift 2 ;;
    -r|--remote)
      REMOTE_PATH="$2"; shift 2 ;;
    -o|--object)
      OBJECT_NAME="$2"; shift 2 ;;
    -c|--command)
      COMMAND="$2"; shift 2 ;;
    -e|--env)
      ENV="$2"; shift 2 ;;
    --cwd)
      CWD="$2"; shift 2 ;;
    -a|--args)
      ARGS="$2"; shift 2 ;;
    --clear)
      CLEAR=1; shift ;;
    --confirm)
      CONFIRM=1; shift ;;
    --json)
      JSON_OUTPUT=1; shift ;;
    -h|--help)
      usage ;;
    *)
      # Handle positional parameters for certain commands
      if [ "$SUBCOMMAND" = "read-eventf" ] && [ -z "$OBJECT_NAME" ]; then
        OBJECT_NAME="$1"; shift
      elif [ "$SUBCOMMAND" = "exec-command" ] && [ -z "$ARGS" ]; then
        ARGS="$1"; shift
      else
        shift
      fi
      ;;
  esac
done

# Resolve Host, Port, and Token
if [ -z "$PORT" ] || [ -z "$TOKEN" ]; then
  # Discover bridge.json location across candidate paths
  if [ -z "$BRIDGE_FILE" ] || [ ! -f "$BRIDGE_FILE" ]; then
    for candidate in \
      "${HOME}/.codefori/bridge.json" \
      "${HOME}/.code-for-ibmi-bridge/bridge.json" \
      "${USERPROFILE}/.codefori/bridge.json" \
      "${USERPROFILE}/.code-for-ibmi-bridge/bridge.json"; do
      if [ -n "$candidate" ] && [ -f "$candidate" ]; then
        BRIDGE_FILE="$candidate"
        break
      fi
    done
  fi

  if [ -n "$BRIDGE_FILE" ] && [ -f "$BRIDGE_FILE" ]; then
    if [ -z "$PORT" ]; then
      PORT=$(sed -n 's/.*"port"[ :]*\([0-9][0-9]*\).*/\1/p' "$BRIDGE_FILE" | tr -d '\r' | head -n 1 || true)
    fi
    if [ -z "$TOKEN" ]; then
      TOKEN=$(sed -n 's/.*"token"[ :]*"\([^"]*\)".*/\1/p' "$BRIDGE_FILE" | tr -d '\r' | head -n 1 || true)
    fi
    if [ -z "$HOST" ]; then
      HOST=$(sed -n 's/.*"host"[ :]*"\([^"]*\)".*/\1/p' "$BRIDGE_FILE" | tr -d '\r' | head -n 1 || true)
    fi
  fi
fi

HOST="${HOST:-${CODEFORI_HOST:-127.0.0.1}}"
PORT="${PORT:-${CODEFORI_PORT}}"
TOKEN="${TOKEN:-${CODEFORI_TOKEN}}"

if [ -z "$PORT" ]; then
  echo "Error: Bridge port not specified and could not be discovered from ~/.codefori/bridge.json." >&2
  echo "Make sure the VS Code Bridge server is running, or specify -p, --port <port>." >&2
  exit 1
fi

if [ -z "$TOKEN" ]; then
  echo "Error: Bridge token not specified and could not be discovered from ~/.codefori/bridge.json." >&2
  echo "Make sure the VS Code Bridge server is running, or specify -t, --token <token>." >&2
  exit 1
fi

json_escape() {
  TAB=$(printf '\t')
  printf '%s' "$1" | tr '\r\n' '  ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/${TAB}/\\\\t/g"
}

# Perform HTTP request using curl
make_request() {
  REQ_METHOD="$1"
  REQ_PATH="$2"
  REQ_DATA="$3"

  CURL_CMD="curl -s -S -w \"\nHTTP_STATUS:%{http_code}\" -X \"$REQ_METHOD\""
  CURL_CMD="$CURL_CMD -H \"X-CodeForIBMi-Token: $TOKEN\""
  CURL_CMD="$CURL_CMD -H \"X-CodeForIBMi-Client: codefori-cli\""
  CURL_CMD="$CURL_CMD -H \"Content-Type: application/json\""
  if [ -n "$REQ_DATA" ]; then
    CURL_CMD="$CURL_CMD -d '$REQ_DATA'"
  fi
  CURL_CMD="$CURL_CMD \"http://$HOST:$PORT$REQ_PATH\""

  RESP=$(eval "$CURL_CMD")
  HTTP_STATUS=$(printf '%s\n' "$RESP" | sed -n 's/.*HTTP_STATUS:\([0-9]*\)/\1/p')
  BODY=$(printf '%s\n' "$RESP" | sed 's/HTTP_STATUS:[0-9]*//g')

  if [ "$JSON_OUTPUT" -eq 1 ]; then
    printf '%s\n' "$BODY"
    if [ "$HTTP_STATUS" != "200" ]; then
      exit 1
    fi
    return 0
  fi

  # Pretty format or check error
  if [ "$HTTP_STATUS" != "200" ]; then
    echo "⚠️  [Error $HTTP_STATUS]" >&2
    echo "$BODY" >&2
    exit 1
  fi

  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$BODY" | jq .
  elif command -v node >/dev/null 2>&1; then
    printf '%s\n' "$BODY" | node -e "let d=''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => { try { console.log(JSON.stringify(JSON.parse(d), null, 2)); } catch { console.log(d); } });" 2>/dev/null || printf '%s\n' "$BODY"
  elif command -v python3 >/dev/null 2>&1 && python3 -c "import json" >/dev/null 2>&1; then
    printf '%s\n' "$BODY" | python3 -m json.tool
  elif command -v python >/dev/null 2>&1 && python -c "import json" >/dev/null 2>&1; then
    printf '%s\n' "$BODY" | python -m json.tool
  else
    printf '%s\n' "$BODY"
  fi
}

case "$SUBCOMMAND" in
  status)
    make_request "GET" "/status" ""
    ;;

  list-actions)
    QUERY=""
    [ -n "$WORKSPACE" ] && QUERY="?workspaceIndex=$WORKSPACE"
    make_request "GET" "/actions$QUERY" ""
    ;;

  run-action)
    if [ -z "$ACTION_NAME" ]; then
      echo "Error: -n, --name <actionName> is required for run-action." >&2
      exit 1
    fi
    ESC_NAME=$(json_escape "$ACTION_NAME")
    DATA="{\"actionName\":\"$ESC_NAME\""
    [ -n "$WORKSPACE" ] && DATA="$DATA,\"workspaceIndex\":$WORKSPACE"
    [ -n "$FILE" ] && DATA="$DATA,\"file\":\"$(json_escape "$FILE")\""
    [ -n "$DEPLOY_METHOD" ] && DATA="$DATA,\"deployMethod\":\"$(json_escape "$DEPLOY_METHOD")\""
    [ "$CONFIRM" -eq 1 ] && DATA="$DATA,\"confirm\":true"
    DATA="$DATA}"
    make_request "POST" "/run-action" "$DATA"
    ;;

  deploy)
    DATA="{}"
    PARTS=""
    [ -n "$WORKSPACE" ] && PARTS="${PARTS:+$PARTS,}\"workspaceIndex\":$WORKSPACE"
    [ -n "$DEPLOY_METHOD" ] && PARTS="${PARTS:+$PARTS,}\"method\":\"$(json_escape "$DEPLOY_METHOD")\""
    if [ -n "$SELECTED_FILES" ]; then
      FILES_JSON=""
      for f in $(printf '%s' "$SELECTED_FILES" | tr ',' ' '); do
        FILES_JSON="${FILES_JSON:+$FILES_JSON,}\"$(json_escape "$f")\""
      done
      PARTS="${PARTS:+$PARTS,}\"selectedFiles\":[$FILES_JSON]"
    fi
    [ "$CONFIRM" -eq 1 ] && PARTS="${PARTS:+$PARTS,}\"confirm\":true"
    [ -n "$PARTS" ] && DATA="{$PARTS}"
    make_request "POST" "/deploy" "$DATA"
    ;;

  get-deploy-location)
    QUERY=""
    [ -n "$WORKSPACE" ] && QUERY="?workspaceIndex=$WORKSPACE"
    make_request "GET" "/deploy-location$QUERY" ""
    ;;

  set-deploy-location)
    if [ -z "$REMOTE_PATH" ]; then
      echo "Error: -r, --remote <remotePath> is required for set-deploy-location." >&2
      exit 1
    fi
    DATA="{\"remotePath\":\"$(json_escape "$REMOTE_PATH")\""
    [ -n "$WORKSPACE" ] && DATA="$DATA,\"workspaceIndex\":$WORKSPACE"
    DATA="$DATA}"
    make_request "POST" "/set-deploy-location" "$DATA"
    ;;

  diagnostics)
    if [ "$CLEAR" -eq 1 ]; then
      make_request "POST" "/diagnostics/clear" "{}"
    else
      QUERY=""
      [ -n "$FILE" ] && QUERY="?file=$(json_escape "$FILE")"
      make_request "GET" "/diagnostics$QUERY" ""
    fi
    ;;

  read-eventf)
    if [ -z "$OBJECT_NAME" ]; then
      echo "Error: -o, --object <name> is required for read-eventf." >&2
      exit 1
    fi
    DATA="{\"object\":\"$(json_escape "$OBJECT_NAME")\"}"
    make_request "POST" "/read-eventf" "$DATA"
    ;;

  run-cl)
    if [ -z "$COMMAND" ]; then
      echo "Error: -c, --command <string> is required for run-cl." >&2
      exit 1
    fi
    DATA="{\"command\":\"$(json_escape "$COMMAND")\""
    [ "$CONFIRM" -eq 1 ] && DATA="$DATA,\"confirm\":true"
    DATA="$DATA}"
    make_request "POST" "/run-cl" "$DATA"
    ;;

  run-command)
    if [ -z "$COMMAND" ]; then
      echo "Error: -c, --command <string> is required for run-command." >&2
      exit 1
    fi
    DATA="{\"command\":\"$(json_escape "$COMMAND")\",\"environment\":\"$(json_escape "$ENV")\""
    [ -n "$CWD" ] && DATA="$DATA,\"cwd\":\"$(json_escape "$CWD")\""
    [ "$CONFIRM" -eq 1 ] && DATA="$DATA,\"confirm\":true"
    DATA="$DATA}"
    make_request "POST" "/run-command" "$DATA"
    ;;

  connect)
    DATA="{}"
    [ -n "$COMMAND" ] && DATA="{\"connectionName\":\"$(json_escape "$COMMAND")\"}"
    make_request "POST" "/connect" "$DATA"
    ;;

  disconnect)
    make_request "POST" "/disconnect" "{}"
    ;;

  exec-command)
    if [ -z "$COMMAND" ]; then
      echo "Error: -c, --command <id> is required for exec-command." >&2
      exit 1
    fi
    DATA="{\"commandId\":\"$(json_escape "$COMMAND")\""
    if [ -n "$ARGS" ]; then
      # If args is valid JSON array or object, embed as-is; otherwise string
      case "$ARGS" in
        \[*\]|\{*\})
          DATA="$DATA,\"args\":$ARGS" ;;
        *)
          DATA="$DATA,\"args\":[\"$(json_escape "$ARGS")\"]" ;;
      esac
    fi
    DATA="$DATA}"
    make_request "POST" "/exec-command" "$DATA"
    ;;

  reset-token)
    make_request "POST" "/token/reset" "{}"
    ;;

  *)
    echo "Unknown command: $SUBCOMMAND" >&2
    exit 1
    ;;
esac
