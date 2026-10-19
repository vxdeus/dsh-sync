import test from 'node:test'
import assert from 'node:assert/strict'
import { snapshotTimestamp } from '../lib/snapshot-meta.js'
const current = { contentId: 'verified-content-digest', machine: 'same-device', user: 'same-user', profiles: ['desktop'], extras: [], installedPlugins: [{ name: 'dsh-sync', version: '0.3.1' }] }
test('unchanged staged content retains metadata timestamp for a real no-op upload', () => {
  const previous = { ...current, uploadedAt: '2026-01-01T00:00:00Z' }
  assert.equal(snapshotTimestamp(previous, current, 'new-time'), previous.uploadedAt)
})
test('content, device, mappings and plugin changes produce fresh metadata', () => {
  const previous = { ...current, uploadedAt: 'old-time' }
  for (const change of [{ contentId: 'different' }, { machine: 'other' }, { user: 'other' }, { extras: [{ name: 'new' }] }, { installedPlugins: [] }, { profiles: ['other'] }]) {
    assert.equal(snapshotTimestamp(previous, { ...current, ...change }, 'new-time'), 'new-time')
  }
  assert.equal(snapshotTimestamp(null, current, 'new-time'), 'new-time')
  assert.equal(snapshotTimestamp({ ...previous, uploadedAt: null }, current, 'new-time'), 'new-time')
  assert.equal(snapshotTimestamp({ ...previous, contentId: undefined }, { ...current, contentId: undefined }, 'new-time'), 'new-time')
})
