# 容器视角的文献与行业结论：隔离 / 安全 / 隐藏

> 2026-09-17。只收**读到的、且改变或支撑过我们判断的**，按三条线组织：**隔离**（边界在哪）、
> **安全**（加固的效力与边界）、**隐藏**（信息泄漏、指纹、侧信道）。microVM 只作为对照出现。
> 每条写「它说了什么 → 对我们的意思」。**证据强度逐条标注**：
> 🟢 一手实测 / 🔵 标准与官方文档 / 🟣 学术论文 / 🟡 厂商或二手文章。
>
> ⚠️ 一条自我约束：**没有一篇是"针对 dsh 这个负载"做的**。我们自己的量（lxcfs 八文件表、
> 沙箱链两档、gVisor 两档全灭、配额与网络那些数字）仍然是唯一针对本平台的一手证据。

## 一、隔离：边界在哪，什么会被打穿

### 1.1 容器是"隔离但不设防"，而且 agent 会主动找路

**🟣 《Quantifying Frontier LLM Capabilities for Container Sandbox Escape》**（SANDBOXESCAPEBENCH，
arXiv 2603.02277）。威胁模型一句话写得很直白：**"一个有 shell 权限、有动机的对抗性 agent"**。
基准覆盖四类逃逸：配置错误、权限分配失误、内核缺陷、运行时/编排弱点；结论是
"**一旦有漏洞，模型能识别并利用**"。

→ **这就是我们的威胁模型**（实例里跑的是会写代码、会读文档、会试错的 agent）。它把
[ISOLATION-POSITIONING](ISOLATION-POSITIONING.md) §2.2 写的"实例 = 不可信代码执行环境"
从一句设计口号变成了有基准支撑的假设：**不要假设 agent 不会找路，要假设它会。**

**🟣 《A Container Security Survey: Exploits, Attacks, and Defenses》**（ACM Computing Surveys,
2025）。把容器攻击按配置错误 / 内核漏洞 / 运行时与编排缺陷 / 镜像与供应链分类，逐类给防御。
⚠️ **诚实说明：全文在付费墙后**（ACM 403），我只读到题录与摘要层面的信息，**没有逐条核对它的分类**，
所以这里不引用它的具体结论，只记一条线索。

**🟣 《Uncovering Threats in Container Systems: A Study on Misconfigured Container Components in
the Wild》**（IEEE Access, 2024）。互联网规模扫描 + 一个校园网实测（扫 150,235 个 IP）：
找到 **1,003,947 个配置错误且暴露的容器组件** —— 多数跑着默认配置和过期版本，出现在知名机构、
政府与企业里；从中找出 5 个"泄漏敏感信息或可远程执行代码"的漏洞。

→ **对我们的意思**：加固清单不是形式主义。**默认配置在生产里就是被打的那一批** ——
这也是我们那张待补清单（CapDrop / ReadonlyPaths）必须补的实证理由。
`no-new-privileges` 已补、工作负载已改为固定非 root（属主由平台侧在建容器前递归迁，[D39](DECISIONS.md)），
两项都在 2026-09-17 落定；seccomp 收紧**决定不做**，理由见 [ISOLATION-PLAN](ISOLATION-PLAN.md)。

### 1.2 边界等于运行时 + 宿主，容器内部不算

**🔵 NIST SP 800-190** 的五层是 **镜像 / 仓库 / 编排器 / 容器运行时 / 宿主 OS** ——
**没有一层是"容器内部"**。**🟡 Docker 官方**那篇的标题就是 *Runtime Enforcement, Not Runtime
Advice*，正文一句「提示词能影响行为，运行时能限制行为」。

**🟣 一个真实 CVE 把这条讲透了**：CVE-2026-25725（GHSA-ff64-7w26-62rf，high，2026-02）——
某个编码 agent 的 bubblewrap 沙箱**没保护自己的配置文件**，因为那文件在启动时**不存在**；
沙箱里的代码自己建了它、注入钩子，重启后以**宿主权限**执行。

→ **结构教训**：一个沙箱的**配置与状态住在它约束的那段可写空间里**，它就不是边界。
直接推论：**dsh 自己的沙箱链（bwrap / Landlock）对我们的边界零贡献** —— 它是产品功能。
这也顺带说明 gVisor 那条"沙箱链两档全灭"是**功能**问题，不是安全取舍。

## 二、安全：加固的效力与边界

### 2.1 补丁节奏是运营侧主导变量，可能比"选哪类隔离"更值钱

