/* Classic client half: no imports, credential access, or automatic writes. */
window.__ModuleLoader__.load({
  id: 'dsh-sync',
  factory: (require) => {
    'use strict';
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;
    let createPortal = null;
    try {
      const dom = require('react-dom');
      if (typeof dom.createPortal === 'function') createPortal = dom.createPortal;
      else if (dom.default && typeof dom.default.createPortal === 'function') createPortal = dom.default.createPortal;
    } catch (_) { /* The inline fixed-position dialog is the fallback. */ }

    const API = '/plugins/dsh-sync-ui/api';
    const POLL_MS = 1500;
    let nextId = 0;
    const CSS = `
.dsh-sync-panel {
  --sync-bg: var(--dsw-alias-bg-base, #ffffff);
  --sync-layer-1: var(--dsw-alias-bg-layer-1, #f5f6f8);
  --sync-layer-2: var(--dsw-alias-bg-layer-2, #ebedf1);
  --sync-border: var(--dsw-alias-border-l1, #d9dde5);
  --sync-brand: var(--dsw-alias-brand-primary, #335eea);
  --sync-label: var(--dsw-alias-label-primary, #20242d);
  --sync-muted: var(--dsw-alias-label-secondary, #616977);
  --sync-success: var(--dsw-alias-state-success-primary, #188044);
  --sync-error: var(--dsw-alias-state-error-primary, #c83240);
  --sync-warn: var(--dsw-alias-state-warn-primary, #956600);
  box-sizing: border-box; color: var(--sync-label); font: inherit;
  font-size: 14px; line-height: 1.55; text-align: left; min-width: 0;
}
.dsh-sync-panel *, .dsh-sync-panel *::before, .dsh-sync-panel *::after { box-sizing: border-box; }
.dsh-sync-panel.dsh-sync-page { width: 100%; max-width: 1120px; margin: 0 auto; padding: 24px; background: var(--sync-bg); }
.dsh-sync-panel.dsh-sync-embedded { padding: 20px; background: var(--sync-bg); }
.dsh-sync-panel h2, .dsh-sync-panel h3, .dsh-sync-panel h4, .dsh-sync-panel p { margin: 0; }
.dsh-sync-panel h2 { font-size: 22px; line-height: 1.35; }
.dsh-sync-panel h3 { font-size: 17px; line-height: 1.4; }
.dsh-sync-panel h4 { font-size: 15px; }
.dsh-sync-panel .dsh-sync-stack { display: grid; gap: 18px; }
.dsh-sync-panel .dsh-sync-header, .dsh-sync-panel .dsh-sync-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dsh-sync-panel .dsh-sync-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dsh-sync-panel .dsh-sync-muted, .dsh-sync-panel .dsh-sync-help { color: var(--sync-muted); }
.dsh-sync-panel .dsh-sync-help { font-size: 12px; overflow-wrap: anywhere; }
.dsh-sync-panel .dsh-sync-card { min-width: 0; padding: 16px; background: var(--sync-layer-1); border: 1px solid var(--sync-border); border-radius: 12px; }
.dsh-sync-panel .dsh-sync-card > * + * { margin-top: 12px; }
.dsh-sync-panel .dsh-sync-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; margin: 0; }
.dsh-sync-panel .dsh-sync-meta dt { color: var(--sync-muted); }
.dsh-sync-panel .dsh-sync-meta dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.dsh-sync-panel .dsh-sync-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.dsh-sync-panel .dsh-sync-stat { padding: 14px; border: 1px solid var(--sync-border); border-radius: 10px; min-width: 0; }
.dsh-sync-panel .dsh-sync-stat strong { display: block; font-size: 23px; line-height: 1.35; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.dsh-sync-panel .dsh-sync-stat span { color: var(--sync-muted); font-size: 12px; }
.dsh-sync-panel button, .dsh-sync-panel input, .dsh-sync-panel select, .dsh-sync-panel textarea { font: inherit; }
.dsh-sync-panel button { appearance: none; border: 1px solid var(--sync-border); background: var(--sync-bg); color: var(--sync-label); border-radius: 8px; padding: 7px 12px; min-height: 36px; cursor: pointer; line-height: 1.4; }
.dsh-sync-panel button:hover:not(:disabled) { border-color: var(--sync-brand); background: var(--sync-layer-2); }
.dsh-sync-panel button:disabled { opacity: .5; cursor: not-allowed; }
.dsh-sync-panel .dsh-sync-primary { color: var(--sync-brand); border-color: var(--sync-brand); font-weight: 600; }
.dsh-sync-panel .dsh-sync-danger { color: var(--sync-error); }
.dsh-sync-panel :focus-visible { outline: 2px solid var(--sync-brand); outline-offset: 3px; }
.dsh-sync-panel .dsh-sync-badge { display: inline-flex; align-items: center; border: 1px solid currentColor; border-radius: 99px; padding: 1px 8px; font-size: 12px; }
.dsh-sync-panel .dsh-sync-success { color: var(--sync-success); }
.dsh-sync-panel .dsh-sync-warning { color: var(--sync-warn); }
.dsh-sync-panel .dsh-sync-alert { padding: 12px 14px; border: 1px solid var(--sync-border); border-left: 3px solid var(--sync-brand); border-radius: 8px; background: var(--sync-layer-1); overflow-wrap: anywhere; }
.dsh-sync-panel .dsh-sync-alert.is-error { border-left-color: var(--sync-error); }
.dsh-sync-panel .dsh-sync-alert.is-warning { border-left-color: var(--sync-warn); }
.dsh-sync-panel .dsh-sync-alert.is-success { border-left-color: var(--sync-success); }
.dsh-sync-panel .dsh-sync-progress { display: flex; gap: 10px; align-items: flex-start; }
.dsh-sync-panel .dsh-sync-spinner { display: inline-block; flex: 0 0 auto; width: 17px; height: 17px; margin-top: 3px; border: 2px solid var(--sync-border); border-top-color: var(--sync-brand); border-radius: 50%; animation: dsh-sync-panel-spin .8s linear infinite; }
.dsh-sync-panel pre { margin: 0; padding: 12px; max-height: 340px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; background: var(--sync-bg); border: 1px solid var(--sync-border); border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 1.65; user-select: text; }
.dsh-sync-panel pre code { font: inherit; white-space: inherit; }
.dsh-sync-panel .dsh-sync-table-wrap { max-width: 100%; overflow: auto; border: 1px solid var(--sync-border); border-radius: 8px; }
.dsh-sync-panel table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dsh-sync-panel th, .dsh-sync-panel td { padding: 10px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--sync-border); }
.dsh-sync-panel th { color: var(--sync-muted); background: var(--sync-layer-2); font-weight: 500; white-space: nowrap; }
.dsh-sync-panel tr:last-child td { border-bottom: 0; }
.dsh-sync-panel .dsh-sync-path { min-width: 160px; max-width: 340px; overflow-wrap: anywhere; white-space: pre-wrap; }
.dsh-sync-panel .dsh-sync-nowrap { white-space: nowrap; }
.dsh-sync-panel .dsh-sync-form-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.dsh-sync-panel .dsh-sync-field { display: grid; gap: 5px; min-width: 0; }
.dsh-sync-panel .dsh-sync-field.is-full { grid-column: 1 / -1; }
.dsh-sync-panel .dsh-sync-input-row { display: flex; gap: 8px; align-items: center; }
.dsh-sync-panel .dsh-sync-input-row input { flex: 1; min-width: 0; }
.dsh-sync-panel .dsh-sync-input-row button { flex: 0 0 auto; }
.dsh-sync-panel input:not([type=checkbox]), .dsh-sync-panel select, .dsh-sync-panel textarea { width: 100%; min-width: 0; color: var(--sync-label); background: var(--sync-bg); border: 1px solid var(--sync-border); border-radius: 7px; padding: 8px 10px; }
.dsh-sync-panel textarea { min-height: 94px; resize: vertical; }
.dsh-sync-panel input::placeholder, .dsh-sync-panel textarea::placeholder { color: var(--sync-muted); opacity: .85; }
.dsh-sync-panel input[readonly] { background: var(--sync-layer-2); }
.dsh-sync-panel .dsh-sync-check { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.dsh-sync-panel input[type=checkbox] { margin: 4px 0 0; accent-color: var(--sync-brand); }
.dsh-sync-panel fieldset { min-width: 0; border: 0; margin: 0; padding: 0; }
.dsh-sync-panel fieldset:disabled { opacity: .65; }
.dsh-sync-panel .dsh-sync-confirm { border-color: var(--sync-brand); }
.dsh-sync-panel .dsh-sync-empty { text-align: center; padding: 20px 12px; color: var(--sync-muted); }
.dsh-sync-panel .dsh-sync-remote-list { padding: 0; margin: 0; list-style: none; }
.dsh-sync-panel .dsh-sync-remote-list li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--sync-border); overflow-wrap: anywhere; }
.dsh-sync-panel .dsh-sync-remote-list li:last-child { border: 0; }
.dsh-sync-panel .dsh-sync-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.dsh-sync-panel.dsh-sync-shortcut { display: inline-flex; align-items: center; justify-content: center; gap: 7px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--sync-muted); padding: 8px; min-height: 36px; cursor: pointer; }
.dsh-sync-panel.dsh-sync-shortcut:hover { color: var(--sync-label); background: var(--sync-layer-2); }
.dsh-sync-panel.dsh-sync-shortcut:focus-visible { outline: 2px solid var(--sync-brand); outline-offset: 2px; }
.dsh-sync-panel.dsh-sync-modal-backdrop { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgb(0 0 0 / 48%); isolation: isolate; }
.dsh-sync-panel .dsh-sync-dialog { display: flex; flex-direction: column; width: min(1020px, 100%); min-width: 0; max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px); background: var(--sync-bg); border: 1px solid var(--sync-border); border-radius: 14px; box-shadow: 0 20px 70px rgb(0 0 0 / 28%); overflow: hidden; }
.dsh-sync-panel .dsh-sync-dialog-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 20px; border-bottom: 1px solid var(--sync-border); flex: 0 0 auto; }
.dsh-sync-panel .dsh-sync-dialog-header h2 { font-size: 18px; }
.dsh-sync-panel .dsh-sync-dialog-body { min-height: 0; overflow: auto; overscroll-behavior: contain; }
@keyframes dsh-sync-panel-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dsh-sync-panel .dsh-sync-spinner { animation: none; } }
@media (max-width: 640px) {
  .dsh-sync-panel.dsh-sync-page, .dsh-sync-panel.dsh-sync-embedded { padding: 14px; }
  .dsh-sync-panel .dsh-sync-card { padding: 12px; }
  .dsh-sync-panel .dsh-sync-form-grid { grid-template-columns: minmax(0, 1fr); }
  .dsh-sync-panel .dsh-sync-meta { grid-template-columns: 1fr; gap: 2px; }
  .dsh-sync-panel .dsh-sync-meta dd { margin-bottom: 8px; }
  .dsh-sync-panel .dsh-sync-stat { padding: 10px; }
  .dsh-sync-panel .dsh-sync-stat strong { font-size: 19px; }
  .dsh-sync-panel .dsh-sync-main-actions > button { flex: 1 1 130px; }
  .dsh-sync-panel.dsh-sync-modal-backdrop { padding: 6px; }
  .dsh-sync-panel .dsh-sync-dialog { max-height: calc(100vh - 12px); max-height: calc(100dvh - 12px); border-radius: 10px; }
  .dsh-sync-panel .dsh-sync-dialog-header { padding: 12px 14px; }
}
`;

    function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    function text(value) { return typeof value === 'string' ? value : value == null ? '' : String(value); }
    function redact(value) {
      return text(value)
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[已隐藏]@')
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)\b/g, '[已隐藏]')
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, '$1 [已隐藏]')
        .replace(/((?:access[_-]?token|token|password|passwd|secret|authorization|cookie)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[已隐藏]');
    }
    function safeResult(value, depth) {
      if (typeof value === 'string') return redact(value);
      if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
      if ((depth || 0) > 6) return '[省略深层内容]';
      if (Array.isArray(value)) return value.map((item) => safeResult(item, (depth || 0) + 1));
      const output = {};
      Object.keys(record(value)).forEach((key) => {
        if (/token|password|passwd|secret|authorization|cookie|credential|private[_-]?key/i.test(key)) return;
        if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') output[key] = safeResult(value[key], (depth || 0) + 1);
      });
      return output;
    }
    function pretty(value) {
      if (value == null) return '';
      return typeof value === 'string' ? redact(value) : JSON.stringify(safeResult(value), null, 2);
    }
    function count(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
    function bytes(value) {
      const n = count(value);
      if (n < 1024) return `${Math.floor(n)} B`;
      const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
      const power = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length);
      return `${(n / Math.pow(1024, power)).toFixed(1)} ${units[power - 1]}`;
    }
    function repoLabel(value) {
      if (!value) return '未配置仓库';
      try {
        const url = new URL(value);
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return redact(url.toString());
      } catch (_) {
        return redact(text(value).replace(/^[^\s/@]+@/, '').split(/[?#]/)[0]);
      }
    }
    function when(value) {
      if (!value) return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
    }
    function running(data) { return Boolean(data && data.job && data.job.status === 'running'); }
    function busy(state) { return state.posting || state.uncertain || running(state.data) || Boolean(state.data && state.data.busy); }
    function locked(state) { return busy(state) || state.loading || !state.data || Boolean(state.error); }
    function jobLabel(action, mode) {
      if (action === 'download') return mode === 'online' ? '下载并在线应用' : mode === 'offline' ? '下载到暂存区' : '下载';
      return ({ upload: '上传', 'plugin-update': '插件更新', 'plugin-updates-install': '插件更新', 'backend-save': '保存存储选择', 'extra-save': '保存本机映射', 'extra-remove': '移除本机映射' })[action] || '同步';
    }
    const PHASE_LABELS = { scan: '扫描同步内容', connect: '连接 SSH / SFTP', upload: '上传文件', verify: '校验远端内容', publish: '发布快照', download: '下载文件', restore: '准备暂存目录', apply: '在线应用安全范围', done: '阶段已结束，等待任务结果' };
    function sanitizeProgress(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const output = {};
      if (typeof value.phase === 'string' && Object.prototype.hasOwnProperty.call(PHASE_LABELS, value.phase)) output.phase = value.phase;
      ['completedBytes', 'totalBytes', 'completedFiles', 'totalFiles', 'transferredBytes', 'connections', 'elapsedMs', 'speedBytesPerSecond'].forEach((key) => {
        if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) output[key] = value[key];
      });
      [['completedBytes', 'totalBytes'], ['completedFiles', 'totalFiles']].forEach(([completed, total]) => {
        if (output[completed] !== undefined && output[total] > 0) output[completed] = Math.min(output[completed], output[total]);
      });
      return Object.keys(output).length ? output : null;
    }
    function awaitingUploadCompletion(p) {
      // transferredBytes is job-wide (including earlier phases/readback), not an upload receipt.
      return Boolean(p && p.phase === 'upload' && !(p.completedBytes > 0 || p.completedFiles > 0));
    }
    function stagePercent(p) {
      if (!p || !p.phase || awaitingUploadCompletion(p)) return null;
      if (p.completedBytes !== undefined && p.totalBytes > 0) return Math.min(100, Math.floor(p.completedBytes / p.totalBytes * 100));
      if (p.completedFiles !== undefined && p.totalFiles > 0) return Math.min(100, Math.floor(p.completedFiles / p.totalFiles * 100));
      return null;
    }
    function shortcutLabel(state) {
      if (!running(state.data)) return '同步';
      const job = state.data.job;
      if (job.cancelRequested || (state.posting && state.activeAction === 'cancel')) return '同步 · 取消中';
      const p = sanitizeProgress(job.progress);
      if (awaitingUploadCompletion(p)) return '同步 · 上传中，等待首个文件完成';
      const percent = stagePercent(p);
      if (p && p.phase === 'upload') return `同步 · 上传文件 · 已确认${percent === null ? '，总量统计中' : ` ${percent}%`}${percent === 100 ? ' · 待核验发布' : ''}`;
      return `同步 · ${p && p.phase ? PHASE_LABELS[p.phase] : '等待阶段回执'}${percent === null ? ' · 等待回执' : ` ${percent}%`}`;
    }
    function canCancel(state, jobId) {
      const job = state.data && state.data.job;
      return !state.posting && !state.uncertain && !state.error && !state.loading && running(state.data)
        && Boolean(job.id) && job.id === jobId && job.cancellable === true && !job.cancelRequested;
    }
    function StageProgress({ progress, startedAt }) {
      const p = sanitizeProgress(progress);
      if (!p || !p.phase) return null;
      const upload = p.phase === 'upload';
      const awaitingUpload = awaitingUploadCompletion(p);
      const hasBytes = !awaitingUpload && p.completedBytes !== undefined && p.totalBytes > 0;
      const percent = stagePercent(p);
      const hasTransferFeedback = !awaitingUpload && p.transferredBytes > 0;
      const startedMs = typeof startedAt === 'string' ? new Date(startedAt).getTime() : NaN;
      const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : p.elapsedMs;
      return h('div', { className: 'dsh-sync-stage' },
        h('p', null, `当前阶段：${PHASE_LABELS[p.phase]}`),
        awaitingUpload ? h('p', null, '上传中，等待首个文件完成。') : null,
        awaitingUpload && p.totalBytes > 0 ? h('p', null, `本阶段总量：${bytes(p.totalBytes)}`) : null,
        hasBytes ? h('p', null, `${upload ? '本阶段已确认' : '本阶段'}：${bytes(p.completedBytes)} / ${bytes(p.totalBytes)}（${percent}%）`) : p.completedBytes > 0 ? h('p', null, `${upload ? '已确认' : '已处理'}：${bytes(p.completedBytes)}（总量统计中）`) : null,
        p.completedFiles !== undefined ? h('p', null, p.totalFiles > 0 ? `${upload ? '本阶段已确认文件' : '本阶段文件'}：${p.completedFiles} / ${p.totalFiles}${!hasBytes && percent !== null ? `（${percent}%）` : ''}` : `${upload ? '已确认文件' : '已处理文件'}：${p.completedFiles}（总数统计中）`) : null,
        upload ? h('p', { className: 'dsh-sync-help' }, '上传字节进度按已完成文件字节更新，当前单文件在途字节不计入；远端核验和发布尚未完成，本阶段完成不代表任务成功。') : null,
        p.phase === 'download' ? h('p', { className: 'dsh-sync-help' }, '下载百分比按实际收到的字节显示；哈希校验和暂存准备尚需完成。') : null,
        p.phase === 'download' && (!hasTransferFeedback || percent === 100) ? h('p', { className: 'dsh-sync-help' }, '正在传输 / 等待完成回执；本阶段完成不代表任务成功。') : null,
        h('p', { className: 'dsh-sync-help' },
          hasTransferFeedback && p.speedBytesPerSecond !== undefined ? `总传输速度：${bytes(p.speedBytesPerSecond)}/s（已确认平均，含回读）` : awaitingUpload ? '总传输速度：等待首个文件完成后确认' : '总传输速度：等待字节反馈',
          elapsedMs !== undefined ? ` · 已用时：${(elapsedMs / 1000).toFixed(1)} 秒` : ''),
        p.connections !== undefined ? h('details', null, h('summary', null, '连接详情'), h('p', null, `SSH批次启动次数（非重试次数）：${p.connections}`)) : null);
    }
    function normalizeJob(value) {
      if (!value || typeof value !== 'object') return null;
      const result = record(value.result);
      return {
        id: text(value.id), action: text(value.action), status: text(value.status),
        // Jobs from older hosts had no mode and were always offline downloads.
        mode: value.mode === 'online' ? 'online' : 'offline',
        cancelRequested: value.cancelRequested === true, cancellable: value.cancellable === true,
        startedAt: value.startedAt, finishedAt: value.finishedAt,
        error: redact(value.error),
        progress: sanitizeProgress(value.progress),
        result: { summary: pretty(result.summary), offlineCommand: typeof result.offlineCommand === 'string' ? redact(result.offlineCommand) : '', stagedFiles: safeResult(result.stagedFiles),
          copied: count(result.copied), deferred: count(result.deferred), partial: result.partial === true },
      };
    }
    function normalizePluginUpdates(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const cleanText = (input) => typeof input === 'string' ? redact(input).slice(0, 2000) : '';
      const planId = typeof value.planId === 'string' ? value.planId : '';
      if (!planId && (!Array.isArray(value.warnings) || !value.warnings.some((item) => typeof item === 'string' && item))) return null;
      const rows = planId && Array.isArray(value.offers) ? value.offers.slice(0, 100) : [];
      const ids = new Set();
      const offers = rows.filter((item) => item && typeof item === 'object' && !Array.isArray(item)
        && typeof item.id === 'string' && item.id && typeof item.name === 'string' && item.name
        && typeof item.targetVersion === 'string' && item.targetVersion).map((item) => {
        const unique = !ids.has(item.id); ids.add(item.id);
        return {
          id: item.id, profile: cleanText(item.profile), name: cleanText(item.name),
          currentVersion: item.currentVersion === null ? null : cleanText(item.currentVersion),
          targetVersion: cleanText(item.targetVersion), kind: cleanText(item.kind),
          canInstall: unique && item.canInstall === true, sourceLabel: cleanText(item.sourceLabel),
          advice: cleanText(item.advice), notes: (Array.isArray(item.notes) ? item.notes : typeof item.notes === 'string' ? [item.notes] : []).filter((note) => typeof note === 'string').slice(0, 20).map(cleanText),
        };
      });
      return { planId, snapshot: cleanText(value.snapshot), checkedAt: cleanText(value.checkedAt), offers,
        warnings: (Array.isArray(value.warnings) ? value.warnings : []).filter((item) => typeof item === 'string').slice(0, 20).map(cleanText) };
    }
    function pluginTargetsAllowed(data, planId, targets) {
      const plan = data && data.pluginUpdates;
      return Boolean(data && data.pluginUpdateAvailable === true && plan && plan.planId === planId
        && Array.isArray(targets) && targets.length > 0 && new Set(targets).size === targets.length
        && targets.every((id) => typeof id === 'string' && plan.offers.filter((row) => row.id === id).length === 1
          && plan.offers.some((row) => row.id === id && row.canInstall)));
    }
    function normalizeSnapshot(payload) {
      const config = record(payload.config);
      const sftp = record(config.sftp);
      const status = record(payload.status);
      const extras = Array.isArray(status.extras) ? status.extras : [];
      const remote = Array.isArray(status.remoteExtras) ? status.remoteExtras : [];
      const pending = record(payload.pendingApply);
      return {
        version: text(payload.version), busy: payload.busy === true, onlineAvailable: payload.onlineAvailable === true,
        pluginUpdateAvailable: payload.pluginUpdateAvailable === true, pluginUpdates: normalizePluginUpdates(payload.pluginUpdates),
        // Only the explanation is a UI field; never retain the Host's staging path.
        pendingApply: payload.pendingApply == null ? null : { reason: typeof pending.reason === 'string' && pending.reason.trim() ? redact(pending.reason) : '有下载内容尚未确认完整应用，真实上传受到保护。' },
        config: {
          backend: config.backend === 'sftp' ? 'sftp' : 'gitee',
          ready: typeof config.ready === 'boolean' ? config.ready : config.tokenPresent === true,
          sftp: { host: redact(sftp.host), port: count(sftp.port), username: redact(sftp.username), remoteRoot: redact(sftp.remoteRoot), configured: sftp.configured === true },
          repoUrl: repoLabel(config.repoUrl), branch: redact(config.branch),
          tokenPresent: config.tokenPresent === true, includeAttachments: config.includeAttachments === true,
          maxExtraBytes: count(config.maxExtraBytes),
        },
        status: {
          fileCount: count(status.fileCount), totalBytes: count(status.totalBytes),
          extras: extras.map((item) => ({ name: text(item.name), path: text(item.path), kind: item.kind === 'file' ? 'file' : 'directory', files: count(item.files), bytes: count(item.bytes), missing: item.missing === true, exclude: Array.isArray(item.exclude) ? item.exclude.map(text) : undefined })),
          remoteExtras: remote.map((item) => ({ name: text(item.name), kind: item.kind === 'file' ? 'file' : 'directory', files: count(item.files), bytes: count(item.bytes) })),
        },
        job: normalizeJob(payload.job),
      };
    }

    async function request(controller, body, jobId) {
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
      try {
        const response = await fetch(API + (jobId ? `?job=${encodeURIComponent(jobId)}` : ''), {
          method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
          signal: controller.signal,
          headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json', 'X-DSH-Sync-UI': '1' } : { Accept: 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        let payload;
        try { payload = await response.json(); } catch (_) {
          throw new Error(`接口返回了无法解析的内容（HTTP ${response.status}），请刷新确认后台状态。`);
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('接口响应格式不正确，请刷新确认后台状态。');
        if (!response.ok || payload.ok === false) {
          const error = new Error(redact(payload.error) || `同步接口失败（HTTP ${response.status}）。`);
          // An explicit API rejection is distinct from an unknown network outcome.
          error.apiRejected = payload.ok === false;
          throw error;
        }
        if (body && payload.ok !== true) throw new Error('接口未确认操作结果，请刷新确认后台状态。');
        return payload;
      } catch (error) {
        if (timedOut) throw new Error('请求超时，请检查本机 DSH 服务后刷新。');
        throw error;
      } finally { clearTimeout(timeout); }
    }

    // One store per apply: settings and shortcut share a mutation lock and one poller.
    // POST is never retried; no subscribers means no polling or in-flight reads.
    function makeStore() {
      let state = { data: null, loading: false, posting: false, uncertain: false, error: '', notice: '', activeAction: '', dryRunJobId: '' };
      const listeners = new Set();
      let timer = null, readController = null, postController = null, epoch = 0, disposed = false;
      const emit = (patch) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener(state)); };
      const clearPoll = () => { if (timer !== null) clearTimeout(timer); timer = null; };
      const schedule = () => {
        clearPoll();
        if (!disposed && listeners.size && !state.posting && (running(state.data) || (state.data && state.data.busy) || state.uncertain)) {
          timer = setTimeout(() => { timer = null; void refresh(true); }, POLL_MS);
        }
      };
      const stop = () => {
        epoch += 1; clearPoll();
        if (readController) readController.abort();
        if (postController) postController.abort();
        const hadPost = Boolean(postController);
        readController = null; postController = null;
        state = { ...state, loading: false, posting: false, uncertain: state.uncertain || hadPost };
      };
      async function refresh(poll) {
        if (disposed || !listeners.size || readController || state.posting) return;
        clearPoll();
        const generation = epoch;
        const controller = new AbortController();
        readController = controller;
        emit({ loading: !poll || !state.data });
        try {
          const currentJob = poll && running(state.data) ? state.data.job.id : '';
          const payload = await request(controller, null, currentJob);
          if (generation !== epoch || disposed) return;
          if (!payload.config || !payload.status) throw new Error('状态响应不完整，请刷新重试。');
          const data = normalizeSnapshot(payload);
          const cancelFinished = state.data && state.data.job && state.data.job.cancelRequested && data.job && data.job.id === state.data.job.id && data.job.status !== 'running';
          const notice = cancelFinished ? '已收到最终任务回执；取消请求不会撤销已发布内容。' : state.uncertain ? '已重新读取后台状态；未自动重复提交上次操作。' : state.notice;
          emit({ data, error: '', uncertain: false, notice });
        } catch (error) {
          if (generation !== epoch || disposed || error.name === 'AbortError') return;
          emit({ error: redact(error.message) || '无法连接同步接口，请检查本机 DSH 服务。' });
        } finally {
          if (generation === epoch && !disposed) { readController = null; emit({ loading: false }); schedule(); }
        }
      }
      async function post(body) {
        if (disposed || !listeners.size || (body.action === 'cancel' ? !canCancel(state, body.jobId) : locked(state))) return false;
        if (body.action === 'plugin-updates-install') {
          if (body.confirmed !== true || !pluginTargetsAllowed(state.data, body.planId, body.targets)
            || typeof body.requestId !== 'string' || !body.requestId) {
            emit({ error: '插件更新需要明确确认当前计划中的具体插件；计划已变化、安装服务不可用或未选择可安装项，请刷新后重新选择。' });
            return false;
          }
          // This action is distinct from download/upload consent. Never forward arbitrary specs or script approvals.
          body = { action: 'plugin-updates-install', confirmed: true, planId: body.planId, targets: body.targets.slice(), requestId: body.requestId };
        }
        if (body.action === 'download') {
          const mode = body.mode === undefined ? 'online' : body.mode;
          if (mode !== 'online' && mode !== 'offline') { emit({ error: '下载模式只允许 online 或 offline。' }); return false; }
          if (mode === 'online' && state.data.onlineAvailable !== true) { emit({ error: '当前宿主未提供安全在线恢复接口；请使用“仅下载（离线恢复）”。' }); return false; }
          body = { ...body, mode };
        }
        if (body.action === 'upload' && body.dryRun !== true && state.data.pendingApply && body.allowUnapplied !== true) {
          emit({ error: '仍有未应用项；请先核对，并在上传确认中明确勾选允许用本机快照替换远端。' });
          return false;
        }
        if ((body.action === 'download' || (body.action === 'upload' && !body.dryRun)) && !state.data.config.ready) {
          emit({ error: state.data.config.backend === 'sftp' ? 'SFTP 尚未就绪，无法上传或下载；请先完成本设备公钥授权，并在本机 dsh-sync.json 配置自己的服务器。' : 'Git 尚未就绪，无法上传或下载；请检查自己的仓库、账号、令牌及 privateRepoConfirmed 私有仓库确认。本地预演仍可用。' });
          return false;
        }
        clearPoll();
        const generation = epoch;
        const controller = new AbortController();
        postController = controller;
        emit({ posting: true, activeAction: body.dryRun ? 'dry-run' : body.action, error: '', notice: '' });
        try {
          const payload = await request(controller, body);
          if (generation !== epoch || disposed) return false;
          let data = state.data;
          if (payload.config && payload.status) data = normalizeSnapshot(payload);
          else if (payload.job) data = { ...data, job: normalizeJob(payload.job), busy: payload.job.status === 'running' };
          let notice = '';
          if (body.action === 'cancel') notice = '已请求取消，正在等待安全收尾；最终结果以后台回执为准，迟到的取消不会撤销已发布内容。';
          else if (body.action === 'extra-save') notice = '本机映射已保存，未上传任何内容。';
          else if (body.action === 'extra-remove') notice = '已移除本机映射；本地文件未删除。';
          else if (body.action === 'clear-result') notice = '已清除面板结果；没有修改本地文件或远端仓库。';
          else if (body.action === 'backend-save') notice = '存储选择已保存；未自动上传或下载任何内容。';
          else notice = '请求已受理；关闭面板不会取消已启动的后台任务。';
          emit({ data, posting: false, activeAction: '', uncertain: false, notice,
            dryRunJobId: body.action === 'upload' && body.dryRun && payload.job ? text(payload.job.id) : state.dryRunJobId });
          postController = null;
          void refresh(false);
          return true;
        } catch (error) {
          if (generation !== epoch || disposed) return false;
          const uncertain = !error.apiRejected;
          emit({ posting: false, activeAction: '', uncertain,
            error: (redact(error.message) || '提交失败。') + (uncertain ? '\n后台可能已收到请求，请刷新确认；本面板不会自动重试写操作。' : '') });
          return false;
        } finally {
          if (generation === epoch && !disposed) { postController = null; schedule(); }
        }
      }
      return {
        get: () => state, refresh: () => refresh(false), post,
        subscribe(listener) {
          if (disposed) return () => {};
          const first = listeners.size === 0;
          listeners.add(listener); listener(state);
          if (first) void refresh(false);
          return () => { listeners.delete(listener); if (!listeners.size) stop(); };
        },
        dispose() { disposed = true; stop(); listeners.clear(); },
      };
    }

    function Spinner() { return h('span', { className: 'dsh-sync-spinner', 'aria-hidden': true }); }
    function Notice({ children, kind, alert }) {
      return h('div', { className: `dsh-sync-alert${kind ? ` is-${kind}` : ''}`, role: alert ? 'alert' : 'status' }, children);
    }
    function Result({ job, dryRun, onClear, disabled }) {
      if (!job || job.status === 'running') return null;
      const failed = job.status === 'failed';
      const unconfirmed = job.status === 'unconfirmed';
      const cancelled = job.status === 'cancelled';
      const result = job.result || {};
      const partial = job.status === 'partial' || result.partial === true || count(result.deferred) > 0;
      const download = job.action === 'download' && (job.status === 'succeeded' || job.status === 'partial');
      const online = download && job.mode === 'online';
      const offline = download && !online;
      return h('section', { className: 'dsh-sync-card', 'aria-label': '最近任务结果' },
        h('div', { className: 'dsh-sync-row' },
          h('h3', { className: failed ? 'dsh-sync-danger' : unconfirmed || cancelled || partial ? 'dsh-sync-warning' : 'dsh-sync-success' }, `${dryRun ? '本地预演' : jobLabel(job.action, job.mode)}${failed ? '失败' : cancelled ? '已取消' : unconfirmed ? '待确认' : partial ? '部分完成' : '完成'}`),
          h('span', { className: 'dsh-sync-help' }, when(job.finishedAt || job.startedAt)),
          h('button', { type: 'button', disabled, onClick: onClear }, '清除结果')),
        unconfirmed ? h(Notice, { kind: 'warning' }, '尚未确认备份成功，清除提示不会改变上传结果。请核验远端后再关机。') : null,
        cancelled ? h(Notice, { kind: 'warning' }, job.action === 'plugin-update' ? '插件更新已取消并完成安全收尾；已完成的安装或启用不会自动撤销，请核对下方回执。' : '任务已取消并完成安全收尾；取消不会撤销已经发布的内容。') : null,
        partial && !cancelled ? h(Notice, { kind: 'warning' }, `部分完成，不代表全量恢复。${count(result.deferred) > 0 ? `仍有 ${count(result.deferred)} 项已跳过或延后，` : ''}请检查下方结果；延后项尚未应用。`) : null,
        h('pre', { tabIndex: 0 }, failed ? (job.error || result.summary || '任务失败，后台未提供更多信息。') : (result.summary || (cancelled ? '任务已取消。' : unconfirmed ? '任务结果待确认。' : partial ? '仅部分内容已处理，请检查延后项。' : '任务已完成。'))),
        failed && job.error && result.summary && result.summary !== job.error ? h('pre', { tabIndex: 0 }, result.summary) : null,
        job.action === 'plugin-update' ? h(Notice, { kind: 'warning' }, '插件结果以后台回执为准；安装完成不一定已加载新版本。如提示需要重启，请方便时手动重启 DSH，本面板不会自动关闭程序，也不会解除未应用同步内容的上传保护。') : null,
        online ? h(Notice, {}, '在线范围已处理，无需关闭或重启 DSH。可手动刷新页面更新会话列表；本面板不会自动刷新页面。运行时配置、插件安装、状态与预设未在线应用。') : null,
        online ? h('p', { className: 'dsh-sync-help' }, `已应用 ${count(result.copied)} 项；跳过或延后 ${count(result.deferred)} 项。`) : null,
        offline ? h(Notice, { kind: 'warning' }, '仅已下载到暂存区，尚未覆盖当前数据。请先完全退出 DSH，再在终端运行后台返回的离线恢复命令；命令可能包含在上方结果中。') : null,
        offline && result.offlineCommand ? h('div', null,
          h('h4', null, '退出 DSH 后运行'), h('pre', { tabIndex: 0 }, h('code', null, result.offlineCommand))) : null,
        download && result.stagedFiles != null ? h('details', null,
          h('summary', null, '暂存文件'), h('pre', { tabIndex: 0 }, pretty(result.stagedFiles))) : null);
    }

    return {
      name: 'dsh-sync-ui',
      inject: ['slots'],
      apply(ctx) {
        const store = makeStore();
        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-dsh-sync-panel', '');
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => { store.dispose(); style.remove(); };
        });

        function useSyncState() {
          const [state, setState] = useState(store.get);
          useEffect(() => store.subscribe(setState), []);
          return state;
        }
        function workspaceService() {
          try { return typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null; } catch (_) { return null; }
        }

        function Panel({ modal = false }) {
          const state = useSyncState();
          const [prefix] = useState(() => `dsh-sync-${++nextId}`);
          const [confirmation, setConfirmation] = useState(null);
          const [allowLarge, setAllowLarge] = useState(false);
          const [allowUnapplied, setAllowUnapplied] = useState(false);
          const [editor, setEditor] = useState(null);
          const [formError, setFormError] = useState('');
          const [picking, setPicking] = useState(false);
          const [backendChoice, setBackendChoice] = useState('gitee');
          const [pluginSelection, setPluginSelection] = useState({ planId: '', targets: [] });
          const confirmFocus = useRef(null), confirmOrigin = useRef(null), nameInput = useRef(null), pathInput = useRef(null);
          const mounted = useRef(false), editorVersion = useRef(0);
          useEffect(() => { mounted.current = true; return () => { mounted.current = false; editorVersion.current += 1; }; }, []);
          useEffect(() => {
            if (confirmation && confirmFocus.current) confirmFocus.current.focus();
            else if (!confirmation && confirmOrigin.current) {
              const origin = confirmOrigin.current; confirmOrigin.current = null;
              if (origin.isConnected && !origin.disabled) origin.focus();
            }
          }, [confirmation]);
          useEffect(() => {
            if (editor) {
              const target = editor.originalName ? pathInput.current : nameInput.current;
              if (target) target.focus();
            }
          }, [editor && editor.originalName, Boolean(editor)]);
          const data = state.data;
          const config = data && data.config;
          const pendingApply = data && data.pendingApply;
          const pluginPlan = data && data.pluginUpdates;
          const pluginPlanId = pluginPlan && pluginPlan.planId;
          useEffect(() => { setPluginSelection({ planId: pluginPlanId || '', targets: [] }); }, [pluginPlanId]);
          const selectedPluginIds = pluginSelection.planId === pluginPlanId ? pluginSelection.targets : [];
          const selectedPlugins = pluginPlan ? pluginPlan.offers.filter((row) => row.canInstall && selectedPluginIds.includes(row.id)) : [];
          const confirmingPlugins = Boolean(confirmation && confirmation.action === 'plugin-updates-install');
          const validPluginConfirmation = !confirmingPlugins || pluginTargetsAllowed(data, confirmation.planId, confirmation.targets);
          const needsUnappliedConsent = Boolean(confirmation && confirmation.action === 'upload' && confirmation.dryRun !== true && pendingApply);
          useEffect(() => { if (config) setBackendChoice(config.backend); }, [config && config.backend]);
          // Consent belongs to one confirmation against the latest displayed state.
          useEffect(() => { setAllowUnapplied(false); }, [pendingApply, config && config.backend]);
          const status = data && data.status;
          const job = data && data.job;
          const jobRunning = running(data);
          const disabled = locked(state);
          const actionDisabled = disabled || Boolean(confirmation) || picking;
          const extras = status ? status.extras : [];
          const remoteExtras = status ? status.remoteExtras : [];
          const picker = workspaceService();
          const canPick = Boolean(picker && typeof picker.pickDirectory === 'function');
          const headingId = `${prefix}-title`;
          const formId = `${prefix}-form`;
          const isDryRun = Boolean(job && job.id && job.id === state.dryRunJobId);
          let stage = '';
          if ((state.posting && state.activeAction === 'cancel') || (jobRunning && job.cancelRequested)) stage = '正在取消，等待后台安全收尾；迟到取消不会撤销已发布内容。';
          else if (state.posting) stage = state.activeAction === 'dry-run' ? '正在提交本地预演请求…' : `正在提交${jobLabel(state.activeAction)}请求…`;
          else if (jobRunning) {
            if (job.action === 'download') stage = job.mode === 'online'
              ? '后台正在下载并在线应用安全范围；已加载或分叉会话及运行时配置等将跳过或延后。无需关闭 DSH，请暂停其它编辑器写入。'
              : '后台正在下载并准备暂存区；不会直接覆盖本机数据，稍后需退出 DSH 后离线恢复。';
            else if (job.action === 'plugin-update') stage = '后台仅更新已明确同意的插件；不会自动授权构建脚本或关闭 DSH。请等待最终回执，可能需要稍后手动重启。';
            else if (job.action === 'upload' && isDryRun) stage = '后台正在准备本地同步快照；不会推送到仓库。';
            else if (job.action === 'upload') stage = '后台正在准备并上传同步快照，请等待任务结果。';
            else stage = '后台正在执行同步任务…';
          } else if (data && data.busy) stage = '后台正在执行另一项同步操作，请等待…';
          else if (state.uncertain) stage = '正在重新确认后台状态；不会重复提交写操作。';

          function openConfirm(value, event) {
            confirmOrigin.current = event.currentTarget;
            setAllowLarge(false); setAllowUnapplied(false); setConfirmation(value);
          }
          function selectPlugin(id, checked) {
            if (actionDisabled || !data || data.pluginUpdateAvailable !== true || !pluginPlan
              || !pluginPlan.offers.some((row) => row.id === id && row.canInstall)) return;
            setPluginSelection((previous) => {
              const targets = previous.planId === pluginPlan.planId ? previous.targets : [];
              return { planId: pluginPlan.planId, targets: checked ? Array.from(new Set([...targets, id])) : targets.filter((target) => target !== id) };
            });
          }
          function confirmPluginSelection(event) {
            const targets = selectedPlugins.map((row) => row.id);
            if (actionDisabled || !pluginTargetsAllowed(data, pluginPlanId, targets)) return;
            openConfirm({ action: 'plugin-updates-install', planId: pluginPlanId, targets,
              rows: selectedPlugins.map((row) => ({ name: row.name, currentVersion: row.currentVersion, targetVersion: row.targetVersion })),
              requestId: `sync-plugin-update-${Date.now()}-${++nextId}` }, event);
          }
          function startEditor(item, remoteOnly) {
            editorVersion.current += 1;
            setFormError('');
            setEditor({
              originalName: item && !remoteOnly ? item.name : '',
              name: item ? item.name : '', targetPath: item && !remoteOnly ? item.path : '',
              kind: item ? item.kind : 'directory',
              useDefault: !item || !Array.isArray(item.exclude),
              exclude: item && Array.isArray(item.exclude) ? item.exclude.join('\n') : '',
            });
          }
          function closeEditor() { editorVersion.current += 1; setEditor(null); setFormError(''); }
          function changeEditor(key, value) { setEditor((current) => current ? { ...current, [key]: value } : current); }
          async function selectDirectory() {
            if (picking || !editor || disabled) return;
            const service = workspaceService();
            if (!service || typeof service.pickDirectory !== 'function') { setFormError('目录选择不可用，请手动填写完整路径。'); return; }
            const version = editorVersion.current;
            setPicking(true); setFormError('');
            try {
              const selected = await service.pickDirectory();
              if (!mounted.current || version !== editorVersion.current) return;
              // Only the service's text path is accepted; never inspect a File.path.
              if (typeof selected === 'string' && selected.trim()) changeEditor('targetPath', selected);
              else if (selected != null && selected !== '') setFormError('目录选择未返回文本路径，请手动填写。');
            } catch (error) {
              if (mounted.current && version === editorVersion.current) setFormError(redact(error.message) || '目录选择失败，请手动填写。');
            } finally { if (mounted.current) setPicking(false); }
          }
          async function saveExtra(event) {
            event.preventDefault();
            if (!editor || actionDisabled) return;
            const name = editor.name.trim(), targetPath = editor.targetPath.trim();
            if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') { setFormError('名称仅可包含字母、数字、点、下划线和短横，且不能为 . 或 ..。'); return; }
            if (!targetPath || /[\u0000\r\n]/.test(targetPath)) { setFormError('请填写有效的完整本地路径。'); return; }
            if (!editor.originalName && extras.some((item) => item.name === name)) { setFormError('此名称已有本机映射，请使用表格中的“编辑”。'); return; }
            const body = { action: 'extra-save', name, targetPath, kind: editor.kind };
            if (editor.kind === 'directory' && !editor.useDefault) body.exclude = Array.from(new Set(editor.exclude.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)));
            const version = editorVersion.current;
            setFormError('');
            const ok = await store.post(body);
            if (ok && mounted.current && version === editorVersion.current) closeEditor();
          }
          async function acceptConfirm() {
            if (!confirmation || disabled || picking || !validPluginConfirmation || (needsUnappliedConsent && !allowUnapplied)) return;
            let body;
            if (confirmation.action === 'plugin-updates-install') body = { action: 'plugin-updates-install', confirmed: true,
              planId: confirmation.planId, targets: confirmation.targets.slice(), requestId: confirmation.requestId };
            else if (confirmation.action === 'extra-remove') body = { action: 'extra-remove', name: confirmation.name };
            else if (confirmation.action === 'download') body = { action: 'download', mode: confirmation.mode, confirmed: true };
            else body = { action: 'upload', dryRun: confirmation.dryRun === true, allowLarge,
              allowUnapplied: confirmation.dryRun !== true && allowUnapplied === true, confirmed: true };
            const selected = confirmation;
            const ok = await store.post(body);
            if (ok && mounted.current) {
              setConfirmation(null);
              if (selected.action === 'plugin-updates-install') setPluginSelection({ planId: pluginPlanId || '', targets: [] });
              if (selected.action === 'extra-remove' && editor && editor.originalName === selected.name) closeEditor();
            }
          }

          const onlineConfirmation = confirmation && confirmation.action === 'download' && confirmation.mode !== 'offline';
          const confirmTitle = confirmation && (confirmingPlugins ? '确认更新这些具体插件？' : confirmation.action === 'extra-remove' ? '移除本机映射？' : confirmation.action === 'download' ? (onlineConfirmation ? '下载并在线应用安全范围？' : '仅下载（离线恢复）？') : confirmation.dryRun ? '开始本地预演？' : config && config.backend === 'sftp' ? '确认上传到 SFTP？' : '确认上传到私有仓库？');
          const confirmText = confirmation && (confirmingPlugins
            ? '仅安装或更新下列明确选择的插件，不处理其它差异。插件代码在宿主内运行，影响此配置的所有会话；可能需要手动重启 DSH，但本面板不会自动退出程序。不会自动授权构建脚本；如脚本被阻止或版本不兼容，将停止并报告，需另行确认。此次同意不是对以后下载或其它插件的授权。'
            : confirmation.action === 'extra-remove'
            ? `仅移除“${confirmation.name}”的本机配置，不会删除本地文件，也不会立即修改远端内容。`
            : confirmation.action === 'download'
              ? onlineConfirmation
                ? '请先完成当前任务并暂停其它编辑器写入。在线范围：通过宿主接口导入新历史会话，仅追加未加载且未分叉的会话；已加载或分叉会话不覆盖；正在执行任务的工程路径跳过，写入前会再次检查，但不会锁定工作区或其它编辑器。工程文件覆盖前备份并校验冲突，内容寻址附件校验哈希、仅补齐缺失对象，不覆盖已有异内容对象。运行时配置、插件安装、状态与预设延后，不在线应用；数据库及凭据保留本机原件。无需关闭 DSH；完成后可手动刷新页面更新列表，延后项不代表已恢复。'
                : '只下载到暂存区，不直接覆盖当前 DSH 或本机工程/文件。完成后请完全退出 DSH，再运行返回的离线恢复命令。'
              : confirmation.dryRun
                ? '会在本机暂存同步内容，不会推送到远端仓库；这不是完全只读的检查。'
                : config && config.backend === 'sftp'
                  ? '会将 DSH 会话、已启用的附件及自定义工程/文件发送到本机预配置的 SFTP 服务器。请检查目标与同步内容。'
                  : '会将 DSH 会话、已启用的附件及自定义工程/文件发送到私有仓库。请确认仓库确为私有，并检查同步内容；本面板不验证仓库可见性。');

          return h('div', {
            className: `dsh-sync-panel ${modal ? 'dsh-sync-embedded' : 'dsh-sync-page'}`,
            'aria-labelledby': headingId,
            onKeyDown: (event) => {
              if (event.key === 'Escape' && confirmation) { event.preventDefault(); event.stopPropagation(); setConfirmation(null); }
            },
          }, h('div', { className: 'dsh-sync-stack' },
            h('header', { className: 'dsh-sync-header' },
              h('div', null,
                h(modal ? 'h3' : 'h2', { id: headingId }, modal ? '同步状态' : '跨机同步'),
                h('p', { className: 'dsh-sync-muted' }, '查看快照、在线应用安全范围或离线暂存，并管理本机工程映射。')),
              h('button', { type: 'button', onClick: () => { void store.refresh(); }, disabled: state.loading || state.posting }, state.loading ? '刷新中…' : '刷新')),
            state.error ? h(Notice, { kind: 'error', alert: true },
              h('strong', null, '同步接口异常'), h('pre', { tabIndex: 0 }, state.error),
              h('p', { className: 'dsh-sync-help' }, '可点击“刷新”重新读取状态；不会自动重复写操作。')) : null,
            !data && !state.error ? h(Notice, {}, h('div', { className: 'dsh-sync-progress' }, h(Spinner), '正在读取同步状态…')) : null,
            data ? h('section', { className: 'dsh-sync-card', 'aria-label': '存储配置' },
              h('h3', null, '存储后端'),
              h('p', { className: 'dsh-sync-help' }, `当前后端：${config.backend === 'sftp' ? 'SFTP' : 'Gitee'}。更改下方选择不会生效，需显式保存；不会自动上传。`),
              h('form', { onSubmit: (event) => { event.preventDefault(); if (!actionDisabled) void store.post({ action: 'backend-save', backend: backendChoice }); } },
                h('fieldset', { disabled: actionDisabled },
                  h('div', { className: 'dsh-sync-field' },
                    h('label', { htmlFor: `${prefix}-backend` }, '存储选择'),
                    h('select', { id: `${prefix}-backend`, value: backendChoice, onChange: (event) => setBackendChoice(event.target.value) },
                      h('option', { value: 'gitee' }, 'Gitee'), h('option', { value: 'sftp' }, 'SFTP'))),
                  h('button', { type: 'submit', className: 'dsh-sync-primary', disabled: actionDisabled || backendChoice === config.backend || (backendChoice === 'sftp' && !config.sftp.configured) }, '保存选择'))),
              backendChoice === 'sftp' || config.backend === 'sftp' ? h('div', null,
                h('dl', { className: 'dsh-sync-meta' },
                  h('dt', null, '服务器'), h('dd', null, config.sftp.host || '未配置'),
                  h('dt', null, '端口'), h('dd', null, config.sftp.port || '未配置'),
                  h('dt', null, '用户'), h('dd', null, config.sftp.username || '未配置'),
                  h('dt', null, '远端目录'), h('dd', null, config.sftp.remoteRoot || '未配置')),
                h('p', { className: 'dsh-sync-help' }, '仅可选择本机已预配置的 SFTP；网页不接受服务器或私钥输入，也不显示私钥路径。'),
                !config.sftp.configured ? h(Notice, { kind: 'warning' }, '本机缺少 SFTP 配置：请先完成一次公钥授权，再下载安装包配置本机；不能仅在此切换。') : null) : null,
              backendChoice === 'gitee' || config.backend === 'gitee' ? h('dl', { className: 'dsh-sync-meta' },
                h('dt', null, 'Gitee 仓库'), h('dd', null, config.repoUrl),
                h('dt', null, '分支'), h('dd', null, config.branch || '未配置分支'),
                h('dt', null, 'Gitee 令牌'), h('dd', null,
                  h('span', { className: `dsh-sync-badge ${config.tokenPresent ? 'dsh-sync-success' : 'dsh-sync-warning'}` }, config.tokenPresent ? '已配置' : '未配置'))) : null,
              h('p', { className: 'dsh-sync-help' }, config.includeAttachments ? '包含附件' : '不包含附件'),
              !config.ready ? h(Notice, { kind: 'warning' }, config.backend === 'sftp' ? 'SFTP 尚未就绪：上传与下载已禁用，本地预演仍可用。请检查本机授权安装包配置。' : 'Gitee 尚未就绪：上传与下载已禁用，本地预演仍可用。请通过现有配置入口检查仓库和令牌；本面板不读取或显示令牌。') : null) : null,
            h('section', { className: 'dsh-sync-card', 'aria-label': '新设备迁移' },
              h('h3', null, '新设备迁移'),
              h('p', null, '先一次公钥授权 → 下载安装包 → 下载到暂存区 → 完全退出 DSH 后执行离线安装 / 恢复。'),
              h('p', { className: 'dsh-sync-help' }, '新设备全量迁移仍走离线安装 / 恢复。SFTP 需先用授权安装包完成本机预配置；日常在线应用无需关闭 DSH，但不会安装缺失插件或替换运行时配置。')),
            data ? h('section', { className: 'dsh-sync-card', 'aria-labelledby': `${prefix}-plugin-updates-title` },
              h('h3', { id: `${prefix}-plugin-updates-title` }, '插件版本差异提醒'),
              h('p', { className: 'dsh-sync-help' }, '下载同步仅检查源机与本机版本并提出建议，不会自动安装、更新或启用插件。请选择具体插件，再单独确认。'),
              !data.pluginUpdateAvailable ? h(Notice, { kind: 'warning' }, '当前宿主的官方插件安装服务不可用；仍可查看差异建议，请通过宿主插件管理页安装或升级后重试。') : null,
              pluginPlan ? h('div', null,
                h('p', { className: 'dsh-sync-help' }, `快照：${pluginPlan.snapshot || '后台已检查的快照'}${when(pluginPlan.checkedAt) ? ` · 检查时间：${when(pluginPlan.checkedAt)}` : ''}`),
                pluginPlan.warnings.map((warning, index) => h(Notice, { key: index, kind: 'warning' }, warning)),
                pluginPlan.offers.length ? h('div', { className: 'dsh-sync-table-wrap', tabIndex: 0, role: 'region', 'aria-label': '插件版本差异，可横向滚动' },
                  h('table', null,
                    h('thead', null, h('tr', null, ['选择 / 插件', '本机版本', '源机版本', '来源 / 建议'].map((label) => h('th', { key: label, scope: 'col' }, label)))),
                    h('tbody', null, pluginPlan.offers.map((offer) => h('tr', { key: offer.id },
                      h('td', null,
                        offer.canInstall ? h('label', { className: 'dsh-sync-check' },
                          h('input', { type: 'checkbox', checked: selectedPluginIds.includes(offer.id), disabled: actionDisabled || !data.pluginUpdateAvailable,
                            'aria-label': `选择更新 ${offer.name}`, onChange: (event) => selectPlugin(offer.id, event.target.checked === true) }),
                          h('span', null, offer.name)) : h('strong', null, offer.name),
                        h('p', { className: 'dsh-sync-help' }, `配置：${offer.profile || '当前配置'}${offer.kind ? ` · ${offer.kind}` : ''}`)),
                      h('td', { className: 'dsh-sync-nowrap' }, offer.currentVersion === null ? '未安装' : offer.currentVersion || '版本未知'),
                      h('td', { className: 'dsh-sync-nowrap' }, offer.targetVersion),
                      h('td', null, h('p', null, offer.sourceLabel || '来源待核对'), h('p', null, offer.advice || '请核对兼容性与来源后决定。'),
                        offer.notes.map((note, index) => h('p', { className: 'dsh-sync-help', key: index }, note)),
                        !offer.canInstall ? h('p', { className: 'dsh-sync-warning' }, '此项只作提醒，不会在本面板执行。') : null))))))
                  : h('p', { className: 'dsh-sync-empty' }, '本次检查没有需要提示的插件版本差异。'),
                h('button', { type: 'button', className: 'dsh-sync-primary',
                  disabled: actionDisabled || !pluginTargetsAllowed(data, pluginPlanId, selectedPlugins.map((row) => row.id)),
                  onClick: confirmPluginSelection }, '确认更新所选插件'))
                : h('p', { className: 'dsh-sync-empty' }, '下载同步后会检查插件版本；目前没有待确认的提醒计划。')) : null,
            status ? h('section', { className: 'dsh-sync-stats', 'aria-label': '本机同步内容统计' },
              h('div', { className: 'dsh-sync-stat' }, h('strong', null, status.fileCount.toLocaleString('zh-CN')), h('span', null, '同步文件')),
              h('div', { className: 'dsh-sync-stat' }, h('strong', null, bytes(status.totalBytes)), h('span', null, '内容大小')),
              h('div', { className: 'dsh-sync-stat' }, h('strong', null, extras.length), h('span', null, '本机自定义项'))) : null,
            status && status.fileCount === 0 ? h(Notice, {}, '当前没有可同步的文件。可先添加工程/文件映射，再刷新查看。') : null,
            h('section', { className: 'dsh-sync-card', 'aria-label': '同步操作' },
              h('div', { className: 'dsh-sync-actions dsh-sync-main-actions' },
                h('button', { type: 'button', disabled: actionDisabled, onClick: (event) => openConfirm({ action: 'upload', dryRun: true }, event) }, '本地预演'),
                h('button', { type: 'button', className: 'dsh-sync-primary', disabled: actionDisabled || !config || !config.ready, onClick: (event) => openConfirm({ action: 'upload', dryRun: false }, event) }, '上传'),
                h('button', { type: 'button', className: 'dsh-sync-primary', disabled: actionDisabled || !config || !config.ready || !data || data.onlineAvailable !== true, onClick: (event) => openConfirm({ action: 'download', mode: 'online' }, event) }, '下载并在线应用'),
                h('button', { type: 'button', disabled: actionDisabled || !config || !config.ready, onClick: (event) => openConfirm({ action: 'download', mode: 'offline' }, event) }, '仅下载（离线恢复）')),
              h('p', { className: 'dsh-sync-help' }, '在线应用仅处理安全范围，无需关闭 DSH；请先完成当前任务并暂停其它编辑器写入。仅下载模式仍需退出 DSH 后离线恢复。本地预演会暂存但不推送。'),
              data && data.onlineAvailable !== true ? h(Notice, { kind: 'warning' }, '当前宿主未提供安全在线恢复接口，在线应用已禁用；仍可使用“仅下载（离线恢复）”。') : null,
              pendingApply ? h(Notice, { kind: 'warning' }, h('strong', null, '真实上传保护：有内容尚未确认完整应用'),
                h('p', null, pendingApply.reason),
                h('p', { className: 'dsh-sync-help' }, '上传会使用本机现状；不会先应用远端配置或其它未应用项。清除结果、本地预演和刷新都不会解除这项保护。')) : null,
              stage ? h('div', { className: 'dsh-sync-alert dsh-sync-progress', role: 'status', 'aria-live': 'polite' },
                h(Spinner), h('div', null, h('p', null, stage),
                  jobRunning ? h(StageProgress, { progress: job.progress, startedAt: job.startedAt }) : null,
                  jobRunning ? h('button', { type: 'button', className: 'dsh-sync-danger', disabled: !canCancel(state, job.id), onClick: () => { void store.post({ action: 'cancel', jobId: job.id }); } }, job.cancelRequested || (state.posting && state.activeAction === 'cancel') ? '取消中…' : '取消传输') : null,
                  h('p', { className: 'dsh-sync-help' }, '关闭面板不会取消已启动的后台任务。重新打开可继续查看。'))) : null),
            confirmation ? h('section', { className: 'dsh-sync-card dsh-sync-confirm', role: 'region', 'aria-labelledby': `${prefix}-confirm-title` },
              h('h3', { id: `${prefix}-confirm-title` }, confirmTitle),
              h('p', null, confirmText),
              confirmingPlugins ? h('ul', null, confirmation.rows.map((row) => h('li', { key: row.name }, `${row.name}：${row.currentVersion === null ? '未安装' : row.currentVersion || '版本未知'} → ${row.targetVersion}`))) : null,
              confirmingPlugins && !validPluginConfirmation ? h(Notice, { kind: 'warning', alert: true }, '插件计划已变化或安装服务不可用；本次确认已失效，请取消并刷新后重新选择。') : null,
              confirmation.action === 'upload' && config ? h('p', { className: 'dsh-sync-help' }, config.backend === 'sftp' ? `SFTP：${config.sftp.host}:${config.sftp.port} · 用户：${config.sftp.username} · 目录：${config.sftp.remoteRoot}` : `仓库：${config.repoUrl} · 分支：${config.branch || '未配置'}`) : null,
              confirmation.action === 'upload' && pendingApply ? h(Notice, { kind: 'warning', alert: true },
                h('strong', null, confirmation.dryRun ? '未应用项仍受保护' : '警告：上传可能丢弃远端未应用内容'),
                h('p', null, pendingApply.reason),
                h('p', null, confirmation.dryRun ? '本地预演不推送，也不会解除上传保护。' : '本次将用本机会话、工程和配置快照替换远端；不会先合并未应用项。请核对后再决定。'),
                !confirmation.dryRun ? h('label', { className: 'dsh-sync-check' },
                  h('input', { type: 'checkbox', checked: allowUnapplied, disabled, onChange: (event) => setAllowUnapplied(event.target.checked === true) }),
                  h('span', null, '我已核对未应用项，允许用本机快照替换远端（可能丢弃远端未应用内容）')) : null) : null,
              confirmation.action === 'upload' ? h('label', { className: 'dsh-sync-check' },
                h('input', { type: 'checkbox', checked: allowLarge, disabled, onChange: (event) => setAllowLarge(event.target.checked) }),
                h('span', null, '允许超出自定义项大小限制', config ? h('span', { className: 'dsh-sync-help' }, `（配置值 ${bytes(config.maxExtraBytes)}；默认不允许）`) : null)) : null,
              h('div', { className: 'dsh-sync-actions' },
                h('button', { type: 'button', ref: confirmFocus, className: confirmation.action === 'extra-remove' ? 'dsh-sync-danger' : 'dsh-sync-primary', disabled: disabled || picking || !validPluginConfirmation || (onlineConfirmation && (!data || data.onlineAvailable !== true)) || (needsUnappliedConsent && !allowUnapplied), onClick: () => { void acceptConfirm(); } },
                  state.posting ? '提交中…' : confirmingPlugins ? '同意并更新这些插件' : confirmation.action === 'extra-remove' ? '仅移除映射' : confirmation.action === 'download' ? (onlineConfirmation ? '确认下载并在线应用' : '确认仅下载到暂存区') : confirmation.dryRun ? '开始本地预演' : '确认上传'),
                h('button', { type: 'button', onClick: () => setConfirmation(null) }, '取消'))) : null,
            state.notice ? h(Notice, {}, state.notice) : null,
            h(Result, { job, dryRun: isDryRun, disabled: actionDisabled, onClear: () => { void store.post({ action: 'clear-result' }); } }),
            h('section', { className: 'dsh-sync-card', 'aria-labelledby': `${prefix}-extras-title` },
              h('div', { className: 'dsh-sync-row' },
                h('h3', { id: `${prefix}-extras-title` }, '自定义工程 / 文件'),
                h('button', { type: 'button', disabled: actionDisabled, onClick: () => startEditor(null, false), 'aria-expanded': Boolean(editor), 'aria-controls': formId }, '添加映射')),
              h('p', { className: 'dsh-sync-help' }, '不同电脑使用相同名称、各自的本地路径。目标可暂不存在，供恢复时使用。添加或编辑仅保存映射，不会自动上传或恢复。'),
              extras.length ? h('div', { className: 'dsh-sync-table-wrap', tabIndex: 0, role: 'region', 'aria-label': '本机自定义项，可横向滚动' },
                h('table', null,
                  h('thead', null, h('tr', null, ['名称 / 类型', '本地路径', '文件 / 大小', '操作'].map((label) => h('th', { key: label, scope: 'col' }, label)))),
                  h('tbody', null, extras.map((item) => h('tr', { key: item.name },
                    h('td', null, h('strong', null, redact(item.name)), h('div', { className: 'dsh-sync-help' }, item.kind === 'file' ? '文件' : '目录')),
                    h('td', { className: 'dsh-sync-path' }, redact(item.path),
                      item.missing ? h('div', { className: 'dsh-sync-warning' }, '路径不存在 · 可用于恢复') : null,
                      item.kind === 'directory' ? h('div', { className: 'dsh-sync-help' }, item.exclude ? (item.exclude.length ? `排除：${redact(item.exclude.join('、'))}` : '无排除项') : '使用默认排除规则') : null),
                    h('td', { className: 'dsh-sync-nowrap' }, `${item.files.toLocaleString('zh-CN')} 个`, h('div', { className: 'dsh-sync-help' }, bytes(item.bytes))),
                    h('td', null, h('div', { className: 'dsh-sync-actions' },
                      h('button', { type: 'button', disabled: actionDisabled, 'aria-label': `编辑 ${redact(item.name)}`, onClick: () => startEditor(item, false) }, '编辑'),
                      h('button', { type: 'button', className: 'dsh-sync-danger', disabled: actionDisabled, 'aria-label': `移除 ${redact(item.name)} 的本机映射`, onClick: (event) => openConfirm({ action: 'extra-remove', name: item.name }, event) }, '移除'))))))))
                : h('p', { className: 'dsh-sync-empty' }, data ? '尚无本机映射。添加工程目录或单个文件开始。' : '读取状态后可管理本机映射。'),
              editor ? h('form', { id: formId, onSubmit: saveExtra, 'aria-labelledby': `${prefix}-form-title` },
                h('h4', { id: `${prefix}-form-title` }, editor.originalName ? '编辑本机映射' : '添加本机映射'),
                h('fieldset', { disabled: actionDisabled },
                  h('div', { className: 'dsh-sync-form-grid' },
                    h('div', { className: 'dsh-sync-field' },
                      h('label', { htmlFor: `${prefix}-name` }, '名称'),
                      h('input', { id: `${prefix}-name`, ref: nameInput, required: true, value: editor.name, readOnly: Boolean(editor.originalName), autoComplete: 'off', spellCheck: false, onChange: (event) => changeEditor('name', event.target.value), 'aria-describedby': `${prefix}-name-help` }),
                      h('span', { id: `${prefix}-name-help`, className: 'dsh-sync-help' }, editor.originalName ? '编辑时名称固定；改名请新增映射。' : '字母、数字、点、下划线、短横。不同电脑使用同名。')),
                    h('div', { className: 'dsh-sync-field' },
                      h('label', { htmlFor: `${prefix}-kind` }, '类型'),
                      h('select', { id: `${prefix}-kind`, value: editor.kind, onChange: (event) => changeEditor('kind', event.target.value) },
                        h('option', { value: 'directory' }, '目录'), h('option', { value: 'file' }, '文件'))),
                    h('div', { className: 'dsh-sync-field is-full' },
                      h('label', { htmlFor: `${prefix}-path` }, '本地完整路径'),
                      h('div', { className: 'dsh-sync-input-row' },
                        h('input', { id: `${prefix}-path`, ref: pathInput, required: true, value: editor.targetPath, placeholder: editor.kind === 'directory' ? 'C:\\Work\\project' : 'C:\\Work\\notes.txt', autoComplete: 'off', spellCheck: false, onChange: (event) => changeEditor('targetPath', event.target.value), 'aria-describedby': `${prefix}-path-help` }),
                        editor.kind === 'directory' && canPick ? h('button', { type: 'button', disabled: picking, onClick: () => { void selectDirectory(); } }, picking ? '选择中…' : '选择目录') : null),
                      h('span', { id: `${prefix}-path-help`, className: 'dsh-sync-help' }, '可直接填写尚不存在的目标路径；不会自动创建或恢复文件。')),
                    editor.kind === 'directory' ? h('div', { className: 'dsh-sync-field is-full' },
                      h('label', { className: 'dsh-sync-check' },
                        h('input', { type: 'checkbox', checked: editor.useDefault, onChange: (event) => changeEditor('useDefault', event.target.checked) }), h('span', null, '使用默认排除规则')),
                      h('label', { htmlFor: `${prefix}-exclude` }, '排除列表'),
                      h('textarea', { id: `${prefix}-exclude`, value: editor.exclude, disabled: editor.useDefault, placeholder: 'node_modules\n.git\ndist', spellCheck: false, onChange: (event) => changeEditor('exclude', event.target.value), 'aria-describedby': `${prefix}-exclude-help` }),
                      h('span', { id: `${prefix}-exclude-help`, className: 'dsh-sync-help' }, '每行一项。关闭默认规则且留空表示不排除任何项，请谨慎。')) : null),
                  h('div', { className: 'dsh-sync-actions', style: { marginTop: 12 } },
                    h('button', { type: 'submit', className: 'dsh-sync-primary' }, '保存本机映射'),
                    h('button', { type: 'button', onClick: closeEditor }, '取消'))),
                formError ? h(Notice, { kind: 'error', alert: true }, formError) : null) : null),
            data ? h('section', { className: 'dsh-sync-card', 'aria-labelledby': `${prefix}-remote-title` },
              h('h3', { id: `${prefix}-remote-title` }, '远端工程 / 文件'),
              h('p', { className: 'dsh-sync-help' }, '以后台提供的远端清单为准；未映射的项目可指定本机路径。'),
              remoteExtras.length ? h('ul', { className: 'dsh-sync-remote-list' }, remoteExtras.map((item) => {
                const mapped = extras.some((local) => local.name === item.name);
                return h('li', { key: item.name },
                  h('div', null, h('strong', null, redact(item.name)), h('p', { className: 'dsh-sync-help' }, `${item.kind === 'file' ? '文件' : '目录'} · ${item.files.toLocaleString('zh-CN')} 个 · ${bytes(item.bytes)}`)),
                  mapped ? h('span', { className: 'dsh-sync-badge dsh-sync-success' }, '已映射') : h('button', { type: 'button', disabled: actionDisabled, onClick: () => startEditor(item, true) }, '映射到本机'));
              })) : h('p', { className: 'dsh-sync-empty' }, '暂无远端自定义项清单。')) : null,
            data && data.version ? h('p', { className: 'dsh-sync-help' }, `同步接口版本 ${redact(data.version)}`) : null));
        }

        function Modal({ onClose, returnFocus }) {
          const dialog = useRef(null), closeButton = useRef(null);
          const [titleId] = useState(() => `dsh-sync-dialog-${++nextId}`);
          useEffect(() => {
            const previous = returnFocus.current || document.activeElement;
            const previousOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            const focusable = () => dialog.current ? Array.from(dialog.current.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')).filter((node) => node.getClientRects().length && node.getAttribute('aria-hidden') !== 'true') : [];
            function onKey(event) {
              if (!dialog.current || event.defaultPrevented) return;
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
              if (event.key !== 'Tab') return;
              const nodes = focusable(), first = nodes[0], last = nodes[nodes.length - 1];
              if (!first) { event.preventDefault(); dialog.current.focus(); return; }
              if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
              else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
            }
            function onFocus(event) {
              if (dialog.current && !dialog.current.contains(event.target)) {
                const target = closeButton.current || dialog.current; target.focus();
              }
            }
            document.addEventListener('keydown', onKey);
            document.addEventListener('focusin', onFocus);
            if (closeButton.current) closeButton.current.focus();
            return () => {
              document.removeEventListener('keydown', onKey);
              document.removeEventListener('focusin', onFocus);
              if (document.body.style.overflow === 'hidden') document.body.style.overflow = previousOverflow;
              if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
            };
          }, [onClose, returnFocus]);
          const content = h('div', { className: 'dsh-sync-panel dsh-sync-modal-backdrop', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
            h('div', { className: 'dsh-sync-dialog', ref: dialog, role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId, tabIndex: -1 },
              h('header', { className: 'dsh-sync-dialog-header' },
                h('h2', { id: titleId }, '跨机同步'),
                h('button', { type: 'button', ref: closeButton, onClick: onClose, 'aria-label': '关闭跨机同步面板' }, '关闭')),
              h('div', { className: 'dsh-sync-dialog-body' }, h(Panel, { modal: true }))));
          return createPortal ? createPortal(content, document.body) : content;
        }
        function Shortcut({ wide }) {
          const state = useSyncState();
          const label = shortcutLabel(state);
          const [open, setOpen] = useState(false);
          const trigger = useRef(null);
          const close = useCallback(() => setOpen(false), []);
          return h(React.Fragment, null,
            h('button', { type: 'button', className: 'dsh-sync-panel dsh-sync-shortcut', ref: trigger, title: `跨机${label}`, 'aria-label': `跨机${label}`, 'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: () => setOpen(true) },
              h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
                h('path', { d: 'M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 19.5 9M4.5 15A8 8 0 0 0 17.9 17.9' })),
              h('span', { className: wide || running(state.data) ? undefined : 'dsh-sync-sr-only', 'aria-live': 'polite' }, label)),
            open ? h(Modal, { onClose: close, returnFocus: trigger }) : null);
        }

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'dsh-sync', order: 110, label: '跨机同步',
        }, Panel));
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'dsh-sync-shortcut', order: 110,
        }, Shortcut));
      },
    };
  },
});
