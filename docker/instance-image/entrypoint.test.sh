#!/bin/sh
set -eu

cd "$(dirname "$0")"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home"

cat > "$tmp/bin/dsh" <<'EOF'
#!/bin/sh
echo 'dsh web: http://127.0.0.1:3080/?token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
sleep 5
EOF

cat > "$tmp/bin/node" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > "$CAPTURE"
echo 'dsh web: http://127.0.0.1:3080/?token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
sleep 5
EOF

cat > "$tmp/bin/caddy" <<'EOF'
#!/bin/sh
exit 0
EOF

chmod +x "$tmp/bin/dsh" "$tmp/bin/node" "$tmp/bin/caddy"

CAPTURE="$tmp/args" HOME="$tmp/home" DSH_PORT=3080 \
  PATH="$tmp/bin:$PATH" ./entrypoint.sh >"$tmp/run.log" 2>&1 || true

expected="--expose-internals
$tmp/bin/dsh
web"
actual=$(sed -n '1,3p' "$tmp/args" 2>/dev/null || true)
[ "$actual" = "$expected" ] || {
  echo "entrypoint 必须用 node --expose-internals 启动 dsh web" >&2
  cat "$tmp/run.log" >&2
  exit 1
}
