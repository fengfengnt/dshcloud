#!/usr/bin/env bash
#
# 隔离实测探针 —— docs/CONTAINER-ISOLATION-TEST-PLAN.md 的可执行版。
#
# 在任意一台有 docker 的宿主上跑，输出那张表（编号 / 测什么 / 命令 / 原始输出 / 判据命中 / 结论）。
# 全部动作都是自己起一次性容器，不碰宿主上已有的部署；退出时按 label 清干净。
#
# 两台以上宿主各跑一次并 --save，再用 --merge 合成左右对照的报告。
#
# 会写盘的只有 XFS project quota 那一项（默认不跑，加 --with-quota），
# 它用一次性 loop 设备 + 临时目录，退出时卸干净。
#
# 用法：
#   scripts/isolation-probe.sh [--image <镜像>] [--out <报告>] [--save <tsv>] [--label <名字>] [--with-quota]
#   scripts/isolation-probe.sh --merge a.tsv b.tsv [--labels "mac (M1),linux (Debian 13)"] [--out <报告>]
set -uo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROBE_SRC="$SELF_DIR/isolation-probe/probe.py"

IMAGE="python:3.13-slim"
OUT=""
SAVE=""
LABEL_NAME=$(hostname -s 2>/dev/null || echo host)
WITH_QUOTA=0
TAG="isoprobe"
NET_A="$TAG-neta"
NET_B="$TAG-netb"
SUBNET_A="10.99.101.0/24"
SUBNET_B="10.99.102.0/24"

if [ "${1:-}" = "--merge" ]; then
  shift
  exec python3 "$SELF_DIR/isolation-probe/merge.py" "$@"
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --save) SAVE="$2"; shift 2 ;;
    --label) LABEL_NAME="$2"; shift 2 ;;
    --with-quota) WITH_QUOTA=1; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

STAMP=$(date +%Y%m%d-%H%M%S)
RUN_ROOT="${TMPDIR:-/tmp}"; RUN_ROOT="${RUN_ROOT%/}"
RUN_DIR="$RUN_ROOT/isolation-probe-$STAMP"
# 挂载进容器的目录要放在开发机默认共享的路径下（/tmp → /private/tmp），
# 放在 $TMPDIR（/var/folders/...）里 docker 挂不进去。
BIND_DIR="/tmp/isolation-probe-$STAMP"
mkdir -p "$RUN_DIR"
LOG="$RUN_DIR/raw.log"
TSV="$RUN_DIR/results.tsv"
[ -n "$OUT" ] || OUT="$RUN_DIR/report.md"
: >"$LOG"; : >"$TSV"

HOST_PIDS=(); ROWS=(); UNTESTED=(); ENV_ROWS=(); FILE_ROWS=()
GROUP="其他"

note() { printf '\033[1m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m警告：\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m错误：\033[0m %s\n' "$*" >&2; exit 1; }

# 表格单元格：压成一行、转义竖线。不按字节截断 —— 会把 UTF-8 字符切坏。
cell() { printf '%s' "$1" | tr '\n' ' ' | sed 's/|/\\|/g'; }

# TSV 是两台机器之间唯一的交换格式，字段里的制表符/换行必须先抹掉
tf() { printf '%s' "$1" | tr '\t\n' '  '; }
tline() { local out="" f; for f in "$@"; do out="$out$(tf "$f")"$'\t'; done; printf '%s\n' "${out%$'\t'}"; }

add_env()  { ENV_ROWS+=("| $1 | $(cell "$2") |"); tline E "$1" "$2" >>"$TSV"; }
add_row()  { ROWS+=("| $1 | $2 | \`$(cell "$3")\` | $(cell "$4") | $5 | $6 |"); tline R "$1" "$GROUP" "$2" "$3" "$4" "$5" "$6" >>"$TSV"; }
add_skip() { UNTESTED+=("| $2 | $(cell "$3") |"); tline S "$1" "$GROUP" "$2" "$3" >>"$TSV"; }
add_file() { FILE_ROWS+=("| $1 | \`$2\` | \`$3\` | $4 |"); tline F "$GROUP" "$1" "$2" "$3" "$4" >>"$TSV"; }

# ---------------------------------------------------------------- docker 封装
DOCKER_EXTRA_HOST=()
if [ "$(uname -s)" = "Linux" ]; then
  DOCKER_EXTRA_HOST=(--add-host=host.docker.internal:host-gateway)
fi

dtmp() { # 起一个待命容器：dtmp <名字> [docker run 的额外参数...]
  local name="$1"; shift
  docker run -d --name "$name" --label "$TAG=1" "$@" "$IMAGE" sleep 900 >/dev/null
}

dexec() { local name="$1"; shift; docker exec "$name" "$@" 2>&1 || true; }
put_probe() { docker cp "$PROBE_SRC" "$1:/probe.py" >/dev/null 2>&1 || true; }
ipof() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1" 2>/dev/null; }
pick() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -1; }
# dd 写到限额时会失败，但报错文案随 locale 变 —— 只认"写出去多少"，不认那句话
dd_records() { printf '%s' "$1" | sed -n 's/^\([0-9][0-9]*\)+.*records out.*/\1/p' | head -1; }

