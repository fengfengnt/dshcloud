# 容器隔离实测报告：mac（M1 / Docker Desktop） vs linux（Debian 13）

这份报告把 [CONTAINER-ISOLATION-PAPER](CONTAINER-ISOLATION-PAPER.md) 的核心结论拿到**两台完全不同的宿主**上各重测了一遍。
目的不是复现论文的数字，而是分清两件事：哪些结论**不随宿主变**，哪些是**那一台机器的属性**。

两台机器：

- **mac（M1 / Docker Desktop）** —— linuxkit 内核 6.10.14，引擎 28.0.1，8 核 7.7 GiB，无 KVM，没有 lxcfs、没有 runsc。
  它代表「开发机」这一类宿主。
- **linux（Debian 13）** —— 内核 6.12.43，引擎 29.8.0，4 核 7.8 GiB，无 KVM 但有 lxcfs、且引擎里配了 runsc。
  它代表「普通 Linux 服务器」这一类宿主。

结果按论文自己的三层排：**隔离**（谁够得着谁）、**加固**（容器能做什么）、**信息隐藏**（容器能读出宿主的什么）。
每一项左右两列是两台机器各自的实测值与结论，最后一列只做一件事 —— 指出**两台是否一致**，不做额外推断。

三处读法上的提醒：

1. **未测不等于通过。** 某一列写着「未测」的项，只说明**这台机器上测不了**，不代表它安全或不安全。
   为什么测不了，写在每一项的注里，也在 §四 汇总。
2. **两台不同的地方才是重点。** 论文 §4 的第三条纪律是「换运行时或宿主后，既有结论一律重测」——
   标着「两台结论不同」的行，就是这条纪律实际起了作用的地方。用一台机器的结论去推另一台，会错。
3. **§二 第 3 行会推翻一个常见假设。** `--storage-opt size=` 看起来设了配额，实测两台都**不拦**：
   选项被引擎接受、写盘照样写满。这类「设了不生效」比报错更危险，因为它让配置看起来是对的。

复现（两台各跑一次，再合成这份报告）：

```bash
scripts/isolation-probe.sh --label "mac (M1)" --save mac.tsv
ssh <linux 宿主> 'bash isolation-probe.sh --label "linux (Debian 13)" --with-quota --save linux.tsv'
scripts/isolation-probe.sh --merge mac.tsv linux.tsv \
  --labels "mac（M1 / Docker Desktop）","linux（Debian 13）" \
  --intro scripts/isolation-probe/intro.md \
  --out docs/CONTAINER-ISOLATION-TEST-REPORT.md
```

`--with-quota` 会在**那台宿主上**建一个一次性 loop 设备与 XFS 池、写 400 MiB 左右、跑完卸掉；
不加这个开关，第 3b 行就是未测。探针不碰宿主上已有的部署：自己的容器全部打 `isoprobe=1` 标签，退出时按标签删。

> 配套 [CONTAINER-ISOLATION-TEST-PLAN](CONTAINER-ISOLATION-TEST-PLAN.md) 与 [CONTAINER-ISOLATION-PAPER](CONTAINER-ISOLATION-PAPER.md)。表里的每个字都来自探针的原始输出；**未测不等于通过**。

## 一 实验环境

| 项 | mac（M1 / Docker Desktop） | linux（Debian 13） |
|---|---|---|
| 宿主 | Darwin 23.5.0 arm64 | Linux 6.12.43+deb13-amd64 x86_64 |
| 内核（容器视角） | 6.10.14-linuxkit | 6.12.43+deb13-amd64 |
| 引擎 | 28.0.1 | 29.8.0 |
| 存储驱动 / cgroup | overlayfs / v2 | overlayfs / v2 |
| 安全选项 | name=seccomp,profile=unconfined,name=cgroupns | name=apparmor,profile=default,name=seccomp,profile=builtin,name=cgroupns |
| 镜像 digest | python@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285 | python@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285 |
| CPU（宿主） | 8 核 / n/a | 4 核 / Intel(R) Xeon(R) CPU E5-2690 v4 @ 2.60GHz |
| 内存（宿主） | 7.7 GiB | 7.8 GiB |
| 运行时 | io.containerd.runc.v2 runc  | io.containerd.runc.v2 runc runsc  |
| KVM | 无 | 无 |

