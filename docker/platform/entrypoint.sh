#!/usr/bin/env bash
#
# 平台镜像的入口。子命令：
#   migrate   跑数据库迁移
#   seed      建第一个管理员（只在「还没有管理员」时生效，可重复跑）
#   domain    改平台域名（写 DB，输出宿主重启命令）
#   serve     起控制面（默认）
#
# compose 里 postgres 有 healthcheck，但那只保证「容器起来了」，不保证「现在能连」——
# 迁移撞上启动竞态会随机失败。这里再兜一层有限重试。
set -euo pipefail

APP_DIR=/app/server

db_reachable() {
  node --input-type=module -e '
import net from "node:net";
const raw = process.env.DATABASE_URL;
if (!raw) process.exit(1);
const url = new URL(raw);
const socket = net.connect({ host: url.hostname, port: Number(url.port || 5432) });
const done = (code) => { socket.destroy(); process.exit(code); };
socket.on("connect", () => done(0));
socket.on("error", () => done(1));
setTimeout(() => done(1), 2000);
' 2>/dev/null
}

wait_for_db() {
  local tries=60
  until db_reachable; do
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then
      echo "等 Postgres 超时（60 秒），DATABASE_URL 指向的还是不通。" >&2
      return 1
    fi
    sleep 1
  done
}

case "${1:-serve}" in
  storage-audit)
    shift
    exec node "$APP_DIR/dist/scripts/storage-audit.js" "$@"
    ;;
  node-agent)
    pool_root=${HOST_STORAGE_ROOT:-/var/lib/dsh}
    lock_path="$pool_root/.dsh-node.lock"
    if [ ! -d "$pool_root" ] || [ -L "$pool_root" ] || [ -L "$lock_path" ]; then
      echo "节点数据池或锁路径不安全，拒绝启动。" >&2
      exit 1
    fi
    if [ -e "$lock_path" ] && [ ! -f "$lock_path" ]; then
      echo "节点锁必须是普通文件。" >&2
      exit 1
    fi
    # Never unlink this file: replacing its inode would permit a second lock holder.
    umask 077
    exec flock --exclusive --nonblock --conflict-exit-code 75 --no-fork "$lock_path" \
      node "$APP_DIR/dist/src/runtime/node/main.js"
    ;;
  migrate)
    wait_for_db
    exec node "$APP_DIR/dist/scripts/migrate.js"
    ;;
  seed)
    wait_for_db
    exec node "$APP_DIR/dist/scripts/seed.js"
    ;;
  domain)
    wait_for_db
    shift
    exec node "$APP_DIR/dist/scripts/domain.js" "$@"
    ;;
  serve)
    wait_for_db
    exec node "$APP_DIR/dist/src/index.js"
    ;;
  *)
    echo "未知子命令：$1（可用：migrate / seed / domain / serve / node-agent / storage-audit）" >&2
    exit 1
    ;;
esac