cleanup() {
  for pid in "${HOST_PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  local ids
  ids=$(docker ps -aq --filter "label=$TAG=1" 2>/dev/null)
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1
  docker network rm "$NET_A" "$NET_B" >/dev/null 2>&1
  [ "${QUOTA_MOUNTED:-0}" = "1" ] && umount "$QUOTA_MNT" >/dev/null 2>&1
  [ -n "${QUOTA_DEV:-}" ] && losetup -d "$QUOTA_DEV" >/dev/null 2>&1
  [ -n "${QUOTA_DIR:-}" ] && rm -rf "$QUOTA_DIR"
  rm -rf "$BIND_DIR"
}
trap cleanup EXIT

command -v docker >/dev/null || die "找不到 docker"
docker info >/dev/null 2>&1 || die "docker 连不上"
[ -f "$PROBE_SRC" ] || die "找不到探针：$PROBE_SRC"
tline L "$LABEL_NAME"

note "准备镜像（$IMAGE）"
docker pull -q "$IMAGE" >/dev/null 2>&1 || warn "拉取镜像失败，继续用本地已有的"

# ================================================================ §一 环境
note "§一 采集环境"
collect_env() {
  local facts kernel cgroup secopts digest
  facts=$(dtmp "$TAG-env" && put_probe "$TAG-env" && dexec "$TAG-env" python3 /probe.py proc)
  kernel=$(docker info --format '{{.KernelVersion}}' 2>/dev/null)
  cgroup=$(docker info --format '{{.CgroupVersion}}' 2>/dev/null)
  secopts=$(docker info --format '{{join .SecurityOptions ","}}' 2>/dev/null)
  digest=$(docker inspect --format '{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null)
  {
    echo "host=$(uname -s) $(uname -r) $(uname -m)"
    echo "docker_server=$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
    echo "kernel=$kernel"
    echo "os=$(docker info --format '{{.OperatingSystem}}' 2>/dev/null)"
    echo "storage_driver=$(docker info --format '{{.Driver}}' 2>/dev/null)"
    echo "cgroup=v$cgroup"
    echo "security_options=$secopts"
    echo "image_digest=$digest"
    echo "host_cpu_cores=$(pick "$facts" cpuinfo_cores)"
    echo "host_cpu_model=$(pick "$facts" cpuinfo_model)"
    echo "host_memtotal_kb=$(pick "$facts" meminfo | awk '{print $2}')"
  } >>"$LOG" 2>&1

  add_env "宿主" "$(uname -s) $(uname -r) $(uname -m)"
  add_env "内核（容器视角）" "$kernel"
  add_env "引擎" "$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  add_env "存储驱动 / cgroup" "$(docker info --format '{{.Driver}}' 2>/dev/null) / v$cgroup"
  add_env "安全选项" "$secopts"
  add_env "镜像 digest" "$digest"
  add_env "CPU（宿主）" "$(pick "$facts" cpuinfo_cores) 核 / $(pick "$facts" cpuinfo_model)"
  add_env "内存（宿主）" "$(pick "$facts" meminfo | awk '{printf "%.1f GiB", $2/1048576}')"
  add_env "运行时" "$(docker info --format '{{range $k,$v := .Runtimes}}{{$k}} {{end}}' 2>/dev/null)"
  add_env "KVM" "$(docker run --rm --label "$TAG=1" "$IMAGE" sh -c 'test -e /dev/kvm && echo 有 || echo 无' 2>/dev/null)"
  docker rm -f "$TAG-env" >/dev/null 2>&1
}
collect_env

# ================================================================ 隔离
GROUP="隔离"

note "§二-1 实例 ↔ 实例：分段前后对照"
check_segmentation() {
  local a="$1" b="$2" tag="$3"
  put_probe "$a"; put_probe "$b"
  docker exec -d "$a" python3 -m http.server 8080 --bind 0.0.0.0 >/dev/null 2>&1
  sleep 1
  local ipa out arp
  ipa=$(ipof "$a")
  out=$(dexec "$b" python3 /probe.py net "$ipa" 8080 3)
  arp=$(dexec "$b" cat /proc/net/arp)
  echo "[$tag] $b -> $a($ipa):$(pick "$out" result)" >>"$LOG"
  echo "[$tag] $b /proc/net/arp:" >>"$LOG"; printf '%s\n' "$arp" >>"$LOG"
  printf '%s|%s' "$(pick "$out" result)" "$(printf '%s\n' "$arp" | tail -n +2 | grep -c .)"
}

dtmp "$TAG-a1"
dtmp "$TAG-b1"
seg_bridge=$(check_segmentation "$TAG-a1" "$TAG-b1" "默认桥")
seg_bridge_result="${seg_bridge%%|*}"; seg_bridge_arp="${seg_bridge##*|}"

docker network create --subnet "$SUBNET_A" "$NET_A" >/dev/null 2>&1
docker network create --subnet "$SUBNET_B" "$NET_B" >/dev/null 2>&1
dtmp "$TAG-a2" --network "$NET_A"
dtmp "$TAG-b2" --network "$NET_B"
seg_iso=$(check_segmentation "$TAG-a2" "$TAG-b2" "每实例一网络")
seg_iso_result="${seg_iso%%|*}"; seg_iso_arp="${seg_iso##*|}"

add_row 1 "邻居实例的可达性（默认桥 → 独立网络）" \
  "容器内 socket 连邻居:8080；cat /proc/net/arp" \
  "默认桥=$seg_bridge_result，arp $seg_bridge_arp 条；独立网络=$seg_iso_result，arp $seg_iso_arp 条" \
  "独立网络应 TIMEOUT 且 arp 无邻居条目" \
  "$([ "$seg_iso_result" = "TIMEOUT" ] && [ "$seg_iso_arp" = "1" ] && echo "通过 —— 分段生效，只剩网关一条" || echo "推翻 —— 跨实例仍可达")"

note "§二-2 实例 → 宿主：宿主上哪些监听在射程内"
check_host_reach() {
  if ! command -v python3 >/dev/null; then
    add_skip 2 "实例 → 宿主" "宿主上没有 python3，起不了监听"
    return
  fi
  local target bind_any p_any p_lo r_any r_lo r_ssh="" ssh_note="" verdict
  if [ "$(uname -s)" = "Darwin" ]; then
    target="host.docker.internal"; bind_any="0.0.0.0"
  else
    target=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null)
    # 非回环那一侧绑到桥网关，不在公网口上开端口
    bind_any="$target"
  fi
  [ -n "$target" ] || { add_skip 2 "实例 → 宿主" "取不到桥网关地址"; return; }

  p_any=$(python3 -c 'import socket;s=socket.socket();s.bind(("0.0.0.0",0));print(s.getsockname()[1]);s.close()')
  p_lo=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
  python3 -m http.server "$p_any" --bind "$bind_any" >/dev/null 2>&1 &
  HOST_PIDS+=($!); disown 2>/dev/null || true
  python3 -m http.server "$p_lo" --bind 127.0.0.1 >/dev/null 2>&1 &
  HOST_PIDS+=($!); disown 2>/dev/null || true
  sleep 1

  local c="$TAG-a1"
  put_probe "$c"
  r_any=$(pick "$(dexec "$c" python3 /probe.py net "$target" "$p_any" 3)" result)
  r_lo=$(pick "$(dexec "$c" python3 /probe.py net "$target" "$p_lo" 3)" result)
  echo "[实例->宿主] $target 非回环:$p_any=$r_any  回环:$p_lo=$r_lo" >>"$LOG"

  if [ "$(uname -s)" != "Darwin" ]; then
    r_ssh=$(pick "$(dexec "$c" python3 /probe.py net "$target" 22 3)" result)
    echo "[实例->宿主] $target:22=$r_ssh" >>"$LOG"
    ssh_note="；宿主 :22=$r_ssh"
  fi

  if [ "$(uname -s)" = "Darwin" ]; then
    verdict=$([ "$r_lo" = "REACHABLE" ] && echo "开发机上回环也通 —— 回环发布在此不构成边界" || echo "回环不可达 —— 与论文的开发机结论不一致，需复测")
  else
    if [ "$r_any" = "REACHABLE" ] && [ "$r_lo" = "REFUSED" ]; then
      verdict="通过 —— 非回环可达、回环被拒"
    else
      verdict="与预期不符 —— 看原始输出"
    fi
  fi
  add_row 2 "宿主的非回环监听 vs 回环监听" \
    "宿主上起两个 http.server，容器内连 $target；另连一次宿主 :22" \
    "非回环=$r_any；回环=$r_lo$ssh_note" \
    "Linux: 前者可达、后者被拒；开发机: 两条都通" "$verdict"
}
check_host_reach

