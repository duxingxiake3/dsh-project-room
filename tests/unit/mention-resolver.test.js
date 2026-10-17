/**
 * Mention resolver unit tests — the special-input table and the acceptance
 * cases that are decidable without a host.
 *
 * Every case here is a rule the product promises; if one of these changes the
 * user-visible behaviour changed, so the test is the specification.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MentionResolver,
  extractAtTokens,
  maskBody,
  mergeMentions,
  segmentsForDisplay,
  stripMentionSyntax,
} from '../../shared/mention-resolver.js';

/** The canonical four-agent room used throughout the acceptance cases. */
const MEMBERS = [
  {
    id: 'member_coordinator',
    kind: 'agent',
    role: 'coordinator',
    displayName: '主代理',
    handle: 'coordinator',
    aliases: ['队长'],
    status: 'idle',
  },
  {
    id: 'member_frontend',
    kind: 'agent',
    role: 'frontend',
    displayName: '前端·阿青',
    handle: 'frontend',
    aliases: ['前端', '阿青'],
    status: 'idle',
  },
  {
    id: 'member_backend',
    kind: 'agent',
    role: 'backend',
    displayName: '后端·阿北',
    handle: 'backend',
    aliases: ['后端', '阿北'],
    status: 'idle',
  },
  {
    id: 'member_tester',
    kind: 'agent',
    role: 'tester',
    displayName: '测试·小满',
    handle: 'tester',
    aliases: ['测试'],
    status: 'idle',
  },
  { id: 'member_user', kind: 'human', role: 'owner', displayName: '我', handle: 'user', aliases: ['老板'], status: 'idle' },
];

function resolver(members = MEMBERS, extra = {}) {
  return new MentionResolver({ members, membershipRevision: 3, ...extra });
}

/** Resolve a body and return the ordered target member ids. */
function targetsOf(body, members = MEMBERS, structured = []) {
  const merged = mergeMentions({ body, mentions: structured, resolver: resolver(members), membershipRevision: 3 });
  return {
    ids: merged.targets.map((target) => target.targetMemberId),
    origins: merged.targets.map((target) => target.origin),
    unknown: merged.unknownText,
    ambiguous: merged.ambiguous,
    hints: merged.hints,
  };
}

describe('mention resolver — the three legal input paths', () => {
  it('@后端, @backend and ＠后端 all reach the same member', () => {
    for (const body of ['@后端 接口好了吗', '@backend 接口好了吗', '＠后端 接口好了吗', '@BACKEND 接口好了吗']) {
      const result = targetsOf(body);
      assert.deepEqual(result.ids, ['member_backend'], `body: ${body}`);
    }
  });

  it('an avatar chip and a matching typed mention deliver once', () => {
    const result = targetsOf('@backend 麻烦看下', MEMBERS, [
      { targetMemberId: 'member_backend', origin: 'avatar', displaySnapshot: '后端·阿北', span: null },
    ]);
    assert.deepEqual(result.ids, ['member_backend']);
    assert.equal(result.ids.length, 1, 'same member twice must not double-deliver');
  });

  it('a picker chip resolves without any text at all', () => {
    const result = targetsOf('', MEMBERS, [
      { targetMemberId: 'member_frontend', origin: 'picker', displaySnapshot: '前端·阿青', span: null },
    ]);
    assert.deepEqual(result.ids, ['member_frontend']);
    assert.deepEqual(result.origins, ['picker']);
  });

  it('the same member named by handle and alias yields one target', () => {
    const result = targetsOf('@backend @后端 @阿北 三方确认一下');
    assert.deepEqual(result.ids, ['member_backend']);
  });

  it('@用户 reaches the human member and never an agent', () => {
    const result = targetsOf('@用户 这条只是通知你');
    assert.deepEqual(result.ids, ['member_user']);
  });
});