**🟣 《AI Code Sandboxes: A Comparative Security Study》**（arXiv 2606.08433，2026-06）。
五款 AI 沙箱、三类架构（microVM / 用户态内核 / OCI 容器）、六个轴（攻击面、信息泄漏、
纵深可叠加性、CVE 史、补丁节奏、上游 fuzzing）。两个结论：

- **属性按"架构类"分开，不按"产品"分开** —— 选哪一类决定大部分性质；
- **产品的 pin 策略是运营侧的主导变量**：引擎侧补丁约 **0 天**，而下游滞后 **0 天 → 471+ 天 →
  不透明 → 无限**都有。它还把"最强组合"（microVM × 持续公开 fuzzer）标成**样本里没人占**的空位。

→ **对我们的意思**：这一条把我们待办清单里"内核 / dockerd / runc / containerd 的补丁节奏"
从一条运维杂项**提成了高杠杆项** —— 它比"要不要换运行时"更能改变我们的实际风险。

### 2.2 内核强制控制不能与进程名检测混同

**纠正**：此前把 AppArmor、seccomp 与基于进程名的检测统称为可通过改名绕过的机制，这是错误的。
seccomp 在内核过滤系统调用，不依赖二进制名称；换名、换库或直接调用同一被拒 syscall 不会使其获准。
AppArmor 的安全性需要评估策略附着、覆盖及转换；不能从某份策略的绕过推导所有强制访问控制无效。

**🔵 Qualys 公告（2025-03）**：Ubuntu 用 AppArmor 限制未特权 user namespace，
结果有**三个绕过** —— `aa-exec`（切进带 `userns,` 的既有 profile）、**busybox**（默认安装里唯一
profile 允许建 userns 的程序）、`LD_PRELOAD`（经 nautilus）。

→ **对我们的意思**：seccomp/LSM 都是宿主强制控制，应测试实际生效和业务兼容；上述公告仅证明具体策略的缺陷。
限制 userns 的 sysctl 也需检查内核支持，并会影响 bubblewrap，不能不经验证全局关闭。

### 2.3 限制未特权 userns 是一笔真实的收益，代价是打断 bubblewrap

**🟡 systemshardening** 引的实测：限制未特权 user namespace 后，未特权进程够得着的内核操作从
**27/40 降到 8/40（3.4 倍攻击面差异）**，其中 43% 集中在 netfilter/nf_tables；代价是打断
**rootless 容器、bubblewrap（连带 Flatpak）、浏览器渲染进程沙箱**。文章的定位是：
userns 不是安全边界，而是**攻击面放大器**。

→ **对我们的意思**：这基本解开了我们那个老疑问 —— 真机上 `unshare -U` 的 `EPERM`
**很可能是宿主主动收紧**（而不是 Docker 的 seccomp：开发机上默认 profile 下 `unshare -U` 是成功的）。
那么"救 bwrap"就等于**拆掉宿主上的一层加固**。这件事的正确落法不是去救，而是把代价写清楚。

## 三、隐藏：宿主信息、指纹、侧信道

### 3.1 内核明确拒绝修"宿主全局数字"，生态的答案就是 FUSE 覆盖层

**🔵 LKML（2012）**：有人提"让 `/proc/meminfo` 按调用者的 memcg 报数"（*meminfo: show
/proc/meminfo base on container's memcg*），**被 NAK**。理由值得记住：

- `/proc/meminfo` **会影响库的行为**，不只是应用 —— 所以不能靠"重写用到它的程序"绕过；
- 维护者推荐的替代路线是 **FUSE 覆盖 procfs**（也就是今天的 lxcfs）。

**🔵 lxcfs issue #43**：托管商用 `htop` 看到**宿主**的活动，认为这是安全泄漏，要求 LXC 往
"VMware/qemu 那种更强隔离"走。issue 被**关掉、没有答复**。

→ **对我们的意思**：① 我们走的那条路（lxcfs + 只挂量过真生效的三个文件）**是内核维护者当年
指的方向**，不是土办法；② lxcfs 项目的定位从头到尾是**资源可见性**，不是隔离 —— 与我们的实测
（八文件里三个生效、`sysinfo(2)` 绕得开）完全一致。

### 3.2 `uptime` 与 `btime` 其实**内核能伪造** —— 卡在 Docker 不给用（本轮最重要的发现）

- **🔵 time namespace**（Linux 5.6，`CONFIG_TIME_NS`）虚拟化 `CLOCK_MONOTONIC` /
  `CLOCK_BOOTTIME`，官方 man page 明确把 **`/proc/uptime` 列进受影响范围**。
- **🔵 内核补丁 `fs/proc: apply the time namespace offset to /proc/stat btime`** ——
  **`btime` 也随时间命名空间走**。