note "§二-3 配额：上限落在文件系统的分配路径上吗"
check_quota() {
  local lim=256 write=400 layer mounted a_rec b_rec verdict
  mkdir -p "$BIND_DIR"
  layer=$(docker run --rm --label "$TAG=1" --storage-opt size="${lim}m" "$IMAGE" \
    sh -c "dd if=/dev/zero of=/f bs=1M count=$write 2>&1; df -h / | tail -1" 2>&1)
  mounted=$(docker run --rm --label "$TAG=1" --storage-opt size="${lim}m" -v "$BIND_DIR:/q" "$IMAGE" \
    sh -c "dd if=/dev/zero of=/q/f bs=1M count=$write 2>&1; df -h /q | tail -1" 2>&1)
  printf '[配额/storage-opt] 可写层 size=%sm 写 %sMiB：\n%s\n' "$lim" "$write" "$layer" >>"$LOG"
  printf '[配额/storage-opt] 挂载宿主目录，同参数：\n%s\n' "$mounted" >>"$LOG"
  a_rec=$(dd_records "$layer"); b_rec=$(dd_records "$mounted")

  if printf '%s' "$layer" | grep -qi "error response from daemon\|invalid option\|not supported"; then
    verdict="本机不支持 --storage-opt"
  elif [ -z "$a_rec" ]; then
    verdict="未测 —— dd 没跑出结果"
  elif [ "$a_rec" -lt "$write" ]; then
    if [ -n "$b_rec" ] && [ "$b_rec" -lt "$write" ]; then
      verdict="异常 —— 挂载目录也被拦，与论文不符，复测"
    else
      verdict="通过 —— 限额落在可写层，对挂载目录无效（与论文一致）"
    fi
  else
    verdict="设了不生效 —— 选项被静默接受、写盘不拦（比报错更糟）"
  fi

  add_row 3 "可写层配额：--storage-opt 到底约束谁" \
    "限 ${lim}MiB 写 ${write}MiB，分别在可写层与挂载目录各跑一次" \
    "可写层写出 ${a_rec:-?}MiB；挂载目录写出 ${b_rec:-?}MiB" \
    "可写层停在限额；挂载目录不受限" "$verdict"

  check_xfs_quota
}

