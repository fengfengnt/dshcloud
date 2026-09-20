import { isIP } from 'node:net'
import { z } from 'zod'

export const DomainSchema = z.string().min(3).max(253).refine(value => {
  const labels = value.split('.')
  return isIP(value) === 0 && labels.length >= 2 && labels.every(label =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
}, { message: '域名须为小写、至少两个有效 DNS 标签，不含端口或路径' })
