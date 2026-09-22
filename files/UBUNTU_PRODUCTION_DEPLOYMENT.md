# dshcloud Ubuntu 生产服务器部署指南

> 适用范围：当前仓库的生产 Compose 与 `scripts/install.sh` 部署路径。
>
> 当前项目仍处于早期阶段，上游明确说明它尚未完成生产验证和全部安全工作。请只部署在专用、可重建的 Linux 主机或虚拟机上，不要与现有业务、数据库、反向代理或其他 Docker 工作负载混部。首次正式承载数据前，必须完成本文的重启、备份恢复和安全验收。

## 1. 部署结果与主机改动

安装后会运行以下容器：

| 服务 | 镜像 | 作用 |
| --- | --- | --- |
| `postgres` | `postgres:16-alpine` | 平台数据库，只发布到宿主 `127.0.0.1:55432` |
| `control-plane` | dshcloud 平台镜像 | API、认证和管理台，生产环境使用 host 网络 |
| `node-agent` | dshcloud 平台镜像 | 管理工作空间容器，持有 Docker socket 和 `SYS_ADMIN` |
| `traefik` | `traefik:v3.5` | 入口、TLS、认证转发，直接占用宿主 80/443 |

安装器还会：

- 创建或使用 XFS `pquota` 数据池，默认路径 `/var/lib/dsh`；
- 非 XFS 主机上创建 `/var/lib/dsh.img` 稀疏 XFS 镜像，并写入 `/etc/fstab`；
- 将状态、Compose、密钥、Traefik 配置和 ACME 数据写入 `/opt/dsh-cloud`；
- 写入并启用 `/etc/systemd/system/dsh-cloud-harden.service`；
- 创建 `dsh-cloud-input`、`dsh-cloud-forward`、`dsh-cloud-egress` 等 iptables 规则；
- 将每个工作空间作为单独容器、单独网络和数据目录运行。

`node-agent` 等价于宿主 root。任何能够控制它、Docker socket 或平台镜像的人，都能够控制整台服务器。

## 2. 推荐服务器基线

项目没有写死最低 CPU、内存和磁盘。下面是单机小规模部署的运维起点，不是容量保证：

| 项目 | 建议 |
| --- | --- |
| 操作系统 | Ubuntu Server 24.04 LTS，64 位，专用主机或 VM |
| CPU | 4 vCPU 起 |
| 内存 | 8 GiB 起，再加所有工作空间的内存上限 |
| 系统盘 | 40 GiB 起，用于系统、Docker 镜像和日志 |
| 工作空间数据盘 | 独立 XFS 数据盘，按业务容量和备份保留期规划 |
| 网络 | 固定公网 IPv4；80/443 入站；稳定的 443 出站 |
| 权限 | 可使用 `sudo`；systemd 必须正常运行 |

Docker 官方当前支持 Ubuntu 22.04、24.04 和 26.04 的 64 位版本。这里优先选择 24.04 LTS，是为了采用更成熟的生产基线；其他版本必须先在同版本测试机完成本文全部验收。

参考：

- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Docker Compose plugin](https://docs.docker.com/compose/install/linux/)
- [Ubuntu 防火墙文档](https://ubuntu.com/server/docs/how-to/security/firewalls/)
- [dshcloud 上游仓库](https://github.com/eskim2001/dshcloud)

## 3. 部署前准备清单

先确定并记录：

```bash
# 以下值是示例；在自己的运维记录中替换。
BASE_DOMAIN=dsh.example.com
CONSOLE_DOMAIN=console.dsh.example.com
ADMIN_PUBLIC_IP=203.0.113.10
POOL_ROOT=/var/lib/dsh
POOL_SIZE_MB=102400
```

其中：

- `BASE_DOMAIN` 是工作空间父域，不是控制台域名；
- 控制台固定使用 `console.<BASE_DOMAIN>` 形态；
- 工作空间使用 `<slug>.<BASE_DOMAIN>`；
- 父域本身不作为访问入口；
- `POOL_SIZE_MB` 只在首次创建 loopback XFS 池时生效；XFS 可以扩容，不能原地缩容。

上线前确认：

- [ ] 服务器上没有现有业务或重要 Docker 数据；
- [ ] 80、443 和计划使用的引导端口未被占用；
- [ ] 云安全组允许 SSH、TCP 80、TCP 443；
- [ ] 引导端口只允许管理员公网 IP 临时访问；
- [ ] 出站能够访问 Ubuntu 软件源、Docker Hub、GHCR、GitHub 和 Let's Encrypt；
- [ ] DNS 服务商允许配置泛解析；
- [ ] 备份存储不位于本机系统盘或数据池；
- [ ] 已决定部署上游镜像还是自己的二次开发镜像；
- [ ] 已预留停机和恢复演练窗口。

## 4. 初始化 Ubuntu

### Step 4.1：更新系统

```bash
sudo apt update
sudo apt full-upgrade -y
sudo reboot
```

重连后确认：

```bash
uname -a
cat /etc/os-release
systemctl is-system-running
timedatectl status
```

### Step 4.2：安装基础包

必须在运行安装器前装好 `xfsprogs`。当前安装器在缺少 `mkfs.xfs` 时可能先创建空的稀疏镜像、再失败；提前安装可以避开这个半成品状态。

```bash
sudo apt install -y \
  ca-certificates curl git openssl jq \
  xfsprogs util-linux iptables

command -v mkfs.xfs
command -v findmnt
command -v iptables
```

### Step 4.3：配置 SSH 和防火墙

先确保当前 SSH 会话和备用登录方式可用，再启用 UFW：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow proto tcp from "$ADMIN_PUBLIC_IP" to any port 3000
sudo ufw enable
sudo ufw status verbose
```

如果计划显式使用 3001、3002、3003 或其他引导端口，请将规则中的 3000 一并改掉。

Docker 官方提醒：容器发布端口可能绕过 UFW。dshcloud 的 PostgreSQL 只绑定回环地址，Traefik 使用 host 网络直接监听 80/443；仍需同时检查云安全组、`ss`、iptables 和实际外部访问结果，不能只看 `ufw status`。

安装完成后，任何 `ufw reload`、`firewall-cmd --reload` 或防火墙重载都可能影响平台规则。重载后执行：

```bash
sudo systemctl restart dsh-cloud-harden.service
sudo iptables -S dsh-cloud-input
sudo iptables -S dsh-cloud-forward
```

## 5. 安装 Docker Engine 与 Compose v2

生产机使用 Docker 官方 APT 仓库，不使用 `get.docker.com` 便捷脚本。

### Step 5.1：移除冲突包

```bash
sudo apt remove -y \
  docker.io docker-compose docker-compose-v2 docker-doc \
  docker-buildx podman-docker containerd runc || true
```

### Step 5.2：添加 Docker 官方仓库

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
```

### Step 5.3：安装并验证

```bash
sudo apt install -y \
  docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
sudo docker run --rm hello-world
```

不需要把日常登录用户加入 `docker` 组。`docker` 组本身等价于 root 权限；生产运维命令直接使用 `sudo docker ...`。

### Step 5.4：可选的 Docker daemon 代理

只有服务器出网必须经过代理时才配置。端口和地址必须来自该服务器的实际代理，不要照抄示例。

```bash
sudo install -d -m 0755 /etc/systemd/system/docker.service.d
sudoedit /etc/systemd/system/docker.service.d/proxy.conf
```

内容：

```ini
[Service]
Environment="HTTP_PROXY=http://<proxy-host>:<actual-port>"
Environment="HTTPS_PROXY=http://<proxy-host>:<actual-port>"
Environment="NO_PROXY=localhost,127.0.0.1,::1"
```

应用并验证：

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
sudo systemctl show docker -p Environment
sudo docker pull alpine:latest
```

## 6. 配置 DNS 和端口

假设父域为 `dsh.example.com`，在 DNS 服务商处至少配置：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| A | `*.dsh.example.com` | 服务器公网 IPv4 |

这条泛解析同时覆盖 `console.dsh.example.com` 和所有 `<slug>.dsh.example.com`。如果 DNS 服务商的泛解析不覆盖显式记录，再单独添加：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| A | `console.dsh.example.com` | 服务器公网 IPv4 |

验证：

```bash
dig +short console.dsh.example.com A
dig +short test.dsh.example.com A
sudo ss -ltnp | grep -E ':(80|443|3000|55432)\b' || true
```

首次安装前，80/443 必须空闲。当前生产拓扑不支持和已有 Nginx、Caddy 或其他反向代理共享这两个端口。

## 7. 准备工作空间数据池

### 方案 A：独立 XFS 数据盘（生产推荐）

下面的 `mkfs.xfs` 会清空指定设备。必须通过云盘控制台、`lsblk`、序列号和挂载状态四项共同确认目标设备；已有数据的设备禁止执行。

```bash
lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS,MODEL,SERIAL
sudo blkid
```

确认无误后，由管理员将专用设备格式化并挂载。例如设备为 `/dev/disk/by-id/<verified-disk-id>`：

```bash
DEVICE=/dev/disk/by-id/<verified-disk-id>
sudo test -b "$DEVICE"
sudo findmnt "$DEVICE" && echo "设备已经挂载，停止操作" && false
sudo mkfs.xfs "$DEVICE"
sudo install -d -m 0755 /var/lib/dsh
UUID=$(sudo blkid -s UUID -o value "$DEVICE")
echo "UUID=$UUID /var/lib/dsh xfs defaults,pquota,nofail 0 0" | sudo tee -a /etc/fstab
sudo mount -a
findmnt -no SOURCE,FSTYPE,OPTIONS /var/lib/dsh
```

输出必须是 `xfs`，并且选项包含 `pquota` 或 `prjquota`。

### 方案 B：loopback XFS 池（最简单）

不提前格式化数据盘，让安装器创建 `/var/lib/dsh.img`。必须显式传 `--pool-size-mb`，不要在生产机上接受“可用空间 80%”的默认值。

例如创建 100 GiB 池：

```bash
POOL_SIZE_MB=102400
```

稀疏文件初始实际占用很小，但会随着工作空间写入增长；监控应同时覆盖宿主剩余空间和 XFS 池内空间。

## 8. 获取并固定源码

### Step 8.1：克隆自己的仓库

```bash
sudo install -d -o "$USER" -g "$USER" /opt/src
cd /opt/src
git clone https://github.com/fengfengnt/dshcloud.git
cd dshcloud
git remote add upstream https://github.com/eskim2001/dshcloud.git
git fetch --all --tags --prune
```

### Step 8.2：分支职责

- `master`：只用于跟踪 `upstream/main`；
- `dev`：二次开发；
- 生产部署：使用经过测试的不可变 Git tag 或明确 commit，不直接部署浮动的 `dev` HEAD。

同步主线：

```bash
git switch master
git fetch upstream
git merge --ff-only upstream/main
git push origin master
```

将主线更新纳入开发分支：

```bash
git switch dev
git merge master
# 解决冲突并完成测试后，创建自己的发布 tag。
```

部署前记录版本：

```bash
git status --short
git rev-parse HEAD
git describe --tags --always --dirty
```

`git status --short` 必须为空。生产机不要直接构建带 `-dirty` 的源码。

## 9. 选择镜像来源

### 路径 A：直接使用上游发布镜像

这是当前安装器原生支持的路径。安装器固定拉取：

```text
ghcr.io/eskim2001/dshcloud:<version>
```

必须固定版本号，不使用 `latest`：

```bash
DSH_VERSION=0.1.17
sudo docker pull "ghcr.io/eskim2001/dshcloud:$DSH_VERSION"
sudo docker image inspect "ghcr.io/eskim2001/dshcloud:$DSH_VERSION"
```

版本更新时先阅读上游 release、代码差异和迁移说明，再在测试机验证。

### 路径 B：部署二次开发后的自有镜像

当前源码有两个需要注意的硬编码：

- `scripts/install.sh` 顶部的 `IMAGE_REPO=ghcr.io/eskim2001/dshcloud`；
- `write_env()` 写出的 `INSTANCE_IMAGE_REPO=ghcr.io/eskim2001/dsh-instance`。

因此，仅运行下面的构建命令并不能让安装器使用自己的镜像；安装器会再次从上游 GHCR 拉同名镜像。

在 `dev` 分支中将这两个值改成自己的仓库，并把改动连同测试一起提交。例如：

```text
IMAGE_REPO=ghcr.io/fengfengnt/dshcloud
INSTANCE_IMAGE_REPO=ghcr.io/fengfengnt/dsh-instance
```

同时为自己的发行版设置不重复的版本号：

```bash
printf '%s\n' '0.1.17-fork.1' > docker/platform/VERSION
git add scripts/install.sh docker/platform/VERSION
git commit -m "build: configure fork image repositories"
git tag v0.1.17-fork.1
```

在开发机或 CI 中完成测试和发布；不建议把构建工具链放在生产服务器：

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm -r test

docker login ghcr.io
REPO=ghcr.io/fengfengnt/dshcloud PUSH=1 ./docker/platform/build.sh
```

若改动涉及 `docker/instance-image/` 或平台与 dsh 之间的入口契约，还要更新实例镜像版本并发布：

```bash
REPO=ghcr.io/fengfengnt/dsh-instance PUSH=1 ./docker/instance-image/build.sh
```

发布后确认镜像标签不可变、GHCR 包对生产服务器可拉取，并验证镜像中的源码提交：

```bash
docker buildx imagetools inspect ghcr.io/fengfengnt/dshcloud:0.1.17-fork.1
docker pull ghcr.io/fengfengnt/dshcloud:0.1.17-fork.1
docker image inspect ghcr.io/fengfengnt/dshcloud:0.1.17-fork.1 \
  --format 'revision={{index .Config.Labels "org.opencontainers.image.revision"}} created={{index .Config.Labels "org.opencontainers.image.created"}}'
```

私有 GHCR 包需要在生产机先执行 `docker login ghcr.io`。登录凭据只能保存在受控的 root 环境或专用凭据管理器中。

## 10. 执行安装

以下步骤在已经固定的源码 tag/commit 中执行。

### Step 10.1：运行安装器自检

不要以 root 运行这一条；它故意验证安装器会拒绝非 root：

```bash
pnpm test:install
```

如果生产机没有 Node.js/pnpm，这项应当已经在 CI 或发布机完成，生产机只核对对应提交的 CI 结果。

### Step 10.2：检查端口和环境

```bash
sudo systemctl is-active docker
sudo docker compose version
sudo ss -ltnp | grep -E ':(80|443|3000|3001|3002|3003|55432)\b' || true
findmnt -no FSTYPE,OPTIONS /var/lib/dsh 2>/dev/null || true
```

### Step 10.3：安装固定版本

独立 XFS 数据盘：

```bash
DSH_VERSION=0.1.17
sudo ./scripts/install.sh \
  --version "$DSH_VERSION" \
  --pool-root /var/lib/dsh \
  --wizard-port 3000
```

loopback XFS 池：

```bash
DSH_VERSION=0.1.17
sudo ./scripts/install.sh \
  --version "$DSH_VERSION" \
  --pool-root /var/lib/dsh \
  --pool-size-mb "$POOL_SIZE_MB" \
  --wizard-port 3000
```

部署自有镜像时，把 `DSH_VERSION` 替换为自己的平台版本，例如 `0.1.17-fork.1`，并确保第 9 节的镜像仓库硬编码已经在该提交中修改。

安装器会打印唯一的初始化链接：

```text
http://<server-ip>:3000/setup?token=<one-time-token>
```

不要把链接发送到聊天、工单或日志平台。初始化 token 是一次性管理员凭据。

## 11. 首次初始化

### Step 11.1：打开初始化页面

从 `ADMIN_PUBLIC_IP` 对应的受控电脑打开安装器输出的完整 URL。

填写：

- 管理员邮箱；
- 高强度且唯一的管理员密码；
- 工作空间父域，例如 `dsh.example.com`。

提交后平台会：

1. 创建第一个管理员；
2. 将域名写入 PostgreSQL；
3. 关闭明文初始化入口；
4. 重启控制面；
5. 将控制台切换到 `https://console.<BASE_DOMAIN>`。

### Step 11.2：关闭引导端口公网规则

```bash
sudo ufw delete allow proto tcp from "$ADMIN_PUBLIC_IP" to any port 3000
sudo ufw status verbose
sudo systemctl restart dsh-cloud-harden.service
```

控制面配置完成后，引导端口应只监听回环地址：

```bash
sudo ss -ltnp | grep ':3000\b'
```

### Step 11.3：发布默认实例镜像

登录管理台后进入“镜像管理”：

1. 同步镜像目录；
2. 下载或预热目标实例镜像；
3. 发布该版本；
4. 将它设为默认版本；
5. 创建一个低配额测试工作空间。

没有默认实例镜像时，平台不能创建工作空间。平台镜像和实例镜像的入口 token、cookie 与 gate header 契约必须匹配；二次开发时应同期发布和验收。

## 12. 部署验收

### Step 12.1：检查容器和健康端点

```bash
cd /opt/dsh-cloud
sudo docker compose ps
sudo curl -fsS http://127.0.0.1:3000/healthz
sudo docker inspect dsh-cloud-postgres-1 dsh-node-agent \
  --format '{{.Name}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
```

预期：

- `/healthz` 返回 `{"ok":true}`；
- PostgreSQL 与 node-agent 为 `healthy`；
- control-plane 与 Traefik 为 `running`。

### Step 12.2：检查镜像来源

```bash
sudo cat /opt/dsh-cloud/.installed-version
sudo grep '^DSH_CLOUD_IMAGE=' /opt/dsh-cloud/.env
sudo docker image inspect "$(sudo sed -n 's/^DSH_CLOUD_IMAGE=//p' /opt/dsh-cloud/.env)" \
  --format 'id={{.Id}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
```

不要输出整个 `.env`；它包含数据库密码和平台密钥。

### Step 12.3：检查 XFS project quota

```bash
findmnt -no SOURCE,FSTYPE,OPTIONS /var/lib/dsh
sudo xfs_quota -x -c state /var/lib/dsh
```

预期：

- 文件系统是 XFS；
- 挂载选项包含 `pquota` 或 `prjquota`；
- `Project quota state` 的 Accounting 和 Enforcement 都是 `ON`。

### Step 12.4：检查网络边界

```bash
sudo systemctl is-enabled dsh-cloud-harden.service
sudo systemctl is-active dsh-cloud-harden.service
sudo iptables -S dsh-cloud-input
sudo iptables -S dsh-cloud-forward
sudo ip6tables -S dsh-cloud-egress 2>/dev/null || true
sudo ss -ltnp | grep -E ':(80|443|3000|55432)\b'
```

确认：

- 80/443 由 Traefik 监听；
- PostgreSQL 只绑定 `127.0.0.1:55432`；
- 初始化完成后控制面端口只绑定回环；
- 工作空间端口只发布到宿主回环；
- 从工作空间内不能访问宿主 SSH、私网和其他 Docker 网桥；
- 工作空间仍能按业务需求访问允许的公网 IPv4 服务。

### Step 12.5：检查域名、TLS 和真实工作空间

```bash
curl -I "https://console.$BASE_DOMAIN"
openssl s_client -connect "console.$BASE_DOMAIN:443" \
  -servername "console.$BASE_DOMAIN" </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

在浏览器中完成：

- 管理员登录；
- 创建工作空间；
- 打开工作空间页面；
- 执行一条命令；
- 写入并重新读取文件；
- 重启工作空间后确认文件仍存在；
- 验证其他用户不能访问该工作空间；
- 升级测试工作空间，确认失败时能自动回滚。

### Step 12.6：重启验收

在没有重要任务运行时执行：

```bash
sudo reboot
```

重连后重复：

```bash
findmnt -no SOURCE,FSTYPE,OPTIONS /var/lib/dsh
sudo xfs_quota -x -c state /var/lib/dsh
cd /opt/dsh-cloud
sudo docker compose ps
sudo curl -fsS http://127.0.0.1:3000/healthz
sudo systemctl is-active dsh-cloud-harden.service
```

未通过重启验收的部署不能上线。

## 13. 日志与日常检查

```bash
cd /opt/dsh-cloud
sudo docker compose logs --tail=200
sudo docker compose logs -f control-plane node-agent
sudo docker compose logs -f traefik
sudo docker compose logs -f postgres
```

至少监控：

- 控制面 `/healthz`；
- 容器重启次数和健康状态；
- 系统盘、Docker 目录和数据池空间；
- XFS project quota 状态；
- 证书到期时间与 ACME 错误；
- PostgreSQL 备份结果；
- `dsh-cloud-harden.service` 和 iptables 链；
- 工作空间异常退出、创建失败和升级回滚。

当前安装器默认不配置 ACME 邮箱，因此不能依赖证书机构邮件提醒；必须做外部证书到期监控。

## 14. 备份与恢复演练

当前项目没有内置、已验证的整机备份与自动恢复命令。下面是最低运维基线，必须先在测试机完成一次“空白服务器恢复”演练，再将结果固化为自己的 runbook。

### 必须备份的对象

1. PostgreSQL 逻辑备份；
2. `/opt/dsh-cloud`，特别是 `.env`、Traefik 动态配置和 `acme/`；
3. 工作空间数据池和其中的 `.dsh-projects.json`；
4. `/etc/fstab` 中的 dshcloud 挂载记录；
5. 当前 Git commit、平台镜像 digest、实例镜像版本；
6. DNS、云安全组和防火墙配置记录。

`.env`、数据库备份和 ACME 数据包含密钥或账户信息，备份必须加密，并限制访问权限。

### PostgreSQL 逻辑备份

```bash
BACKUP_DIR=/mnt/backup/dshcloud/$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -m 0700 "$BACKUP_DIR"

cd /opt/dsh-cloud
sudo docker compose exec -T postgres \
  pg_dump -U dshcloud -d dsh_cloud -Fc \
  > "$BACKUP_DIR/postgres.dump"

sudo test -s "$BACKUP_DIR/postgres.dump"
sha256sum "$BACKUP_DIR/postgres.dump" \
  | sudo tee "$BACKUP_DIR/SHA256SUMS"
```

### 状态目录备份

```bash
sudo tar --acls --xattrs -C /opt \
  -czf "$BACKUP_DIR/opt-dsh-cloud.tar.gz" dsh-cloud
sudo chmod 0600 "$BACKUP_DIR/opt-dsh-cloud.tar.gz"
```

### loopback 数据池一致性备份

这一步需要维护窗口。先阻止新操作，再停止所有受管工作空间，最后卸载并复制整个 XFS 镜像；复制整个镜像才能保留 XFS project quota 元数据。

```bash
cd /opt/dsh-cloud
sudo docker compose stop traefik control-plane

MANAGED_IDS=$(sudo docker ps -q --filter 'label=dsh.cloud/managed=true')
if [ -n "$MANAGED_IDS" ]; then
  sudo docker stop $MANAGED_IDS
fi

sudo docker compose stop node-agent postgres
sudo sync
sudo umount /var/lib/dsh
sudo cp --sparse=always --reflink=auto \
  /var/lib/dsh.img "$BACKUP_DIR/dsh.img"
sudo mount /var/lib/dsh
sudo docker compose up -d
```

备份后再次检查健康状态，并将副本复制到另一台主机或对象存储。单独放在本机另一目录不算灾备。

使用独立 XFS 数据盘时，优先使用云盘/存储系统的一致性快照；若没有快照能力，应在停写和卸载后使用 `xfsdump` 或块级备份。不要用普通 `cp -a` 代替，因为它不能完整表达 XFS project quota 元数据。

### 恢复演练要求

在空白测试服务器上至少验证：

1. 安装相同或兼容的 Ubuntu、Docker 和工具包；
2. 恢复 `/opt/dsh-cloud`，权限保持正确；
3. 恢复并挂载数据池，project quota 仍为 ON；
4. 只启动 PostgreSQL，使用 `pg_restore` 恢复数据库；
5. 启动 node-agent、control-plane、Traefik；
6. 重建 `dsh-cloud-harden.service` 并确认规则生效；
7. 核对用户、工作空间归属、镜像版本和数据；
8. 打开至少一个恢复后的工作空间并校验文件；
9. 记录恢复点目标、恢复耗时和全部校验值。

在恢复流程没有演练成功之前，不要把“有备份文件”等同于“可以恢复”。

## 15. 升级与回滚

### Step 15.1：升级前

```bash
cd /opt/src/dshcloud
git fetch --all --tags --prune
git status --short
```

要求：

- 已完成数据库、状态目录和数据池备份；
- 已在测试机用相同版本路径升级成功；
- 已确认平台镜像和实例镜像的兼容关系；
- 已记录升级前的 `.installed-version` 和镜像 digest；
- 没有正在执行的工作空间升级、删除或长时间任务。

### Step 15.2：升级平台

```bash
NEW_VERSION=0.1.18
sudo ./scripts/install.sh update --version "$NEW_VERSION"
```

安装器会保留 `/opt/dsh-cloud/.env` 中的 secret、PostgreSQL 卷和数据池，并重新执行迁移、渲染和服务启动。

升级后完整执行第 12 节验收，不只看容器是否为 running。

### Step 15.3：平台镜像回滚

只有在数据库迁移与旧版本兼容、且已验证备份可恢复时，才能直接安装旧平台镜像：

```bash
PREVIOUS_VERSION=0.1.17
sudo ./scripts/install.sh update --version "$PREVIOUS_VERSION"
```

如果数据库迁移不可逆，必须停机并恢复升级前 PostgreSQL 备份；不能只换回旧镜像。工作空间镜像升级由平台按实例创建快照并尝试自动回滚，但这不替代整个平台备份。

## 16. 修改域名

域名保存在数据库，不应手改 `/opt/dsh-cloud/.env`。通过平台镜像命令修改：

```bash
cd /opt/dsh-cloud
sudo docker compose run --rm control-plane domain new-dsh.example.com
sudo docker compose restart control-plane
```

修改前先配置新的泛解析。域名切换会令旧域名会话失效，用户需要在新域名重新登录。

## 17. 卸载

### 保留 PostgreSQL 卷和工作空间数据

```bash
sudo ./scripts/install.sh uninstall
```

该命令停止并删除平台 Compose 容器，停止受管工作空间，保留 PostgreSQL 卷、存储池和数据，并移除平台网络加固规则。

### 永久删除全部数据

```bash
sudo ./scripts/install.sh uninstall --purge
```

`--purge` 会删除 PostgreSQL 卷、工作空间容器、工作空间网络、存储池镜像、`fstab` 记录和 `/opt/dsh-cloud`。这是不可恢复操作，只有在备份验证完成且目标主机、路径和数据归属全部确认后才能执行。

## 18. 常见故障

### Docker 拉取超时

```bash
curl -I https://registry-1.docker.io/v2/
curl -I https://ghcr.io/v2/
sudo systemctl show docker -p Environment
sudo journalctl -u docker --since '-15 min'
```

普通 shell 能联网但 `docker pull` 失败，通常表示 Docker daemon 没有继承代理。按第 5.4 节配置实际代理地址并重新验证。

### `bash\r` 或脚本出现 `$'\r'`

源码被 Windows Git 检出成 CRLF。生产服务器应直接在 Linux 上 clone。二次开发仓库建议增加 `.gitattributes`：

```gitattributes
*.sh text eol=lf
```

不要在生产机批量修改未知文件的换行后直接部署；应回到开发分支修复、测试并发布新版本。

### 缺少 `mkfs.xfs`

先安装：

```bash
sudo apt install -y xfsprogs
```

如果失败安装已经留下 `/var/lib/dsh.img`，不要直接删除。依次确认它未挂载、没有文件系统签名且实际占用为 0：

```bash
sudo findmnt /var/lib/dsh /var/lib/dsh.img || true
sudo losetup -j /var/lib/dsh.img || true
sudo blkid /var/lib/dsh.img || true
sudo file /var/lib/dsh.img
sudo du -h /var/lib/dsh.img
```

只有五项证据都表明它是本次失败创建的空文件时，才由管理员删除并重跑安装器。任何已有签名、挂载、loop 设备或非零占用都应停止并调查。

### 80/443 被占用

```bash
sudo ss -ltnp 'sport = :80 or sport = :443'
```

当前版本不支持已有反向代理共存。迁走占用服务或为 dshcloud 使用独立主机，不要随意改 Compose 端口后宣称生产拓扑仍受支持。

### 控制面健康检查失败

```bash
cd /opt/dsh-cloud
sudo docker compose ps
sudo docker compose logs --tail=200 control-plane node-agent postgres
findmnt -no SOURCE,FSTYPE,OPTIONS /var/lib/dsh
sudo xfs_quota -x -c state /var/lib/dsh
```

### 证书签发失败

检查：

- 泛解析是否已经指向当前公网 IP；
- 80/443 是否从公网可达；
- 是否有 CDN 或代理改变了 ACME HTTP-01 请求；
- Traefik 日志是否出现速率限制或 DNS 错误；
- `/opt/dsh-cloud/traefik/acme` 是否持久化且权限正确。

```bash
cd /opt/dsh-cloud
sudo docker compose logs --tail=200 traefik
```

### 防火墙重载后实例隔离异常

```bash
sudo systemctl restart dsh-cloud-harden.service
sudo iptables -S dsh-cloud-input
sudo iptables -S dsh-cloud-forward
```

随后必须重新执行实例访问宿主、私网、其他实例和公网的攻击测试。只恢复链的名字不能证明规则语义正确。

## 19. 上线签字清单

- [ ] 使用专用、可重建的 Ubuntu 主机；
- [ ] 生产 Git commit/tag 和镜像 digest 已记录；
- [ ] 未使用 `latest`；
- [ ] 自有镜像仓库硬编码已修改并经过测试；
- [ ] 80/443、DNS 泛解析和 TLS 均通过外网验证；
- [ ] 初始化端口公网规则已删除；
- [ ] PostgreSQL 和控制面端口只绑定回环；
- [ ] XFS project quota Accounting/Enforcement 均为 ON；
- [ ] 工作空间持久化、资源配额和跨用户授权测试通过；
- [ ] 宿主、私网、跨实例和 Docker 网桥隔离测试通过；
- [ ] 防火墙 reload 后重新应用并验证平台规则；
- [ ] 主机重启后存储池、服务、规则和工作空间恢复正常；
- [ ] PostgreSQL、状态目录和数据池都有异机加密备份；
- [ ] 已在空白测试机完成一次恢复演练；
- [ ] 已配置日志、磁盘、容器健康和证书到期监控；
- [ ] 已接受当前版本仍未完成生产就绪验证的风险。

只有全部项目有可复核证据时，才进入正式流量切换。
