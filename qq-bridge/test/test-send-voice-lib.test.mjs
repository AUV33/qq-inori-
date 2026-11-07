// send-voice-lib 金标：它是 voice-core 的薄转发层，导出的每个名字都必须是同一份实现（不能各演化一份）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lib from '../src/domain/send/send-voice-lib.js';
import * as core from '../src/voice-core.js';

const EXPORTED = [
  'AUDIO_EXTS', 'DEFAULT_MAX_BYTES', 'DEFAULT_MAX_SECONDS', 'isAudioFile', 'formatBytes', 'formatDuration',
  'listAudioFiles', 'resolveAudioSource', 'safeJoinLibrary', 'probeAudio', 'inspectAudio', 'describeAudio',
  'parseTargetKey', 'sanitizeUploadName', 'uniqueLibraryPath', 'VOLUME_MIN', 'VOLUME_MAX', 'LOUDNESS_TARGETS',
  'resolveAudioProcessing', 'resolveFfmpeg', 'processAudioVolume', 'cleanupTemp',
];

test('导出的名字齐全，且与 voice-core 是同一份实现/同一份常量', () => {
  for (const name of EXPORTED) {
    assert.ok(name in lib, `send-voice-lib 缺少导出 ${name}`);
    assert.equal(lib[name], core[name], `${name} 必须与 voice-core 完全同一份（不能在转发层复制实现）`);
  }
});

test('转发层不引入多余导出（避免它偷偷长成第二份实现）', () => {
  const extra = Object.keys(lib).filter((k) => !EXPORTED.includes(k) && k !== 'default');
  assert.deepEqual(extra, []);
});
