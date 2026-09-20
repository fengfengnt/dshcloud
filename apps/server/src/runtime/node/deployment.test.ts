import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

describe('production privilege separation', () => {
  it('runs migrations without starting the privileged node dependency', async () => {
    const script = await readFile(new URL('../../../../../scripts/install.sh', import.meta.url), 'utf8')
    const start = script.slice(script.indexOf('start_services() {'), script.indexOf('\n# 引导期'))
    expect(start).toContain('compose run --rm --no-deps control-plane migrate')
    expect(start).toContain('compose up -d node-agent control-plane traefik')
    expect(start.indexOf('compose up -d postgres')).toBeLessThan(start.indexOf('compose run --rm --no-deps'))
    expect(start.indexOf('compose run --rm --no-deps')).toBeLessThan(start.indexOf('compose up -d node-agent'))
  })
  it('keeps Docker, devices, data and SYS_ADMIN outside the public control plane', async () => {
    const raw = await readFile(new URL('../../../../../docker/compose/prod.yml', import.meta.url), 'utf8')
    const compose = parse(raw)
    const control = compose.services['control-plane']
    const node = compose.services['node-agent']
    expect(control.volumes).toEqual([
      'dsh-node-socket:/run/dsh-node:ro', './traefik/dynamic:/etc/traefik/dynamic',
    ])
    expect(control.cap_add).toBeUndefined()
    expect(control.cap_drop).toEqual(['ALL'])
    expect(control.read_only).toBe(true)
    expect(control.security_opt).toContain('no-new-privileges:true')
    expect(control.depends_on['node-agent'].condition).toBe('service_healthy')
    expect(node.env_file).toBeUndefined()
    expect(node.environment.DATABASE_URL).toBeUndefined()
    expect(node.volumes).toContain('/var/run/docker.sock:/var/run/docker.sock')
    expect(node.ports).toBeUndefined()
  })
})
