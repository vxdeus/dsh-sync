import test from 'node:test'
import assert from 'node:assert/strict'
import { createBatchEchoTracker, transferBatchTimeoutMs } from '../lib/sftp-progress.js'

// Pure in-memory fixtures: no subprocess, filesystem, credentials, or network.
const lines = [
  'put "/synthetic/one" "/data/dsh-sync/objects/one"',
  'put "/synthetic/two" "/data/dsh-sync/objects/two"',
  'get "/data/dsh-sync/objects/one" "/synthetic/readback-one"',
]
const echo = (line, ending = '\n') => 'sftp> ' + line + ending
function fixture(batch = lines, options) {
  const completed = []
  return { completed, tracker: createBatchEchoTracker(batch, index => completed.push(index), options) }
}

test('a put echo announces execution, not completion; the next complete echo confirms its predecessor', () => {
  const { tracker, completed } = fixture()
  tracker.push(echo(lines[0]))
  assert.deepEqual(completed, [], 'the first put has no completion evidence yet')
  tracker.push(echo(lines[1]))
  assert.deepEqual(completed, [0], 'only the preceding put is confirmed')
  tracker.push(echo(lines[2]))
  assert.deepEqual(completed, [0, 1], 'the following get confirms the last put, not the get itself')
  tracker.push(Buffer.alloc(0))
  assert.deepEqual(completed, [0, 1])
})

test('a put at the end of a batch never receives an implicit completion from its own echo or EOF', () => {
  const { tracker, completed } = fixture(lines.slice(0, 2))
  tracker.push(echo(lines[0]) + echo(lines[1]))
  assert.deepEqual(completed, [0])
  tracker.push('')
  tracker.push(Buffer.alloc(0))
  assert.deepEqual(completed, [0], 'exit-zero fallback belongs to the caller, not the echo tracker')
})

test('a partial next command, including a trailing CR without LF, cannot confirm a put', () => {
  const { tracker, completed } = fixture()
  tracker.push(echo(lines[0]))
  const next = echo(lines[1], '\r\n')
  const split = Math.floor(next.length / 2)
  tracker.push(next.slice(0, split))
  assert.deepEqual(completed, [])
  tracker.push(next.slice(split, -1))
  assert.deepEqual(completed, [], 'a CR is not a complete line terminator')
  tracker.push('')
  assert.deepEqual(completed, [], 'polling an unchanged incomplete line must not flush it')
  tracker.push('\n')
  assert.deepEqual(completed, [0])
})

test('CRLF command echoes survive arbitrary one-byte chunks without double counting', () => {
  const { tracker, completed } = fixture()
  const transcript = Buffer.from(lines.map(line => echo(line, '\r\n')).join(''))
  for (let i = 0; i < transcript.length; i++) tracker.push(transcript.subarray(i, i + 1))
  assert.deepEqual(completed, [0, 1])
})

test('UTF-8 filenames survive byte splits within multibyte characters and still require a final newline', () => {
  const unicode = [
    'put "/synthetic/鲸鱼 🐋 一.txt" "/data/dsh-sync/objects/one"',
    'get "/data/dsh-sync/objects/one" "/synthetic/回读 🐋.txt"',
  ]
  const { tracker, completed } = fixture(unicode)
  const first = Buffer.from(echo(unicode[0]))
  for (let i = 0; i < first.length; i++) tracker.push(first.subarray(i, i + 1))
  assert.deepEqual(completed, [])
  const second = Buffer.from(echo(unicode[1]))
  for (let i = 0; i < second.length - 1; i++) tracker.push(second.subarray(i, i + 1))
  assert.deepEqual(completed, [])
  tracker.push(second.subarray(-1))
  assert.deepEqual(completed, [0])
})

test('non-echo diagnostic lines and embedded prompt text are not completion receipts', () => {
  const { tracker, completed } = fixture()
  tracker.push('Connected to synthetic host.\nUploading /synthetic/one\nnoise: ' + echo(lines[1]))
  assert.deepEqual(completed, [])
  tracker.push(echo(lines[0]))
  tracker.push('100% 123 B 0.01s\nremote diagnostic without a command prompt\n')
  assert.deepEqual(completed, [])
  tracker.push(echo(lines[1]))
  assert.deepEqual(completed, [0])
})

for (const [name, transcript, expected] of [
  ['duplicated first echo', [lines[0], lines[0], lines[1], lines[2]], []],
  ['duplicated later echo', [lines[0], lines[1], lines[1], lines[2]], [0]],
  ['out-of-order first echo', [lines[1], lines[0], lines[1], lines[2]], []],
  ['skipped middle command', [lines[0], lines[2], lines[1], lines[2]], []],
]) {
  test(`${name} disables further echo confirmation instead of searching ahead`, () => {
    const { tracker, completed } = fixture()
    tracker.push(transcript.map(line => echo(line)).join(''))
    assert.deepEqual(completed, expected)
    tracker.push(lines.map(line => echo(line)).join(''))
    assert.deepEqual(completed, expected, 'later plausible output cannot recover an ambiguous transcript')
  })
}

for (const [name, wrong] of [
  ['different source path', lines[1].replace('/synthetic/two', '/synthetic/wrong')],
  ['different destination', lines[1].replace('/objects/two', '/objects/wrong')],
  ['extra trailing whitespace', lines[1] + ' '],
  ['optional put instead of mandatory put', '-' + lines[1]],
]) {
  test(`${name} is not an exact expected command echo`, () => {
    const { tracker, completed } = fixture()
    tracker.push(echo(lines[0]) + echo(wrong))
    tracker.push(echo(lines[1]) + echo(lines[2]))
    assert.deepEqual(completed, [], 'mismatch must not confirm the previous put or resume matching')
  })
}

