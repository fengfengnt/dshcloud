import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const installer = await readFile(new URL('./install.sh', import.meta.url), 'utf8')
const body = installer.split('cat >"$STATE_DIR/harden-host.sh" <<\'EOS\'\n')[1]?.split('\nEOS')[0]
assert.ok(body, 'generated firewall script must be present')

async function run(conflict, restoreFailure = false) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-firewall-test-'))
  try {
    const log = join(dir, 'calls')
    for (const name of ['iptables', 'ip6tables']) await writeFile(join(dir, name), `#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_LOG"
if [[ "$1" = -D ]]; then exit 1; fi
exit 0
`, { mode: 0o755 })
    for (const name of ['iptables-restore', 'ip6tables-restore']) await writeFile(join(dir, name), `#!/bin/bash
printf 'restore %s\\n' "$*" >> "$TEST_LOG"
while IFS= read -r line; do printf '%s\\n' "$line" >> "$TEST_LOG"; done
exit "$TEST_RESTORE_EXIT"
`, { mode: 0o755 })
    await writeFile(join(dir, 'docker'), `#!/bin/bash
if [[ "$2" = ls ]]; then printf 'legacy\\nforeign\\n'; exit 0; fi
if [[ "$5" = legacy ]]; then
  printf 'abcdef1234567890|dsh-net-alice|true|alice|<no value>\\n'
else
  printf 'fedcba6543210000|other-business|||%s\\n' "$TEST_FOREIGN_BRIDGE"
fi
`, { mode: 0o755 })
    const result = spawnSync('bash', ['-c', body], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TEST_LOG: log, TEST_RESTORE_EXIT: restoreFailure ? '1' : '0', TEST_FOREIGN_BRIDGE: conflict ? 'dshwcollision' : 'custom-business' },
      encoding: 'utf8', timeout: 5000,
    })
    const calls = await readFile(log, 'utf8').catch(() => '')
    return { ...result, calls }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test('selects only platform bridge prefix and labeled legacy bridge', async () => {
  const result = await run(false)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.calls, /-i dshw\+ -j DROP/)
  assert.match(result.calls, /-i br-abcdef123456 -j DROP/)
  const established = result.calls.indexOf('--ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN')
  assert.ok(established >= 0)
  assert.ok(established < result.calls.indexOf('-i dshw+ -j DROP'))
  assert.doesNotMatch(result.calls, /-i custom-business|-i docker\+|-i br-\+/)
  assert.match(result.calls, /-A dsh-cloud-egress -o custom-business -j DROP/)
  assert.match(result.calls, /-I FORWARD 1 -j dsh-cloud-forward/)
  assert.match(result.calls, /-A dsh-cloud-forward -i dshw\+ -j dsh-cloud-egress/)
  assert.match(result.calls, /-A dsh-cloud-egress -d 169\.254\.0\.0\/16 -j DROP/)
  assert.match(result.calls, /-A dsh-cloud-egress -d 10\.0\.0\.0\/8 -j DROP/)
  assert.match(result.calls, /-A dsh-cloud-egress -o br-\+ -j DROP/)
  const privateDrop = result.calls.indexOf('-A dsh-cloud-egress -d 10.0.0.0/8 -j DROP')
  assert.ok(privateDrop < result.calls.indexOf('-A dsh-cloud-egress -p tcp -j RETURN'))
  assert.match(result.calls, /restore --wait 5 --noflush/)
  assert.match(result.calls, /\*filter\n:dsh-cloud-input - \[0:0\]/)
  assert.match(result.calls, /COMMIT/)
  assert.doesNotMatch(result.calls, /-F INPUT/)
  assert.doesNotMatch(result.calls, /-F FORWARD/)
})

test('reports failed rule transactions instead of claiming success', async () => {
  const result = await run(false, true)
  assert.equal(result.status, 1)
})

test('rejects a foreign reserved-prefix bridge before mutating firewall', async () => {
  const result = await run(true)
  assert.equal(result.status, 1)
  assert.equal(result.calls.split('\n').filter(line => line && !line.startsWith('-L ')).length, 0)
  assert.match(result.stderr, /dshw/)
})

for (const firewallExit of [0, 1]) {
  test(`installation requires firewall success before services (exit ${firewallExit})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-install-order-'))
    try {
      const installFunction = installer.slice(installer.indexOf('cmd_install() {'), installer.indexOf('\ncmd_update() {'))
      const result = spawnSync('bash', ['-c', `set -euo pipefail
STATE_DIR="$TEST_STATE_DIR"
VERSION=test
IMAGE_DIGEST=test
preflight() { :; }
pick_ports() { :; }
provision_pool() { :; }
fetch_assets() { :; }
harden_host() { echo firewall; return "$TEST_FIREWALL_EXIT"; }
write_env() { echo environment; }
render_configs() { echo configuration; }
start_services() { echo services; }
${installFunction}
cmd_install
`], {
        env: { ...process.env, TEST_STATE_DIR: dir, TEST_FIREWALL_EXIT: String(firewallExit) },
        encoding: 'utf8', timeout: 5000,
      })
      assert.equal(result.status, firewallExit, result.stderr)
      assert.equal(result.stdout, firewallExit === 0 ? 'firewall\nenvironment\nconfiguration\nservices\n' : 'firewall\n')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}
