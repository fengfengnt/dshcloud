# 用户旅程：两类人，两条路

> 双列对照：左列是**人看到的**，右列是**平台实际做的**。
> 链路以代码为准（[install.sh](../scripts/install.sh) / [setup-routes.ts](../apps/server/src/http/setup-routes.ts) /
> [forward-auth.ts](../apps/server/src/http/forward-auth.ts) / [provisioner.ts](../apps/server/src/instance/provisioner.ts) /
> [Caddyfile](../docker/instance-image/Caddyfile) / [entrypoint.sh](../docker/instance-image/entrypoint.sh)），
> 隔离性质以 [CONTAINER-ISOLATION-TEST-REPORT](CONTAINER-ISOLATION-TEST-REPORT.md) 的实测为准。
>
> 网页版（带样式、可打印）：[user-journey.html](user-journey.html)。

**装机人**在宿主上跑一次安装，把平台支起来；**普通用户**从邀请链接进来用工作空间。两条路只在「谁发出邀请」这一点上相交。

---

## A · 装机人的旅程（宿主上 · 一次性）

```mermaid
sequenceDiagram
    autonumber
    participant Z as 装机人（终端）
    participant S as 宿主 Docker
    participant B as 浏览器
    participant C as 控制面<br/>（引导态）

    Note over Z,S: A1 跑一行安装
    Z->>S: curl … install.sh | bash
    Note over S: 预检（环境 / 端口 / 存储能力 / firewalld 冲突）<br/>→ 预置存储池 → 取部署资产 → 写 .env<br/>→ 起 Postgres → 迁移 → 起控制面
    Note over Z,S: 这一步一个问题都不问：账号和域名都不归它管
    S-->>Z: 打印一行 "http://<机器地址>:<端口>/setup?token=…"

    Note over Z,C: A2 用浏览器打开那一行
    B->>C: GET /setup?token=…
    C-->>B: 引导页 —— 此刻站上没有账号、也没有域名

    Note over B,C: A3 建管理员、填域名
    B->>C: GET /api/setup/probe（边打字边探泛解析）
    C-->>B: 没解析出来 → 给出要加的两条记录
    B->>C: POST /api/setup { token, baseDomain, email, password }
    Note over C: 先验 token（401）→ 先建号（409）→ 再落域名<br/>顺序反了会留下「域名配好了但没账号」的死局
    C-->>B: consoleDomain
    Note over C,S: 响应刷完之后才重启 —— SIGTERM 会截断没发完的 body<br/>重启后引导口摘掉，控制台落在 console.<域名>

    Note over Z,C: A4 补上实例镜像
    Z->>C: 管理台 → 镜像管理 → 设为默认实例镜像
    Note over Z: 没有默认镜像时平台建不了工作空间<br/>之后日常只剩一条：install.sh 重跑即升级
```

| 步 | 装机人的操作 | 实际发生的事情 |
|---|---|---|
| A1 | 把 README 里那行 `curl … install.sh \| bash` 贴进终端 | 四件事、**顺序不能换**：预检（环境 / 端口 / 存储能力，含 firewalld 冲突探查）→ 预置存储池 → 取部署资产并渲染配置 → 起 Postgres、迁移、起控制面。安装这一步**一个问题都不问**：账号和域名都不归它管 |
| A2 | 复制终端最后打印的那条 `http://<机器地址>:<端口>/setup?token=…`，用浏览器打开 | 此刻平台上**还没有账号也没有域名**，这页是唯一入口，token 是它唯一的凭证 —— 引导态下整站只开着这一条写口（`POST /api/setup`）。重跑安装**不会**换掉它：刻意保留，换了就等于把刚打印给你的链接作废 |
| A3 | 填管理员邮箱、密码、父域；顺手把 `*.<域名>` 的泛解析指过来 | 页面边填边**真探 DNS**，没就绪就直接给出要加的两条记录（只警告不拦，平台判不了 CDN / 反代 / 生效中）。提交后**先验 token、再建号、最后落域名**，然后等响应刷完才重启：引导口摘掉，控制台从此落在 `console.<域名>` |
| A4 | 登录管理台，进「镜像管理」，把实例镜像设为默认 | 没有默认实例镜像时平台建不了工作空间 —— 装机到此才真正可用。之后日常只剩一条命令：`install.sh` 重跑即升级（幂等；除非 `FORCE_SECRETS=1`，**绝不重生成 secret**，换了它所有实例的门 token 全废） |

---

## B · 普通用户的旅程（从邀请到删除）

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户（浏览器）
    participant T as 入口 Traefik<br/>（数据面）
    participant C as 控制面<br/>（console.* 域）
    participant H as 宿主 Docker
    participant I as 实例容器<br/>（slug.* 域）

    Note over U,C: ① 受邀进来的（无公开注册）
    U->>C: 点开邀请链接，设密码
    C-->>U: 会话 cookie（Lax，覆盖父域）

    Note over U,H: ② 建工作空间
    U->>C: 填名字、内存、核数、磁盘、镜像版本 → 创建
    C->>H: 1. 先建数据目录 + XFS 配额（字节+inode）
    Note over C,H: 数据没建成就直接抛错——<br/>绝不建一个指向空目录的实例
    C->>H: 2. 分配宿主回环端口（真探空闲）
    C->>H: 3. 建独立网络 "dsh-net-<slug>"
    C->>H: 4. 建容器 + 启动
    H->>I: 入口脚本起 dsh + Caddy 桥
    C->>T: 5. 落路由：slug.域名 → "127.0.0.1:<port>"
    C-->>U: 建好了，给一个打开按钮

    Note over U,I: ③ 打开工作空间
    U->>T: GET slug.域名/
    T->>C: forward-auth：这个 Host 是谁的？
    alt 未登录
        C-->>T: 302 → 登录页（带 next）
        T-->>U: 跳登录
    else 不是本人
        C-->>T: 403
    else 是主人
        C-->>T: 200 + 注入门 token（按 slug 派生）
        T->>I: 转发到宿主回环端口
        I->>I: Caddy 门①：没有门 token → 403
        I->>I: dsh 门②：注入入口 token，换 cookie
        I-->>U: 工作空间页面（地址栏是裸域名）
    end

    Note over U,I: ④ 日常使用
    U->>I: 编码 agent 装包、跑命令、读写文件
    Note over I: 这些是本职功能，不是要拦的行为；<br/>拦的是它够得着的范围
    I-->>U: 结果、快照、历史会话

    Note over U,C: ⑤ 升级实例镜像
    U->>C: 管理台选新版本
    C->>H: 停容器 → 快照 /data → 落库 → 重建
    Note over C,H: 新镜像起不来 → 自动回滚<br/>（数据回快照、镜像回旧版）

    Note over U,C: ⑥ 删工作空间
    U->>C: 确认删除
    C->>H: 停容器 → 清数据目录、快照、配额账
