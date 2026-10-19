#!/usr/bin/env node
// Enumerate paths ourselves: cmd.exe, PowerShell and POSIX shells expand globs differently.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

// Also loaded as a second node:test reporter. Do not infer success from Electron's
// child status: some packaged runtimes return 0 even after node:test has failed.
// A fresh, fully consumed report is required in addition to a successful exit.
export default async function* completionReporter(source) {
  const report = { completed: false, total: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0 }
  for await (const { type, data } of source) {
    if (type === 'test:pass' || type === 'test:fail') {
      report.total++
      if (type === 'test:fail') {
        report.failed++
        if (data.details?.error?.failureType === 'cancelledByParent') report.cancelled++
      } else if (data.skip) report.skipped++
      else report.passed++
    }
    if (type === 'test:plan' && data.nesting === 0 && data.count > 0) report.completed = true
  }
  fs.writeFileSync(process.env.DSH_SYNC_TEST_REPORT, JSON.stringify(report), { flag: 'wx' })
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const files = fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.mjs')).sort()
  if (files.length === 0) throw new Error('No test/*.test.mjs files found; refusing an empty test run.')
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-ci-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^DSH_/i.test(key)))
  env.DSH_HOME = path.join(isolatedHome, 'home')
  env.HOME = isolatedHome
  env.USERPROFILE = isolatedHome
  fs.mkdirSync(env.DSH_HOME)
  // Native integration requires an explicitly provisioned packaged Host, not a developer's real profile.
  if (process.env.DSH_SYNC_NATIVE_CATALOG_TEST === '1') env.DSH_SYNC_NATIVE_CATALOG_TEST = '1'
  let exitCode = 0
  // Electron may ignore an implicitly assigned exitCode at shutdown. Preserve
  // node:test/report failures through a synchronous final process.exit instead.
  process.once('beforeExit', code => process.exit(process.exitCode || code || exitCode))
  try {
    const reporter = pathToFileURL(fileURLToPath(import.meta.url)).href
    const runs = files.map(name => ({
      label: path.join('test', name),
      args: ['--test', '--test-isolation=none', '--test-reporter=tap', '--test-reporter-destination=stdout',
        `--test-reporter=${reporter}`, '--test-reporter-destination=stdout', path.join('test', name)],
    }))
    const pureTests = pathToFileURL(path.join(root, 'test', 'run-tests.mjs')).href
    runs.push({
      label: path.join('test', 'run-tests.mjs'),
      // A thrown import must not become an Electron status-0 false positive either.
      args: ['--input-type=module', '--eval', `import fs from 'node:fs'; await import(${JSON.stringify(pureTests)}); fs.writeFileSync(process.env.DSH_SYNC_TEST_REPORT, JSON.stringify({ completed: true, total: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0 }), { flag: 'wx' });`],
    })
    for (const [index, { label, args }] of runs.entries()) {
      const reportPath = path.join(isolatedHome, `test-result-${index}.json`)
      console.log(`\n> node ${label}`)
      const result = spawnSync(process.execPath, args, { cwd: root, env: { ...env, DSH_SYNC_TEST_REPORT: reportPath }, stdio: 'inherit', shell: false })
      if (result.error) { console.error(result.error); exitCode = 1; break }
      if (result.signal || result.status !== 0) { exitCode = result.status || 1; break }
      let report
      try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) } catch (error) {
        console.error(`Missing or unreadable completion report for ${label}: ${error.message}`)
        exitCode = 1
        break
      }
      console.log(`Completion report: ${JSON.stringify(report)}`)
      if (report.completed !== true || !Number.isSafeInteger(report.total) || report.total < 1 || report.failed !== 0 || report.cancelled !== 0) {
        console.error(`Incomplete or failed tests for ${label}; refusing child status-0 success.`)
        exitCode = 1
        break
      }
    }
  } finally {
    // Delete only the exact temporary directory allocated by this invocation.
    if (path.dirname(isolatedHome) !== path.resolve(os.tmpdir()) || !path.basename(isolatedHome).startsWith('dsh-sync-ci-')) {
      throw new Error('Unexpected temporary test path; cleanup refused.')
    }
    fs.rmSync(isolatedHome, { recursive: true, force: true })
  }
  process.exitCode = exitCode
}

// Reporter children import this file but must never recursively launch the suite.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main() } catch (error) { console.error(error); process.exit(1) }
}