## 二 实测结果

### 隔离

| # | 测什么 | mac（M1 / Docker Desktop） | linux（Debian 13） | 判据 | 两台对照 |
|---|---|---|---|---|---|
| 1 | 邻居实例的可达性（默认桥 → 独立网络） | 通过 —— 分段生效，只剩网关一条<br><sub>默认桥=REACHABLE，arp 1 条；独立网络=TIMEOUT，arp 1 条</sub> | 通过 —— 分段生效，只剩网关一条<br><sub>默认桥=REACHABLE，arp 1 条；独立网络=TIMEOUT，arp 1 条</sub> | 独立网络应 TIMEOUT 且 arp 无邻居条目 | 两台一致 |
| 2 | 宿主的非回环监听 vs 回环监听 | 开发机上回环也通 —— 回环发布在此不构成边界<br><sub>非回环=REACHABLE；回环=REACHABLE</sub> | 通过 —— 非回环可达、回环被拒<br><sub>非回环=REACHABLE；回环=REFUSED；宿主 :22=REACHABLE</sub> | Linux: 前者可达、后者被拒；开发机: 两条都通 | 两台结论不同 |
| 3 | 可写层配额：--storage-opt 到底约束谁 | 设了不生效 —— 选项被静默接受、写盘不拦（比报错更糟）<br><sub>可写层写出 400MiB；挂载目录写出 400MiB</sub> | 设了不生效 —— 选项被静默接受、写盘不拦（比报错更糟）<br><sub>可写层写出 400MiB；挂载目录写出 400MiB</sub> | 可写层停在限额；挂载目录不受限 | 两台一致 |
| 3b | XFS project quota 的字节 + inode 硬限 | 未测<br><sub>要 Linux 宿主 + root + xfsprogs，且要真写盘；本机加 --with-quota 才跑（/proc/filesystems:  xfs ）</sub> | 通过 —— 字节停在限额、inode 同样被拒；容量视图报的是配额<br><sub>写出 256MiB；容量视图 实例目录 256M / 池子 448M；在 ihard=2000 下，建到第 1998 个零字节文件被拒；pool 创建 32ms / 项目目录 6ms</sub> | 停在限额 + 拒绝超额创建；df 报配额不报池子 | 只有部分宿主测到 |
| 9 | 出网是否受限 | 出网不受限 —— 与论文一致<br><sub>REACHABLE</sub> | 出网不受限 —— 与论文一致<br><sub>REACHABLE</sub> | 容器引擎不提供出网过滤 | 两台一致 |

### 加固

| # | 测什么 | mac（M1 / Docker Desktop） | linux（Debian 13） | 判据 | 两台对照 |
|---|---|---|---|---|---|
| 4 | 沙箱链两档：第一档 bwrap / 第二档 Landlock | 至少一档可用<br><sub>第一档 bwrap=OK；第二档 Landlock=ENOSYS(38)（unconfined 下 ENOSYS(38)）；裸 unshare(CLONE_NEWUSER) 默认=OK / unconfined=OK</sub> | 至少一档可用；宿主 kernel.unprivileged_userns_clone=1<br><sub>第一档 bwrap=FAIL: bwrap: No permissions to create a new namespace, likely beca；第二档 Landlock=ABI 6（unconfined 下 ABI 6）；裸 unshare(CLONE_NEWUSER) 默认=EPERM(1) / unconfined=OK</sub> | 至少一档可用，且完整流程照常 | 两台结论不同 |
| 4b | 用户态内核（runsc）下的两档探测 | 未测<br><sub>本机的 docker 没有 runsc 运行时</sub> | 两档全灭 —— 按失败即拒绝执行的语义，该运行时不能选<br><sub>第一档 bwrap=FAIL: bwrap: loopback: Failed RTM_NEWADDR: No such file or directo；第二档 Landlock=ENOSYS(38)（裸 unshare=OK）；LSM=<ENOENT></sub> | 至少一档可用，且完整流程照常 | 只有部分宿主测到 |
| 5 | Docker 是否把 --pids-limit 落进 cgroup | 通过 —— 运行时认这个参数<br><sub>设置=128；HostConfig=128；容器内=128</sub> | 通过 —— 运行时认这个参数<br><sub>设置=128；HostConfig=128；容器内=128</sub> | 三处一致 | 两台一致 |
| 7 | 引擎的默认遮蔽表（漂移项 /proc/interrupts） | 已取到该 daemon 的完整默认表<br><sub>MaskedPaths 11 条：/proc/asound /proc/acpi /proc/kcore /proc/keys /proc/latency_stats /proc/timer_list /proc/timer_stats /proc/sched_debug /proc/scsi /sys/firmware /sys/devices/virtual/powercap；ReadonlyPaths：/proc/bus /proc/fs /proc/irq /proc/sys /proc/sysrq-trigger；/proc/interrupts **不在默认表里**</sub> | 已取到该 daemon 的完整默认表<br><sub>MaskedPaths 12 条：/proc/acpi /proc/asound /proc/interrupts /proc/kcore /proc/keys /proc/latency_stats /proc/sched_debug /proc/scsi /proc/timer_list /proc/timer_stats /sys/devices/virtual/powercap /sys/firmware；ReadonlyPaths：/proc/bus /proc/fs /proc/irq /proc/sys /proc/sysrq-trigger；/proc/interrupts 在默认表里</sub> | 两台宿主条目应一致；不一致的那条就是要写死进配置的 | 两台一致 |