describe('mention resolver — boundaries and structure', () => {
  it('emails, code, quotes and links do not wake anyone', () => {
    const cases = [
      '请发到 dev@example.com 这个邮箱',
      'npm 包是 @scope/pkg 的那一个',
      '```\n@前端 这段在代码块里\n```',
      '`@前端` 是行内代码',
      '> @前端 这是引用别人的话',
      '看这个链接 https://example.com/@前端/x',
      '[文档](https://example.com/@后端) 里写了',
    ];
    for (const body of cases) {
      const result = targetsOf(body);
      assert.deepEqual(result.ids, [], `body: ${body}`);
    }
  });

  it('a normal @ after punctuation is live text', () => {
    assert.deepEqual(targetsOf('@前端，接口字段怎么变了？').ids, ['member_frontend']);
    assert.deepEqual(targetsOf('（@后端）请确认').ids, ['member_backend']);
    assert.deepEqual(targetsOf('@前端 @后端 你们对齐一下').ids, ['member_frontend', 'member_backend']);
  });

  it('rule 8: @前端你先看看 is reported, never split or guessed', () => {
    const result = targetsOf('@前端你先看看这个');
    assert.deepEqual(result.ids, []);
    assert.equal(result.unknown.length, 1);
    assert.equal(result.hints.length, 1);
    assert.match(result.hints[0], /加空格或标点/);
    assert.match(result.hints[0], /@前端/);
  });

  it('a bracketed name with a space resolves exactly', () => {
    const members = [
      ...MEMBERS,
      { id: 'member_design', kind: 'agent', role: 'designer', displayName: '设计·小林', handle: 'design', aliases: ['前端 小林'], status: 'idle' },
    ];
    assert.deepEqual(targetsOf('@「前端 小林」麻烦看下', members).ids, ['member_design']);
    // Without brackets, only the complete alias before the space resolves.
    assert.deepEqual(targetsOf('@前端 小林 麻烦看下', members).ids, ['member_frontend']);
  });

  it('duplicate display names are ambiguous, not guessed', () => {
    const members = [
      ...MEMBERS,
      { id: 'member_wang_a', kind: 'agent', role: 'frontend', displayName: '小王', handle: 'wang-a', aliases: [], status: 'idle' },
      { id: 'member_wang_b', kind: 'agent', role: 'backend', displayName: '小王', handle: 'wang-b', aliases: [], status: 'idle' },
    ];
    const result = targetsOf('@小王 帮忙看下', members);
    assert.deepEqual(result.ids, []);
    assert.equal(result.ambiguous.length, 1);
    assert.deepEqual(result.ambiguous[0].candidates.sort(), ['member_wang_a', 'member_wang_b']);
  });

  it('/ rule 12: a retired alias is a tombstone, not a new member', () => {
    const instance = new MentionResolver({
      members: [
        ...MEMBERS,
        { id: 'member_new', kind: 'agent', role: 'tester', displayName: '新测试', handle: 'tester2', aliases: ['小满'], status: 'idle' },
      ],
      membershipRevision: 4,
      tombstones: ['小满'],
    });
    const merged = mergeMentions({ body: '@小满 看下这个', resolver: instance });
    assert.deepEqual(merged.targets.map((target) => target.targetMemberId), []);
    assert.equal(merged.unknownText.length, 1);
  });

  it('bound mentions keep their memberId after a rename', () => {
    const before = resolver();
    const after = new MentionResolver({
      members: MEMBERS.map((member) =>
        member.id === 'member_backend' ? { ...member, displayName: '后端·老北', aliases: ['后端'] } : member,
      ),
      membershipRevision: 4,
    });
    const chip = { targetMemberId: 'member_backend', origin: 'avatar', displaySnapshot: '后端·阿北', span: null };
    // The chip is passed through unchanged on both revisions.
    assert.deepEqual(mergeMentions({ body: '', mentions: [chip], resolver: before }).targets[0].targetMemberId, 'member_backend');
    assert.deepEqual(mergeMentions({ body: '', mentions: [chip], resolver: after }).targets[0].targetMemberId, 'member_backend');
  });

  it('a stale membership revision is reported instead of guessed', () => {
    const merged = mergeMentions({ body: '@后端 在吗', resolver: resolver(), membershipRevision: 2 });
    assert.equal(merged.stale, true);
  });
});

describe('mention resolver — expansion and hygiene', () => {
  it('@所有人 expands to the active agent snapshot', () => {
    const members = MEMBERS.map((member) =>
      member.id === 'member_tester' ? { ...member, status: 'offline' } : member,
    );
    const result = targetsOf('@所有人 同步一下进度', members);
    assert.deepEqual(result.ids, ['member_coordinator', 'member_frontend', 'member_backend']);
    assert.equal(result.ids.includes('member_user'), false, 'the human is not an AI member to wake');
  });

  it('@all is the same expansion as @所有人', () => {
    assert.deepEqual(targetsOf('@all 同步').ids, targetsOf('@所有人 同步').ids);
  });

  it('an unknown name is reported, never redirected to the coordinator', () => {
    const result = targetsOf('@不存在的人 你好');
    assert.deepEqual(result.ids, []);
    assert.equal(result.unknown.length, 1);
  });

  it('a lone @ or a trailing @ is inert', () => {
    assert.deepEqual(targetsOf('@ 就这样').ids, []);
    assert.deepEqual(targetsOf('结束了 @').ids, []);
  });

  it('extractAtTokens keeps UTF-16 offsets against the original body', () => {
    const body = '😀 @后端 请看';
    const tokens = extractAtTokens(body);
    assert.equal(tokens.length, 1);
    assert.equal(body.slice(tokens[0].start, tokens[0].end), '@后端');
  });

  it('maskBody marks quoted and fenced ranges, not ordinary text', () => {
    const body = 'a @前端 b\n> @后端 c\n`@测试`';
    const masked = maskBody(body);
    assert.equal(masked[body.indexOf('@前端')], 0);
    assert.equal(masked[body.indexOf('@后端')], 1);
    assert.equal(masked[body.indexOf('@测试')], 1);
  });

  it('display segments follow the resolved spans exactly', () => {
    const merged = mergeMentions({ body: '@后端 接口好了吗', resolver: resolver() });
    const segments = segmentsForDisplay('@后端 接口好了吗', merged.targets);
    assert.deepEqual(
      segments.map((segment) => segment.text),
      ['@后端', ' 接口好了吗'],
    );
    assert.equal(segments[0].mention.targetMemberId, 'member_backend');
  });

  it('stripMentionSyntax produces a readable preview', () => {
    assert.equal(stripMentionSyntax('@后端 接口字段怎么变了？'), '接口字段怎么变了？');
  });
});