check_xfs_quota() {
  if [ "$WITH_QUOTA" != "1" ] || [ "$(uname -s)" != "Linux" ] || [ "$(id -u)" != "0" ] || ! command -v mkfs.xfs >/dev/null; then
    local xfs
    xfs=$(docker run --rm --label "$TAG=1" "$IMAGE" sh -c 'grep -w xfs /proc/filesystems || echo "无"' 2>&1 | tr -s '[:space:]' ' ')
    add_skip 3b "XFS project quota 的字节 + inode 硬限" \
      "要 Linux 宿主 + root + xfsprogs，且要真写盘；本机加 --with-quota 才跑（/proc/filesystems: $xfs）"
    return
  fi

  # 注意：不能写成 local a=/x b="$a/y" —— bash 先把整行的 $a 展开再赋值，set -u 下会炸
  local dir mnt img dev prjid=4242
  dir=/var/tmp/$TAG-quota-$STAMP
  mnt="$dir/mnt"; img="$dir/pool.img"
  local lim=256 write=400 incl_bytes t_pool t_inst t0 t1 rec dfview ifail created
  mkdir -p "$mnt"
  QUOTA_DIR="$dir"; QUOTA_MNT="$mnt"; QUOTA_IMG="$img"; QUOTA_MOUNTED=0

  t0=$(date +%s%N)
  truncate -s 512M "$img" && dev=$(losetup -f --show "$img")
  QUOTA_DEV="$dev"
  { [ -n "${dev:-}" ] && mkfs.xfs -f -q "$dev" && mount -o prjquota "$dev" "$mnt"; } || {
    add_skip 3b "XFS project quota 的字节 + inode 硬限" "loop 设备或 XFS 挂载失败，看原始输出"
    echo "[XFS] 准备失败 dev=$dev" >>"$LOG"
    return
  }
  QUOTA_MOUNTED=1
  t1=$(date +%s%N); t_pool=$(( (t1 - t0) / 1000000 ))

  mkdir -p "$mnt/inst"
  t0=$(date +%s%N)
  xfs_quota -x -c "project -s -p $mnt/inst $prjid" "$mnt" >>"$LOG" 2>&1
  xfs_quota -x -c "limit -p bhard=${lim}m ihard=2000 $prjid" "$mnt" >>"$LOG" 2>&1
  t1=$(date +%s%N); t_inst=$(( (t1 - t0) / 1000000 ))

  # inode 那一半必须先测：先把字节灌满的话，连目录项都写不进去，inode 限额就测不出来了
  mkdir -p "$mnt/inst/many"
  created=0
  for _ in $(seq 1 2600); do
    : >"$mnt/inst/many/f$created" 2>/dev/null || break
    created=$((created + 1))
  done
  if [ "$created" -ge 2600 ]; then
    ifail="建满 2600 个零字节文件都没被拦 —— inode 限额没生效"
  else
    ifail="在 ihard=2000 下，建到第 $created 个零字节文件被拒"
  fi
  printf '[XFS] inode: %s\n' "$ifail" >>"$LOG"
  rm -rf "$mnt/inst/many"

  incl_bytes=$(dd if=/dev/zero of="$mnt/inst/f" bs=1M count=$write 2>&1)
  rec=$(dd_records "$incl_bytes")
  dfview="实例目录 $(df -h "$mnt/inst" | tail -1 | awk '{print $2}') / 池子 $(df -h "$mnt" | tail -1 | awk '{print $2}')"
  printf '[XFS] pool=%sms inst=%sms 写出=%sMiB df=%s\n' "$t_pool" "$t_inst" "${rec:-?}" "$dfview" >>"$LOG"

  local verdict
  if [ -z "$rec" ]; then
    verdict="未测 —— dd 没跑出结果"
  elif [ "$rec" -lt "$write" ] && [ "$created" -lt 2600 ]; then
    verdict="通过 —— 字节停在限额、inode 同样被拒；容量视图报的是配额"
  elif [ "$rec" -lt "$write" ]; then
    verdict="字节限额生效，但 inode 没拦住 —— 只限一半"
  else
    verdict="推翻 —— 写满了 ${write}MiB，限额没生效"
  fi
  add_row "3b" "XFS project quota：字节 + inode 双限" \
    "loop 设备建 XFS + prjquota；限 ${lim}MiB/2000 inode，写 ${write}MiB 再灌零字节文件" \
    "写出 ${rec:-?}MiB；容量视图 $dfview；$ifail；pool 创建 ${t_pool}ms / 项目目录 ${t_inst}ms" \
    "停在限额 + 拒绝超额创建；df 报配额不报池子" "$verdict"
}
check_quota

