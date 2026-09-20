import type { InstanceRow } from '../db/schema.js'

export interface BootDeps {
  listInstances(): Promise<InstanceRow[]>
  /**
   * 确认该实例的**数据卷**存在且可用。**不允许新建**——卷没了就该报错。
   */
  ensure(storageKey: string): Promise<void>
  /** 拉起实例（机器在就 start，不在就重建）。 */
  start(id: string): Promise<void>
  markError(id: string, message: string): Promise<void>
  warn(msg: string): void
}

/**
 * 平台启动时的第一步：**判僵尸 → 校验数据 → 恢复实例**。
 *
 * ① 把中断的创建、恢复或删除标为错误，保留现场供核查。
 *
 * ② **校验所有实例的数据**。数据是**宿主存储池上带项目配额的目录**（池化形态；开发机没有池子时
 *    退回命名卷，见 `DockerDriver.createStorage`），**这条检查必须留着**：
 *    目录/卷不见了就标 error 并跳过——Docker 对缺失的 bind 源会默默建一个空目录顶上，
 *    宁可让实例显式坏掉，也不能让它带着一个空目录起来。那看起来像「数据没了」，比报错糟得多。
 *
 * ③ **把 DB 里状态为 running 的实例拉起来**。运行时不负责自动拉起
 *    （这正是我们要的：避免实例先于数据校验起来），所以恢复「正在运行」这个意图
 *    是平台的责任。少了这一步，对账器会把所有实例抹成 stopped——
 *    表现为「重启后实例全停」。
 */
export async function bootInstances(deps: BootDeps): Promise<void> {
  const rows = await deps.listInstances()

  // Without a durable operation phase, neither restarting nor deleting is a safe recovery guess.
  const interrupted = new Set(['provisioning', 'removing'])
  for (const row of rows) {
    if (!interrupted.has(row.status)) continue
    deps.warn(`实例 ${row.slug} 停在 ${row.status}：上次操作被平台重启中断，未自动恢复`)
    await deps.markError(row.id, `平台重启中断了操作（${row.status}），请先检查数据、快照和恢复副本，再决定恢复方式`)
  }

  const ready = new Set<string>()
  for (const row of rows) {
    if (interrupted.has(row.status)) continue
    try {
      await deps.ensure(row.storageKey)
      ready.add(row.id)
    } catch (err) {
      const message = messageOf(err)
      deps.warn(`实例 ${row.slug} 的数据目录不可用：${message}`)
      await deps.markError(row.id, `数据目录不可用：${message}`)
    }
  }

  for (const row of rows) {
    if (row.status !== 'running' || !ready.has(row.id)) continue
    try {
      await deps.start(row.id)
    } catch (err) {
      const message = messageOf(err)
      deps.warn(`实例 ${row.slug} 启动失败：${message}`)
      await deps.markError(row.id, message)
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