const windowsLines = [
  String.raw`put "C:\\Users\\Synthetic Test\\cache\\one" "/data/dsh-sync/objects/one"`,
  String.raw`get "/data/dsh-sync/objects/one" "C:\\Users\\Synthetic Test\\cache\\readback"`,
]
// Sanitized fixture for the observed Windows OpenSSH 9.5p2 C:\\ -> C:// echo format.
const windowsTranscript = [
  'sftp> put "C://Users//Synthetic Test//cache//one" "/data/dsh-sync/objects/one"\r\n',
  'sftp> get "/data/dsh-sync/objects/one" "C://Users//Synthetic Test//cache//readback"\r\n',
].join('')

test('Windows OpenSSH doubled-backslash normalization is accepted when Windows matching is enabled', () => {
  const { tracker, completed } = fixture(windowsLines, { windowsPaths: true })
  tracker.push(windowsTranscript)
  assert.deepEqual(completed, [0])
})

test('Unix exact matching rejects the Windows-normalized alternative', () => {
  const { tracker, completed } = fixture(windowsLines, { windowsPaths: false })
  tracker.push(windowsTranscript)
  tracker.push(windowsLines.map(line => echo(line)).join(''))
  assert.deepEqual(completed, [], 'a mismatching platform-specific echo disables the tracker')
})

test('the Windows-normalized alternative defaults to win32 only', () => {
  const { tracker, completed } = fixture(windowsLines)
  tracker.push(windowsTranscript)
  assert.deepEqual(completed, process.platform === 'win32' ? [0] : [])
})

test('original raw batch echoes remain valid with Windows matching either enabled or disabled', () => {
  for (const windowsPaths of [false, true]) {
    const { tracker, completed } = fixture(windowsLines, { windowsPaths })
    tracker.push(windowsLines.map(line => echo(line)).join(''))
    assert.deepEqual(completed, [0])
  }
})

const MAX_LINE = 64 * 1024
for (const completeLine of [false, true]) {
  test(`an oversized ${completeLine ? 'complete' : 'unterminated'} line disables telemetry without accepting later receipts`, () => {
    const { tracker, completed } = fixture()
    tracker.push('x'.repeat(MAX_LINE + 1) + (completeLine ? '\n' : ''))
    tracker.push('\n' + lines.map(line => echo(line)).join(''))
    assert.deepEqual(completed, [])
  })
}

test('a growing unfinished line is bounded across chunks, not just within one push', () => {
  const { tracker, completed } = fixture()
  tracker.push('x'.repeat(MAX_LINE))
  tracker.push('x')
  tracker.push('\n' + lines.map(line => echo(line)).join(''))
  assert.deepEqual(completed, [])
})

test('a diagnostic line exactly at the line limit does not disable subsequent valid echoes', () => {
  const { tracker, completed } = fixture()
  tracker.push('x'.repeat(MAX_LINE) + '\n' + lines.map(line => echo(line)).join(''))
  assert.deepEqual(completed, [0, 1])
})

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const KIB = 1024
const MIB = KIB * KIB
const dataBudget = (commands, bytes) => transferBatchTimeoutMs({ commands, bytes, dataBatch: true })

test('data batches have a fifteen-minute minimum instead of the old five-minute whole-batch deadline', () => {
  for (const [commands, bytes] of [[0, 0], [1, 0], [2, 1], [10, MIB]]) {
    assert.equal(dataBudget(commands, bytes), 15 * MINUTE)
  }
})

test('data timeout budgets include both command latency and upload-plus-readback payload', () => {
  // 300 puts and 300 gets, carrying a 30 MiB snapshot in both directions.
  assert.equal(dataBudget(600, 60 * MIB), 48 * MINUTE)
  const base = dataBudget(400, 32 * MIB)
  assert.equal(base, 1_832_000)
  assert.equal(dataBudget(401, 32 * MIB), base + 3000)
  assert.equal(dataBudget(400, 32 * MIB + 64 * KIB), base + 1000)
  assert.equal(dataBudget(400, 32 * MIB + 1), base + 1000, 'partial throughput units round upward')
})

test('data timeout budgets are monotone and never exceed the twelve-hour hard cap', () => {
  for (const samples of [
    [0, 100, 400, 1000, 10000, 100000].map(commands => dataBudget(commands, 0)),
    [0, MIB, 64 * MIB, 1024 * MIB, 100 * 1024 * MIB].map(bytes => dataBudget(0, bytes)),
  ]) {
    for (let i = 0; i < samples.length; i++) {
      assert.ok(samples[i] >= 15 * MINUTE && samples[i] <= 12 * HOUR)
      if (i) assert.ok(samples[i] >= samples[i - 1])
    }
  }
  assert.equal(dataBudget(100000, 0), 12 * HOUR)
  assert.equal(dataBudget(0, 200 * 1024 * MIB), 12 * HOUR)
})

test('control and protected batches retain a five-minute hard deadline regardless of payload budget', () => {
  for (const [commands, bytes] of [[1, 0], [4, 32 * MIB], [100000, 200 * 1024 * MIB]]) {
    assert.equal(transferBatchTimeoutMs({ commands, bytes, dataBatch: false }), 5 * MINUTE)
  }
})

test('invalid data timeout budgets are rejected instead of producing unsafe timer values', () => {
  for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1', undefined, null]) {
    assert.throws(() => dataBudget(value, 0), /Invalid transfer timeout budget/)
    assert.throws(() => dataBudget(0, value), /Invalid transfer timeout budget/)
  }
})