# ================================================================ 加固
GROUP="加固"

note "§二-4 沙箱链两档"
sandbox_probe_of() { # 容器名 -> "userns|landlock|lsm"
  local c="$1" u l
  put_probe "$c"
  u=$(dexec "$c" python3 /probe.py userns)
  l=$(dexec "$c" python3 /probe.py landlock)
  printf '%s|%s|%s' "$(pick "$u" userns)" "$(pick "$l" landlock)" "$(pick "$l" lsm)"
}
sandbox_verdict() { # bwrap landlock
  if [ "$1" = "OK" ] || [ "${2#ABI}" != "$2" ]; then echo "至少一档可用"; else echo "两档全灭 —— 按失败即拒绝执行的语义，该运行时不能选"; fi
}

# 第一档的实体是 bubblewrap 本身，不是裸的 unshare 调用 —— 两者不等价。
# 必须带 --ro-bind / / ：bwrap 会新建 mount namespace，不 bind 根就看不到 /bin/true，
# 那会报成"bwrap 坏了"，其实是调用姿势不对（踩过一次）。
bwrap_probe() {
  dexec "$1" sh -c 'command -v bwrap >/dev/null 2>&1 || { command -v apt-get >/dev/null 2>&1 || { echo NOAPT; exit 0; }; apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq bubblewrap >/dev/null 2>&1; }; command -v bwrap >/dev/null 2>&1 || { echo NOBWRAP; exit 0; }; if out=$(bwrap --unshare-all --die-with-parent --ro-bind / / -- /bin/true 2>&1); then echo OK; else echo "FAIL: $(printf "%s" "$out" | head -1 | cut -c1-60)"; fi'
}