### 信息隐藏

| # | 测什么 | mac（M1 / Docker Desktop） | linux（Debian 13） | 判据 | 两台对照 |
|---|---|---|---|---|---|
| 6 | 宿主全局数字：文件读取路径 vs sysinfo(2) | 只取到未挂载基线 —— 对照的另一半要装了 lxcfs 的 Linux 宿主<br><sub>未挂载：文件与 sysinfo(2) 同为宿主值 8025700kB</sub> | 通过 —— 文件路径被改写、sysinfo(2) 照旧穿透（只降低可读性，不是边界）<br><sub>同一个已挂载容器：/proc/meminfo 报 2097152kB，而 sysinfo(2) 仍报 8138036kB；uptime 文件 0.34 对 sysinfo 678779</sub> | 同一容器内：文件报限额、sysinfo(2) 仍报宿主值 | 两台结论不同 |
| 8 | DMI：宿主身份可不可读 | 本机没有 DMI 节点（内核没暴露，不是被遮蔽）—— 判不了<br><sub>sys_vendor=<ENOENT>；product=<ENOENT></sub> | 读得到 —— 宿主身份可指纹<br><sub>sys_vendor=Red Hat；product=KVM</sub> | 遮蔽生效则读不到机型 | 两台结论不同 |

## 三 lxcfs 八文件对照（同一容器，挂载前后）

**mac（M1 / Docker Desktop）**

未测 —— 本机没有 /var/lib/lxcfs（开发机装不了），只在 Linux 宿主上取。

**linux（Debian 13）**

| 文件 | 未挂载（宿主值） | 挂载后 | 结论 |
|---|---|---|---|
| meminfo | `MemTotal:        8138036 kB` | `MemTotal:        2097152 kB` | **生效** |
| uptime | `678777.75 2672587.85` | `0.34 0.34` | **生效** |
| swaps | `/dev/vda2                               partition 2097148  780  -2` | `none                                    virtual  2097148 0 0` | **生效** |
| loadavg（前 3 字段） | `0.73 0.38 0.37 ` | `0.84 0.41 0.38 ` | **不生效**（见下注） |
| stat(btime) | `1788955443` | `1788955443` | **不生效** |
| cpuinfo(核数) | `4` | `4` | **不生效** |
| cpuinfo(型号) | `Intel(R) Xeon(R) CPU E5-2690 v4 @ 2.60GHz` | `Intel(R) Xeon(R) CPU E5-2690 v4 @ 2.60GHz` | **不生效** |
| diskstats(行数) | `12` | `12` | **不生效** |
| slabinfo(行数) | `213` | `213` | **不生效** |

9 项里有 3 项真正改变了取值：**meminfo / uptime / swaps**。