```

| 步 | 用户的操作 | 实际发生的事情 |
|---|---|---|
| ① | 点开邀请链接、设密码 | 邀请码核销（并发下真正的闸门是邮箱唯一约束）、账号落库；发会话 cookie（Lax、覆盖父域——实例子域上 forward-auth 要读它）。邀请由 A4 之后的装机人在管理台发出 |
| ② | 填名字、内存、核数、磁盘、镜像版本，点创建 | **先有数据再有实例**：建目录 + XFS 配额（字节与 inode 双限，限额失效会拒绝启动）；真探宿主端口空闲；建 `dsh-net-<slug>` 独立网络；建容器并启动。任何一步失败，实例标 error，不会出现「照常跑但数据没了」 |
| ③ | 点「打开工作空间」 | 浏览器进 `slug.域名`。Traefik 每个请求先问控制面：这个子域是谁的？未登录→302 登录页；不是本人→403；是主人→注入按 slug 派生的门 token 再转发。容器里 Caddy 验这个 token（没有→403），再注入 dsh 的入口 token 换成 cookie——此后地址栏一直是裸域名 |
| ④ | 用 agent 干活：装包、跑命令、读写文件 | 全部发生在**一个容器 + 绑定存储**里。网络出得去（装包）、邻居够不着（独立网络）、磁盘有硬限（XFS 配额）、CPU/内存/进程数由 cgroup 限着 |
| ⑤ | 升级实例镜像 | 停容器→快照 `/data`→落库→按新镜像重建。新镜像起不来**自动回滚**：数据回快照、镜像回旧版。升级按实例灰度，不是全站一刀切 |
| ⑥ | 删除 | 数据真删：容器、数据目录、升级快照、配额账一起清 |

## 三道门的位置（配合 B③ 看）

```mermaid
flowchart LR
    U[用户浏览器] -->|HTTPS| T[Traefik 入口]
    T -->|每个请求| FA{{forward-auth<br/>控制面}}
    FA -->|200 + 门 token| T
    T -->|127.0.0.1:port| C1[Caddy 门①<br/>验门 token]
    C1 -->|403 无 token| X1[直连者]
    C1 --> D[dsh 门②<br/>入口 token → cookie]
    D --> W[工作空间]
    X[宿主上别的进程] -.直连回环端口.-> C1
```

- **forward-auth（Traefik→控制面）**：门外第一道，认人。每个请求都过，未登录跳登录、不是本人 403。
- **门①（容器内 Caddy）**：验 Traefik 注入的门 token。它挡的是**宿主上直连回环端口的其他进程**——端口发布在宿主回环上，任何本地进程都够得着，这道门就是给它们准备的。
- **门②（dsh 自己）**：入口 token 换 cookie，让地址栏保持裸域名。

配置住在容器里、实例主人能改——它是有效障碍，但按 [ISOLATION-PLAN](ISOLATION-PLAN.md) 的判据**不计入安全边界**；计入边界的是 forward-auth 和宿主侧那几层。

## 与隔离方案的关系

这个旅程里人**感知不到**的边界，就是 [ISOLATION-PLAN](ISOLATION-PLAN.md) 要维护的东西：

| 旅程中的动作 | 背后的边界（实测过） |
|---|---|
| A3 落域名 | 引导口是引导态下唯一的写口；配好域名即摘掉，`SETUP_TOKEN` 随之失效 |
| B② 创建 | XFS project quota：限 256 MiB 写 400 MiB 停在 256；inode 限 2000 建到第 1998 个被拒 |
| B③ 打开 | 独立网络：邻居 TIMEOUT、ARP 表只剩网关一条 |
| B③ 打开 | 桥端口只发布宿主回环；实例够得到宿主非回环（`:22`）——`--harden-host` 堵的就是这条 |
| B④ 干活 | cgroup：`pids.max`、`memory.max` 与界面设置逐项一致 |
| B④ 干活 | 遮蔽表 13 条写死（含 `/sys/devices/virtual/dmi`——宿主身份不给读） |
| B④ 干活 | 非 root：工作负载以固定 `1000:1000` 跑，`/data` 的属主由平台侧在建容器前递归迁 |
| B④ 干活 | `no-new-privileges`：容器里的 setuid 二进制与文件能力不再提权 |

批 1 的运行时加固（`no-new-privileges` 与非 root 已落定；CapDrop 待做；seccomp 决定不做）全部落在 B② 的「建容器」那一步——所以存量实例要重建一次才带得上，而人在旅程中看到的中断，只是 B③ 打开时慢几秒。