check_sandbox() {
  local c="$TAG-sandbox" g="$TAG-gvisor" std gv std_u std_l std_lsm rest bw
  local userns_sysctl userns_aa_sysctl
  userns_sysctl=$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || echo "无此项")
  userns_aa_sysctl=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo "无此项")

  dtmp "$c"
  std=$(sandbox_probe_of "$c")
  std_u=${std%%|*}; rest=${std#*|}; std_l=${rest%%|*}; std_lsm=${rest#*|}
  bw=$(bwrap_probe "$c")

  # 交叉验证：userns 的 EPERM 是内核挡的，还是运行时 profile 挡的
  local c3="$TAG-noseccomp" ns_probe std_u_ns std_l_ns rest_ns
  docker run -d --name "$c3" --label "$TAG=1" --security-opt seccomp=unconfined "$IMAGE" sleep 900 >/dev/null 2>&1
  ns_probe=$(sandbox_probe_of "$c3")
  std_u_ns=${ns_probe%%|*}; rest_ns=${ns_probe#*|}; std_l_ns=${rest_ns%%|*}
  printf '[沙箱链] userns: 默认=%s / seccomp=unconfined=%s；landlock=%s / %s；bwrap=%s；LSM=%s\n' \
    "$std_u" "$std_u_ns" "$std_l" "$std_l_ns" "$bw" "$std_lsm" >>"$LOG"
  printf '[沙箱链] userns sysctl: unprivileged_userns_clone=%s apparmor_restrict_unprivileged_userns=%s\n' \
    "$userns_sysctl" "$userns_aa_sysctl" >>"$LOG"

  local sysctl_note=""
  [ "$userns_sysctl" != "无此项" ] && sysctl_note="；宿主 kernel.unprivileged_userns_clone=$userns_sysctl"
  add_row 4 "沙箱链两档：第一档 bwrap / 第二档 Landlock" \
    "容器内跑 bwrap --unshare-all；调 landlock_create_ruleset(444)；再换 seccomp=unconfined 复测" \
    "第一档 bwrap=$bw；第二档 Landlock=$std_l（unconfined 下 $std_l_ns）；裸 unshare(CLONE_NEWUSER) 默认=$std_u / unconfined=$std_u_ns" \
    "至少一档可用，且完整流程照常" \
    "$(sandbox_verdict "$bw" "$std_l")$sysctl_note"
  docker rm -f "$c" "$c3" >/dev/null 2>&1

  if docker info --format '{{range $k,$v := .Runtimes}}{{$k}} {{end}}' 2>/dev/null | grep -qw runsc; then
    dtmp "$g" --runtime runsc
    gv=$(sandbox_probe_of "$g")
    local gv_u gv_l gv_lsm rest2 gbw
    gv_u=${gv%%|*}; rest2=${gv#*|}; gv_l=${rest2%%|*}; gv_lsm=${rest2#*|}
    gbw=$(bwrap_probe "$g")
    printf '[沙箱链/用户态内核] %s bwrap=%s\n' "$gv" "$gbw" >>"$LOG"
    add_row "4b" "用户态内核（runsc）下的两档" \
      "同上，换 --runtime runsc" \
      "第一档 bwrap=$gbw；第二档 Landlock=$gv_l（裸 unshare=$gv_u）；LSM=$gv_lsm" \
      "至少一档可用，且完整流程照常" \
      "$(sandbox_verdict "$gbw" "$gv_l")"
    docker rm -f "$g" >/dev/null 2>&1
  else
    add_skip 4b "用户态内核（runsc）下的两档探测" "本机的 docker 没有 runsc 运行时"
  fi

  add_skip appchain "应用沙箱链是否真的活（不是内核机制探测）" \
    "要跑产品自己的完整流程（起实例→装包→跑命令→快照）；本探针测的是内核与运行时给不给这两档"
}
check_sandbox

note "§二-5 参数是否真传下去"
check_param() {
  local c="$TAG-pids" want=128 got_host got_inner
  docker run -d --name "$c" --label "$TAG=1" --pids-limit "$want" "$IMAGE" sleep 900 >/dev/null 2>&1
  got_host=$(docker inspect -f '{{.HostConfig.PidsLimit}}' "$c" 2>/dev/null)
  got_inner=$(dexec "$c" sh -c 'cat /sys/fs/cgroup/pids.max 2>/dev/null || cat /sys/fs/cgroup/pids/pids.max 2>/dev/null' | head -1 | tr -d '\r')
  echo "[参数] 设置=$want HostConfig=$got_host 容器内=$got_inner" >>"$LOG"
  add_row 5 "Docker 是否把 --pids-limit 落进 cgroup" \
    "--pids-limit 128；读 HostConfig.PidsLimit 与容器内 pids.max" \
    "设置=$want；HostConfig=$got_host；容器内=$got_inner" \
    "三处一致" \
    "$([ "$got_inner" = "$want" ] && [ "$got_host" = "$want" ] && echo "通过 —— 运行时认这个参数" || echo "推翻 —— 设了不生效")"
  add_skip 5 "平台驱动有没有把界面上的进程数上限传给运行时" \
    "本探针是通用探针、不跑平台的流程；这项要在真机上读在跑实例的 HostConfig.PidsLimit"
  docker rm -f "$c" >/dev/null 2>&1
}
check_param

note "§三 默认遮蔽表与宿主身份"
check_extras() {
  local c="$TAG-extras" mask dmi masked_count intr aa profiles masked_default readonly_default
  dtmp "$c"
  put_probe "$c"
  mask=$(dexec "$c" python3 /probe.py mask)

  # 默认遮蔽表不在容器里，但"没显式设置遮罩"的容器，inspect 出来的就是该 daemon 的默认值。
  # 这是跨版本唯一可比的读法：按 /null 挂载点去数只能认出被遮蔽的**文件**，
  # 被遮蔽的**目录**是另一种形态，会漏（踩过一次）。
  local masked_default readonly_default
  masked_default=$(docker inspect -f '{{join .HostConfig.MaskedPaths " "}}' "$c" 2>/dev/null)
  readonly_default=$(docker inspect -f '{{join .HostConfig.ReadonlyPaths " "}}' "$c" 2>/dev/null)
  masked_count=$(printf '%s' "$masked_default" | wc -w | tr -d ' ')
  case " $masked_default " in *" /proc/interrupts "*) intr="在默认表里" ;; *) intr="**不在默认表里**" ;; esac
  printf '[加固] daemon 默认 MaskedPaths(%s 条): %s\n[加固] daemon 默认 ReadonlyPaths: %s\n' \
    "$masked_count" "$masked_default" "$readonly_default" >>"$LOG"
  printf '[加固] 容器内实测挂上的遮蔽挂载：%s\n' "$(printf '%s\n' "$mask" | tr '\n' ' ')" >>"$LOG"

  add_row 7 "引擎的默认遮蔽表（漂移项 /proc/interrupts）" \
    "对没有显式设置遮罩的容器读 HostConfig.MaskedPaths / ReadonlyPaths" \
    "MaskedPaths $masked_count 条：$masked_default；ReadonlyPaths：$readonly_default；/proc/interrupts $intr" \
    "两台宿主条目应一致；不一致的那条就是要写死进配置的" \
    "$([ "${masked_count:-0}" -gt 0 ] && echo "已取到该 daemon 的完整默认表" || echo "取不到 —— 该 daemon 不把默认值写进 HostConfig")"

  # AppArmor 要在宿主上看才准，容器里看不到宿主加载了哪些策略
  profiles=$(ls /sys/kernel/security/apparmor/profiles 2>/dev/null | wc -l | tr -d ' ')
  aa=$(ls /sys/kernel/security/apparmor/profiles 2>/dev/null | tr '\n' ' ')
  printf '[加固] 宿主 apparmor profiles=%s: %s\n' "$profiles" "$aa" >>"$LOG"
  add_skip bypass "执法可绕过（改名 / 换库调用 / 符号链接）" \
    "绕过演示要自定义策略，属单独一轮；本机宿主 AppArmor 策略数：$profiles"

  dmi=$(dexec "$c" python3 /probe.py dmi)
  printf '%s\n' "$dmi" >>"$LOG"
  docker rm -f "$c" >/dev/null 2>&1
  return 0
}
check_extras

