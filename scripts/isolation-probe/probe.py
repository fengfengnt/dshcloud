#!/usr/bin/env python3
"""容器内探针。每个子命令输出若干行 `key=value`，由宿主侧脚本收集成表。

全部只用标准库，不装任何包 —— 探针本身不该需要出网。
"""
import ctypes
import errno
import os
import socket
import sys


def emit(key, value):
    print("%s=%s" % (key, value))


def errno_name(num):
    return errno.errorcode.get(num, "?")


# ---------------------------------------------------------------- 网络可达性
def cmd_net(argv):
    host, port = argv[0], int(argv[1])
    timeout = float(argv[2]) if len(argv) > 2 else 3.0
    sock = socket.socket()
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        emit("result", "REACHABLE")
    except socket.timeout:
        emit("result", "TIMEOUT")
    except ConnectionRefusedError:
        emit("result", "REFUSED")
    except OSError as exc:
        emit("result", "%s(%s)" % (errno_name(exc.errno), exc.errno))
    finally:
        sock.close()


# ---------------------------------------------------------------- 沙箱链两档
def cmd_userns(_argv):
    """第一档：能不能创建未特权 user namespace。"""
    try:
        os.unshare(os.CLONE_NEWUSER)
    except OSError as exc:
        emit("userns", "%s(%d)" % (errno_name(exc.errno), exc.errno))
        return
    emit("userns", "OK")


def cmd_landlock(_argv):
    """第二档：内核有没有 Landlock。返回 ABI 版本，ENOSYS 就是没有。"""
    libc = ctypes.CDLL(None, use_errno=True)
    ctypes.set_errno(0)
    ret = libc.syscall(444, None, ctypes.c_size_t(0), ctypes.c_uint32(1))
    if ret >= 0:
        emit("landlock", "ABI %d" % ret)
    else:
        num = ctypes.get_errno()
        emit("landlock", "%s(%d)" % (errno_name(num), num))
    # 交叉验证：ENOSYS 说明内核没编进去；LSM 列表是旁证，避免把"被挡"误判成"没有"
    emit("lsm", read_first("/sys/kernel/security/lsm"))


# ---------------------------------------------------------------- 宿主全局数字
class Sysinfo(ctypes.Structure):
    _fields_ = [
        ("uptime", ctypes.c_long),
        ("loads", ctypes.c_ulong * 3),
        ("totalram", ctypes.c_ulong),
        ("freeram", ctypes.c_ulong),
        ("sharedram", ctypes.c_ulong),
        ("bufferram", ctypes.c_ulong),
        ("totalswap", ctypes.c_ulong),
        ("freeswap", ctypes.c_ulong),
        ("procs", ctypes.c_ushort),
        ("pad", ctypes.c_ushort),
        ("totalhigh", ctypes.c_ulong),
        ("freehigh", ctypes.c_ulong),
        ("mem_unit", ctypes.c_uint),
        ("_pad", ctypes.c_char * max(0, 20 - 2 * ctypes.sizeof(ctypes.c_long) - ctypes.sizeof(ctypes.c_int))),
    ]


def read_first(path):
    try:
        with open(path, "r") as handle:
            return handle.readline().strip()
    except OSError as exc:
        return "<%s>" % errno_name(exc.errno)


def cmd_sysinfo(_argv):
    """文件读取路径 vs 直接系统调用 —— 两条路各取一次。"""
    emit("proc_meminfo_memtotal", read_first("/proc/meminfo").split()[1])
    emit("proc_uptime", read_first("/proc/uptime").split()[0])
    info = Sysinfo()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.sysinfo(ctypes.byref(info)) != 0:
        emit("sysinfo2_totalram", "<errno %d>" % ctypes.get_errno())
        emit("sysinfo2_uptime", "<errno %d>" % ctypes.get_errno())
        return
    emit("sysinfo2_totalram", info.totalram * info.mem_unit // 1024)
    emit("sysinfo2_uptime", info.uptime)


def cmd_proc(_argv):
    """八文件对照用的取值。"""
    emit("meminfo", read_first("/proc/meminfo"))
    emit("uptime", read_first("/proc/uptime"))
    try:
        with open("/proc/swaps") as handle:
            swaps = [line for line in handle.read().splitlines() if line.strip()]
        emit("swaps", swaps[1] if len(swaps) > 1 else "none")
    except OSError as exc:
        emit("swaps", "<%s>" % errno_name(exc.errno))
    emit("loadavg", read_first("/proc/loadavg"))
    try:
        with open("/proc/stat") as handle:
            btime = [line for line in handle if line.startswith("btime")]
        emit("stat_btime", btime[0].split()[1] if btime else "none")
    except OSError as exc:
        emit("stat_btime", "<%s>" % errno_name(exc.errno))
    try:
        with open("/proc/cpuinfo") as handle:
            text = handle.read()
        emit("cpuinfo_cores", text.count("processor\t") or text.count("processor"))
        model = [line.split(":", 1)[1].strip() for line in text.splitlines() if line.startswith("model name")]
        emit("cpuinfo_model", model[0] if model else "n/a")
    except OSError as exc:
        emit("cpuinfo_cores", "<%s>" % errno_name(exc.errno))
        emit("cpuinfo_model", "<%s>" % errno_name(exc.errno))
    for path, key in (("/proc/diskstats", "diskstats_lines"), ("/proc/slabinfo", "slabinfo_lines")):
        try:
            with open(path) as handle:
                emit(key, len([line for line in handle if line.strip()]))
        except OSError as exc:
            emit(key, "<%s>" % errno_name(exc.errno))


# ---------------------------------------------------------------- 遮蔽与身份
# 引擎的默认遮蔽/只读列表不写在容器配置里。别猜候选清单 —— 直接从 mountinfo 读：
# 遮蔽的实现是把一个空节点绑到该路径上（root 为 /null 或 /dev/null），
# 只读的实现是把同路径再绑一次并置 ro。这样数出来的条目和引擎无关，可跨版本比。
RO_DEFAULTS = ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"]


def read_mountinfo():
    with open("/proc/self/mountinfo") as handle:
        return [line.split() for line in handle if line.strip()]


def cmd_mask(_argv):
    try:
        rows = read_mountinfo()
    except OSError as exc:
        emit("masked_count", "<%s>" % errno_name(exc.errno))
        emit("readonly_count", "<%s>" % errno_name(exc.errno))
        return

    masked = [f[4] for f in rows if len(f) > 5 and f[3] in ("/null", "/dev/null")]
    masked = sorted(set(masked))
    emit("masked_count", len(masked))
    emit("masked", " ".join(masked) or "none")

    options = {}
    for f in rows:
        if len(f) > 5:
            options[f[4]] = f[5]
    readonly = [p for p in RO_DEFAULTS if "ro" in options.get(p, "").split(",")]
    emit("readonly_count", len(readonly))
    emit("readonly", " ".join(readonly) or "none")


def cmd_dmi(_argv):
    base = "/sys/devices/virtual/dmi/id"
    for name in ("sys_vendor", "product_name", "product_version", "bios_version"):
        emit(name, read_first("%s/%s" % (base, name)))


COMMANDS = {
    "net": cmd_net,
    "userns": cmd_userns,
    "landlock": cmd_landlock,
    "sysinfo": cmd_sysinfo,
    "proc": cmd_proc,
    "mask": cmd_mask,
    "dmi": cmd_dmi,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.stderr.write("用法：probe.py <%s> [参数]\n" % "|".join(COMMANDS))
        sys.exit(2)
    COMMANDS[sys.argv[1]](sys.argv[2:])
