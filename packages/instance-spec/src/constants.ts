/** 容器内 Caddy 监听端口；入口把它发布到宿主回环，再按 `host:hostPort` 转发进来。 */
export const BRIDGE_PORT = 8080

/** dsh 在容器内监听的端口，只绑回环。 */
export const DSH_PORT = 3080

/** 用户内容的唯一落点（卷挂载点）。 */
export const DATA_ROOT = '/data'

/**
 * 工作负载在容器里跑的 uid / gid。
 *
 * 取 1000 是因为镜像基座（`node:24-trixie`）里本来就有 uid/gid 1000 的 `node` 用户 ——
 * 镜像侧零改动，`/etc/passwd` 里也查得到名字，不让容器里的进程变成一个没有名字的号。
 *
 * **全部实例用同一个固定号**，不是每实例一个：宿主上 1000 通常是运维本人，而运维本来就有
 * root，所以这不算新的暴露面；反过来每实例一个号，会把「哪个目录归哪个实例」变成一套要
 * 额外维护、还得跟着实例一起备份恢复的状态。
 *
 * 它**不改容器的边界**（边界是命名空间与能力集）。它的作用是让「容器里的进程能改宿主上
 * 哪些文件」从「全都能」缩到「只有这一份」。
 */
export const INSTANCE_UID = 1000
export const INSTANCE_GID = 1000

/** 工作目录：必须落在卷内，否则容器重建即丢。 */
export const WORKSPACE_DIR = `${DATA_ROOT}/home/workspace`

/** 入口注入的实例标识 header。 */
export const GATE_INSTANCE_HEADER = 'X-Platform-Instance'

/** 入口注入的签名 token header（每实例独立）。 */
export const GATE_TOKEN_HEADER = 'X-Platform-Token'