- **🔵 但 Docker 直到 29.5 才给容器建 time namespace**，而且维护者原话是
  **"the time namespace affects monotonic time only"**，**没有暴露 offsets**
  （moby issue #39163、PR #52577，2026-05）。

→ **对我们的意思**，三条：

1. 我们在文档里写的"`btime` 收不掉"**要精修**：准确说法是**lxcfs 收不掉、Docker 也不给**，
   但**内核有这个机制**。
2. 它比 lxcfs 强的地方：**这是真值伪造（内核层），不是 FUSE 伪装** —— 连直接调
   `sysinfo(2)` 的程序也一起管（我们实测过 sysinfo 的 uptime 绕开了 lxcfs）。
3. 要吃到它，得绕开 Docker 的封装（runc 直连 / 等 Docker 暴露 offsets）—— **这是我们"隐藏"
   这一层目前最好的升级路径**，优先级高于继续找更多 lxcfs 文件。

### 3.3 侧信道不止 `/proc`，而且虚拟化不解决它

- **🟣** 跨容器**与跨 VM** 的 page-cache 计时侧信道（arXiv 2607.17518）：覆盖 Docker / gVisor /
  Kata（QEMU、Cloud Hypervisor、Firecracker），结论是**虚拟化改变泄漏形态、不消除它**；
  缓解是"直接 I/O + 专用块设备能显著衰减甚至消除信号"。
- **🟣** 用**共享内核锁的争用**量化隔离（arXiv 2507.21248）：文件系统 journal 与内核页分配器
  是最常见的干扰源。
- **🟣 KernelSnitch（NDSS '25）**：从**用户态**用系统调用计时侧信道读出**内核数据结构
  （哈希表/树）的占用率** —— 攻击者是"未特权、被隔离的"。
- **🟣** CPU 频率传感器可以**指纹容器镜像**（arXiv 2404.10715）：并发多容器下 **84.5% 准确率**，
  云上**不到 40 秒、准确率 >70%**；缓解手段是**噪声注入**。

→ **对我们的意思**：**"藏干净"在共享硬件上做不到**。我们那条定位（"降低可读性，不是边界"）
是对的，但要再加一句：**连 CPU 频率遥测都在泄漏工作负载身份，而这跟 `/proc` 一点关系都没有**。

**🟡 一条待查线索**：**CPU namespace**（IBM / AMD，LCA Kernel 2022）—— 提案是让容器里的
`/proc/cpuinfo`、`lscpu` 不再泄漏宿主 CPU 拓扑（正是我们量到"`cpuinfo` 遮不住"的那一格）。
`cpu_namespace.html` 已 404，PDF 是压缩流读不出正文，**合并状态未能核实** —— 只作为线索记下。

### 3.4 "隐藏"这条线的文献本身很薄 —— 这本身是个结论

搜 anti-fingerprinting / "隐藏容器化环境"基本没有正经研究；"容器指纹匿名"只有零星工作
（一篇中文的 SaaS 容器指纹匿名 + 网络欺骗）。→ 与我们之前的行业调研一致：
**主流加固清单不认"信息泄漏面"，学术上也没有对应的成熟领域**。
所以这一层我们只能靠自己的实测推进，没有现成的最佳实践可抄。

## 四、这三条线各自落到我们哪个决策上

| 结论 | 落到哪 |
|---|---|
| 威胁模型是"有动机、有 shell 的 agent"，且它会找路 | [ISOLATION-POSITIONING](ISOLATION-POSITIONING.md) §2.2 |
| 边界 = 运行时 + 宿主，容器内部不算；沙箱链不算边界 | [ISOLATION-TIERS](ISOLATION-TIERS.md) §〇 / §五 |
| 补丁节奏是高杠杆项 | ISOLATION-TIERS §四、§七 第 9 步 |
| seccomp 只算纵深；限制 userns 用 sysctl | ISOLATION-TIERS §三、§八 #1 |
| 配额与加固不是形式主义（真实世界 100 万个暴露组件） | ISOLATION-TIERS §三、[SECURITY-HARDENING](SECURITY-HARDENING.md) |
| uptime / btime 有内核级机制（time namespace），卡在 Docker | ISOLATION-TIERS §八、本文 §3.2 |
| 侧信道收不干净，"降低可读性"的定位要保留并加一条 | ISOLATION-TIERS §六、[SECURITY-HARDENING](SECURITY-HARDENING.md) |
| 隐藏这一层没有现成最佳实践，靠自己测 | 本文 §3.4 |