`loadavg` 那一行两次取值不同（`0.73…` 对 `0.84…`），但**那不是 lxcfs 改写的** —— 前 3 个字段是
宿主负载透传，两次取值之间宿主负载本来就在动，采样间隔里自己会变。lxcfs 改的是**第 4 个字段**
（运行中 / 总进程数，格式 `… 1/480`）。这一点在论文 §7.2 有另一次采样记录可以对照：
未挂载 `0.50 0.52 0.36 1/480` → 挂载后 `0.50 0.52 0.36 1/481` —— 前 3 个字段逐字相同，只有
第 4 个变了。所以它记**不生效**（负载值透传，仅进程数为容器值）。

> 计数口径：本节 8 个**文件**、9 行（`cpuinfo` 拆了核数与型号两行）。

## 四 未测项

| 项 | 分组 | mac（M1 / Docker Desktop） | linux（Debian 13） |
|---|---|---|---|
| XFS project quota 的字节 + inode 硬限 | 隔离 | 要 Linux 宿主 + root + xfsprogs，且要真写盘；本机加 --with-quota 才跑（/proc/filesystems:  xfs ） | 已测 |
| 用户态内核（runsc）下的两档探测 | 加固 | 本机的 docker 没有 runsc 运行时 | 已测 |
| 应用沙箱链是否真的活（不是内核机制探测） | 加固 | 要跑产品自己的完整流程（起实例→装包→跑命令→快照）；本探针测的是内核与运行时给不给这两档 | 要跑产品自己的完整流程（起实例→装包→跑命令→快照）；本探针测的是内核与运行时给不给这两档 |
| 平台驱动有没有把界面上的进程数上限传给运行时 | 加固 | 本探针是通用探针、不跑平台的流程；这项要在真机上读在跑实例的 HostConfig.PidsLimit | 本探针是通用探针、不跑平台的流程；这项要在真机上读在跑实例的 HostConfig.PidsLimit |
| 执法可绕过（改名 / 换库调用 / 符号链接） | 加固 | 绕过演示要自定义策略，属单独一轮；本机宿主 AppArmor 策略数：0 | 绕过演示要自定义策略，属单独一轮；本机宿主 AppArmor 策略数：1 |
| lxcfs 八文件的「挂载后」对照 | 信息隐藏 | 本机没有 /var/lib/lxcfs（开发机装不了），只在 Linux 宿主上取 | 已测 |

## 五 每项怎么测的

| # | 命令 |
|---|---|
| 1 | `容器内 socket 连邻居:8080；cat /proc/net/arp` |
| 2 | `宿主上起两个 http.server，容器内连 host.docker.internal；另连一次宿主 :22` |
| 3 | `限 256MiB 写 400MiB，分别在可写层与挂载目录各跑一次` |
| 3b | `loop 设备建 XFS + prjquota；限 256MiB/2000 inode，写 400MiB 再灌零字节文件` |
| 9 | `容器内直连一个公网地址的 443` |
| 4 | `容器内跑 bwrap --unshare-all；调 landlock_create_ruleset(444)；再换 seccomp=unconfined 复测` |
| 4b | `同上，换 --runtime runsc` |
| 5 | `--pids-limit 128；读 HostConfig.PidsLimit 与容器内 pids.max` |
| 7 | `对没有显式设置遮罩的容器读 HostConfig.MaskedPaths / ReadonlyPaths` |
| 6 | `读 /proc/meminfo 与 /proc/uptime；再直接调 sysinfo(2)` |
| 8 | `读 /sys/devices/virtual/dmi/id/*` |

## 六 怎么用这份报告

- **标「两台一致」的行** —— 它是这两类宿主共有的性质，可以直接进设计假设。
- **标「两台结论不同」的行** —— 必须按宿主分别判断。用一台的结论去套另一台会错，这正是论文 §4 第三条纪律（换宿主或换运行时，既有结论一律重测）实际起作用的地方。
- **标「未测」的行** —— 不代表通过，只代表这台机器上测不了。要么换一台能测的宿主补上，要么按真实流程单独验一轮。
- **每个数字都能重跑。** 每项的命令在 §五；探针同时会落一份完整原始输出（raw.log），报告里的话一律只写命令与原始输出支持的部分。

