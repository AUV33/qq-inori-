// 图片/表情包「看了可以记」提示（纯函数）自检：
// 纪律同黑话判定队列——只递事实+许可；空窗必须 null（不造暗示）。
import assert from 'node:assert/strict';
import { imageHintLine } from '../src/domain/leaves/inori-media-hint.js';
import { stickerEmptyBoxHint } from '../src/domain/send/sticker-lib.js';

let passed = 0;
function ok(name) { passed += 1; console.log(`✅ ${name}`); }

// 1. 图片提示：有图才递，数量正确，给两条路（看/记）+ 许可
{
  const recent = [
    { text: '早', isSelf: false },
    { text: '[图片]', isSelf: false },
    { text: '看看这个', isSelf: false, hasMedia: true, media: [{ type: 'image' }] },
    { text: '图2', isSelf: false, media: [{ type: 'image' }, { type: 'image' }] },
  ];
  const line = imageHintLine(recent, 30);
  assert.ok(line, '有图必须递提示');
  assert.match(line, /3 张图/, '三张图（占位符/hasMedia/media 三判据去重）');
  assert.ok(line.includes('qq_get_message_images'), '给看图的路');
  assert.ok(line.includes('qq_memory_append'), '给记录的路');
  assert.ok(line.includes('theme 写那张图') || line.includes('theme=那张图'), '记法要落到 theme');
  assert.ok(line.includes('随你'), '许可里含「可不做」');
  ok('imageHintLine 有图时事实+许可');
}

// 2. 图片提示：空窗必须 null（不造暗示）
{
  assert.equal(imageHintLine([], 30), null, '空列表 null');
  assert.equal(imageHintLine([{ text: '早', isSelf: false }], 30), null, '无图 null');
  assert.equal(imageHintLine(null), null, 'null 输入 null');
  ok('imageHintLine 空窗 null');
}

// 3. 图片提示：只统计窗口内
{
  const old = [{ text: '[图片]', isSelf: false }];
  const now = Array.from({ length: 40 }, (_, i) => ({ text: `新 ${i}`, isSelf: false }));
  const recent = [...old, ...now];
  assert.equal(imageHintLine(recent, 30), null, '窗口外的图不算');
  ok('imageHintLine 窗口生效');
}

// 3b. [EYE-1] 提示要能直接照着调：带会话 key + 最新一张的 messageId
{
  const recent = [
    { text: '[图片]', isSelf: false, messageId: '111' },
    { text: '[图片]', isSelf: false, messageId: '222' },
  ];
  const line = imageHintLine(recent, 30, { key: 'group:123456789' });
  assert.ok(line.includes('messageId="222"'), '要带最新那张的 messageId（不是最旧）');
  assert.ok(line.includes('key="group:123456789"'), '要带会话 key，她照着调不用猜');
  ok('imageHintLine 带上 key + messageId');
}

// 4. 表情包空盒提示：全空才递
{
  const empty = [
    { id: 'a', content: 'a', desc: '', localNote: '', tags: [] },
    { id: 'b', content: 'b', desc: '', localNote: '', tags: [] },
  ];
  const line = stickerEmptyBoxHint(empty, 8);
  assert.ok(line, '全空盒必须递提示');
  assert.match(line, /2 张/, '报数量');
  assert.ok(line.includes('qq_get_sticker_image'), '给看图的路');
  assert.ok(line.includes('qq_sticker_note'), '给记录的路');
  assert.ok(line.includes('不想看就让它空着') || line.includes('不想看'), '许可含「可不做」');
  ok('stickerEmptyBoxHint 全空盒时事实+许可');
}

// 5. 表情包空盒提示：有一张带备注就不再提醒；空库也 null
{
  const some = [
    { id: 'a', content: 'a', desc: '笑到打鸣', localNote: '', tags: [] },
    { id: 'b', content: 'b', desc: '', localNote: '', tags: [] },
  ];
  assert.equal(stickerEmptyBoxHint(some, 8), null, '有备注就不再提醒');
  const onlyNote = [
    { id: 'a', content: 'a', desc: '', localNote: '群里的暗号', tags: [] },
    { id: 'b', content: 'b', desc: '', localNote: '', tags: [] },
  ];
  assert.equal(stickerEmptyBoxHint(onlyNote, 8), null, 'localNote 也算看过');
  assert.equal(stickerEmptyBoxHint([], 8), null, '空库 null');
  assert.equal(stickerEmptyBoxHint(null, 8), null, 'null 输入 null');
  ok('stickerEmptyBoxHint 非全空则 null');
}

console.log(`\n🎉 图片/表情包提示测试通过（${passed} 项）`);
