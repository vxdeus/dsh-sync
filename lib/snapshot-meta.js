// Keep metadata stable only when the complete staged content and public snapshot
// identity are unchanged. This enables a true no-op upload without weakening hashes.
export function snapshotTimestamp(previous, current, now = new Date().toISOString()) {
  const fields = ['contentId', 'machine', 'user', 'profiles', 'extras', 'installedPlugins', 'pluginInstallManifest', 'upgradeGuidance']
  if (previous && typeof previous.uploadedAt === 'string' && current.contentId && fields.every(key => JSON.stringify(previous[key]) === JSON.stringify(current[key]))) return previous.uploadedAt
  return now
}
