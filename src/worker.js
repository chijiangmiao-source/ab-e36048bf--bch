/**
 * worker.js — 离线复核 Worker
 * 所有有限域/BCH 计算都在 Worker 内完成，页面线程只负责渲染。
 * 与 Node 测试共用同一份 src/lib 实现，保证位序与规则完全一致。
 */
import { decodeBch } from './lib/bch.js';

self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'decode') return;
  let result;
  try {
    result = decodeBch(msg.input);
  } catch (e) {
    result = {
      ok: false,
      stage: 'fatal',
      reason: `复核过程发生未预期错误：${e && e.message ? e.message : String(e)}`,
    };
  }
  self.postMessage({ type: 'result', id: msg.id, result });
};