GROUP="信息隐藏"
note "§二-6 信息隐藏：八文件对照 + sysinfo(2) 绕过"
check_hidden() {
  local c="$TAG-proc" raw unmounted mounted_sys hidden_mounted=no
  # 两个容器都要带上限额 —— 否则"挂载后"报的就是宿主值（= 没有限额），对照没意义
  dtmp "$c" --memory 2g --cpus 1
  put_probe "$c"
  raw=$(dexec "$c" python3 /probe.py proc)
  unmounted=$(dexec "$c" python3 /probe.py sysinfo)
  printf '%s\n%s\n' "$raw" "$unmounted" >>"$LOG"

  local mounted=""
  if [ "$(uname -s)" = "Linux" ] && [ -d /var/lib/lxcfs/proc ]; then
    local c2="$TAG-lxcfs" mounts=() f
    for f in /var/lib/lxcfs/proc/*; do [ -e "$f" ] && mounts+=(-v "$f:/proc/$(basename "$f"):ro"); done
    docker run -d --name "$c2" --label "$TAG=1" --memory 2g --cpus 1 "${mounts[@]}" "$IMAGE" sleep 900 >/dev/null 2>&1
    put_probe "$c2"
    mounted=$(dexec "$c2" python3 /probe.py proc)
    mounted_sys=$(dexec "$c2" python3 /probe.py sysinfo)
    printf '[信息隐藏] 挂载了 %s 个 lxcfs 文件\n%s\n' "${#mounts[@]}" "$mounted" >>"$LOG"
    printf '[信息隐藏] 同一个已挂载容器里的 sysinfo(2)：\n%s\n' "$mounted_sys" >>"$LOG"
    hidden_mounted=yes
    docker rm -f "$c2" >/dev/null 2>&1
  fi

  # 结尾的 :N 表示"只比前 N 个字段"——loadavg 的三个负载值是透传的，
  # 只有进程数不同，整行比较会把它误判成生效（踩过一次）
  local names="meminfo:meminfo uptime:uptime swaps:swaps loadavg:loadavg:3 stat(btime):stat_btime cpuinfo(核数):cpuinfo_cores cpuinfo(型号):cpuinfo_model diskstats(行数):diskstats_lines slabinfo(行数):slabinfo_lines"
  if [ "$hidden_mounted" = "yes" ]; then
    local k label key nf va vb v
    for k in $names; do
      label="${k%%:*}"; key="${k#*:}"; nf=""
      case "$key" in *:*) nf="${key##*:}"; key="${key%%:*}";; esac
      va=$(pick "$raw" "$key"); vb=$(pick "$mounted" "$key")
      if [ -n "$nf" ]; then
        label="$label（仅前 $nf 个字段）"
        va=$(printf '%s' "$va" | awk -v n="$nf" '{for(i=1;i<=n;i++)printf "%s ", $i}')
        vb=$(printf '%s' "$vb" | awk -v n="$nf" '{for(i=1;i<=n;i++)printf "%s ", $i}')
      fi
      [ "$va" = "$vb" ] && v="不生效" || v="生效"
      add_file "$label" "$va" "$vb" "$v"
    done
  else
    add_skip lxcfs "lxcfs 八文件的「挂载后」对照" "本机没有 /var/lib/lxcfs（开发机装不了），只在 Linux 宿主上取"
  fi

  local file_vs_call
  if [ "$hidden_mounted" = "yes" ]; then
    file_vs_call="同一个已挂载容器：/proc/meminfo 报 $(pick "$mounted" meminfo | awk '{print $2}')kB，而 sysinfo(2) 仍报 $(pick "$mounted_sys" sysinfo2_totalram)kB；uptime 文件 $(pick "$mounted" uptime | awk '{print $1}') 对 sysinfo $(pick "$mounted_sys" sysinfo2_uptime)"
  else
    file_vs_call="未挂载：文件与 sysinfo(2) 同为宿主值 $(pick "$unmounted" proc_meminfo_memtotal)kB"
  fi
  local hidden_verdict
  if [ "$hidden_mounted" != "yes" ]; then
    hidden_verdict="只取到未挂载基线 —— 对照的另一半要装了 lxcfs 的 Linux 宿主"
  elif [ "$(pick "$mounted" meminfo | awk '{print $2}')" != "$(pick "$mounted_sys" sysinfo2_totalram)" ]; then
    hidden_verdict="通过 —— 文件路径被改写、sysinfo(2) 照旧穿透（只降低可读性，不是边界）"
  else
    hidden_verdict="文件与 sysinfo 取值一致 —— 与论文不符，复测"
  fi
  add_row 6 "宿主全局数字：文件读取路径 vs sysinfo(2)" \
    "读 /proc/meminfo 与 /proc/uptime；再直接调 sysinfo(2)" \
    "$file_vs_call" \
    "同一容器内：文件报限额、sysinfo(2) 仍报宿主值" \
    "$hidden_verdict"
  docker rm -f "$c" >/dev/null 2>&1
}
check_hidden

GROUP="信息隐藏"
check_dmi() {
  local c="$TAG-dmi" dmi sv dmi_verdict
  dtmp "$c"; put_probe "$c"
  dmi=$(dexec "$c" python3 /probe.py dmi)
  printf '%s\n' "$dmi" >>"$LOG"
  docker rm -f "$c" >/dev/null 2>&1
  sv=$(pick "$dmi" sys_vendor)
  if [ "$sv" = "<ENOENT>" ]; then
    dmi_verdict="本机没有 DMI 节点（内核没暴露，不是被遮蔽）—— 判不了"
  elif [ "${sv#<}" != "$sv" ]; then
    dmi_verdict="读不到：$sv —— 要确认是遮蔽还是权限"
  else
    dmi_verdict="读得到 —— 宿主身份可指纹"
  fi
  add_row 8 "DMI：宿主身份可不可读" \
    "读 /sys/devices/virtual/dmi/id/*" \
    "sys_vendor=$sv；product=$(pick "$dmi" product_name)" \
    "遮蔽生效则读不到机型" "$dmi_verdict"
}
check_dmi

GROUP="隔离"
check_egress() {
  local c="$TAG-egress" egress
  dtmp "$c"; put_probe "$c"
  egress=$(pick "$(dexec "$c" python3 /probe.py net 1.1.1.1 443 5)" result)
  docker rm -f "$c" >/dev/null 2>&1
  echo "[隔离] 出网 1.1.1.1:443=$egress" >>"$LOG"
  add_row 9 "出网是否受限" "容器内直连一个公网地址的 443" \
    "$egress" "容器引擎不提供出网过滤" \
    "$([ "$egress" = "REACHABLE" ] && echo "出网不受限 —— 与论文一致" || echo "出网被挡 —— 与论文不一致，记下")"
}
check_egress

# ================================================================ 出报告
note "写报告：$OUT"
[ -n "$SAVE" ] && cp "$TSV" "$SAVE" && note "TSV：$SAVE"
{
  echo "# 容器隔离实测报告"
  echo
  echo "- 生成时间：$(date '+%Y-%m-%d %H:%M:%S')"
  echo "- 宿主：$(uname -s) $(uname -r) $(uname -m)"
  echo "- 原始输出：\`$LOG\`"
  echo
  echo "> 配套 [CONTAINER-ISOLATION-TEST-PLAN](../docs/CONTAINER-ISOLATION-TEST-PLAN.md)。"
  echo "> 结论只写命令与原始输出支持的部分；**未测不等于通过**。"
  echo
  echo "## 一 环境"
  echo
  echo "| 项 | 取值 |"
  echo "|---|---|"
  printf '%s\n' ${ENV_ROWS[@]+"${ENV_ROWS[@]}"}
  echo
  echo "## 二 结果"
  echo
  echo "| # | 测什么 | 命令 | 原始输出 | 判据 | 结论 |"
  echo "|---|---|---|---|---|---|"
  printf '%s\n' ${ROWS[@]+"${ROWS[@]}"}
  if [ "${#FILE_ROWS[@]}" -gt 0 ]; then
    echo
    echo "## 三 lxcfs 八文件对照（同一容器，挂载前后）"
    echo
    echo "| 文件 | 未挂载（宿主值） | 挂载后 | 结论 |"
    echo "|---|---|---|---|"
    printf '%s\n' ${FILE_ROWS[@]+"${FILE_ROWS[@]}"}
  fi
  if [ "${#UNTESTED[@]}" -gt 0 ]; then
    echo
    echo "## 四 未测项"
    echo
    echo "| 项 | 为什么本机测不了 |"
    echo "|---|---|"
    printf '%s\n' ${UNTESTED[@]+"${UNTESTED[@]}"}
  fi
} >"$OUT"

cat "$OUT"
echo
note "报告：$OUT"
note "原始输出：$LOG"
