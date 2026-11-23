import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_AI_SELECTION,
  filterSelectableAiModels,
  isSelectableAiModel,
  LOCAL_AI_MODEL, HW_AI_MODEL,
  normalizeAiSelection,
  llmFindBestPlay, decodeModelDecision,
} from './llmAi';
import { generateLegalPlays, findSmartPlay } from './ai';
import { Rank, Suit } from '../../../shared/types';

test('HWCloud only exposes the selected gateway model', () => {
  assert.equal(isSelectableAiModel('hwcloud', 'HW-deepseek-v4.1-flash-1017'), true);
  assert.equal(isSelectableAiModel('hwcloud', 'HW-glm-5.3'), false);
  assert.equal(isSelectableAiModel('hwcloud', 'deepseek-v4-flash'), false);
  assert.equal(isSelectableAiModel('hwcloud', 'deepseek-v4-pro'), false);
  assert.equal(isSelectableAiModel('hwcloud', 'Qwen3.8-27'), false);
  assert.deepEqual(
    filterSelectableAiModels('hwcloud', [
      'deepseek-v4.1-flash',
      'HW-glm-5.3',
      'HW-deepseek-v4.1-flash-1017',
      'HW-glm-5.3',
    ]),
    ['HW-deepseek-v4.1-flash-1017'],
  );
  assert.deepEqual(
    normalizeAiSelection('hwcloud', 'HW-deepseek-v4.1-flash-1017'),
    { provider: 'hwcloud', model: 'HW-deepseek-v4.1-flash-1017' },
  );
  assert.deepEqual(normalizeAiSelection('hwcloud', 'HW-glm-5.3'), {
    provider: 'hwcloud',
    model: '',
  });
  assert.deepEqual(normalizeAiSelection('deepseek', undefined), {
    provider: 'deepseek', model: 'deepseek-v4-flash',
  });
  assert.deepEqual(DEFAULT_AI_SELECTION, { provider: 'fueternal', model: HW_AI_MODEL });
  assert.deepEqual(normalizeAiSelection(undefined, undefined), DEFAULT_AI_SELECTION);
  assert.deepEqual(normalizeAiSelection('local', undefined), { provider: 'local', model: LOCAL_AI_MODEL });
});

test('Local only exposes and accepts Qwen3.8-27', () => {
  assert.equal(isSelectableAiModel('local', LOCAL_AI_MODEL), true);
  assert.equal(isSelectableAiModel('local', 'qwen2.5-7b-instruct'), false);
  assert.equal(isSelectableAiModel('local', 'qwen-27B'), false);
  assert.equal(isSelectableAiModel('local', 'Qwen3.8-27B'), false);
  assert.deepEqual(
    filterSelectableAiModels('local', [
      'qwen-72b',
      'qwen-27B',
      LOCAL_AI_MODEL,
      LOCAL_AI_MODEL,
    ]),
    [LOCAL_AI_MODEL],
  );
  assert.deepEqual(normalizeAiSelection('local', 'qwen-32b'), {
    provider: 'local',
    model: '',
  });
});

test('HW provider accepts the discovered model and shares the Fueternal endpoint', () => {
  assert.deepEqual(normalizeAiSelection('fueternal', undefined), { provider: 'fueternal', model: HW_AI_MODEL });
  assert.deepEqual(filterSelectableAiModels('fueternal', [HW_AI_MODEL, LOCAL_AI_MODEL, 'HW-glm-5.3']), [HW_AI_MODEL]);
});

test('default Qwen request uses Fueternal credentials and disables thinking', async () => {
  const previousFetch = globalThis.fetch;
  const names = ['LOCAL_LLM_BASE_URL', 'LOCAL_LLM_API_KEY', 'FUETERNAL_API_KEY'] as const;
  const previous = names.map(name => process.env[name]);
  delete process.env.LOCAL_LLM_BASE_URL;
  delete process.env.LOCAL_LLM_API_KEY;
  process.env.FUETERNAL_API_KEY = 'test-only';
  const hand = [{ id: 0, suit: Suit.Spade, rank: Rank.Two }];
  const plays = generateLegalPlays(hand, Rank.Two);
  globalThis.fetch = (async (url, init) => {
    assert.equal(url, 'https://fueternal.com/api/v1/chat/completions');
    assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer test-only');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, 'Qwen3.8-27');
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.thinking, undefined);
    assert.equal(body.enable_thinking, false);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"action_id":0}' } }] }));
  }) as typeof fetch;
  try {
    assert.equal(await llmFindBestPlay(hand, plays, null, true, Rank.Two, undefined,
      { provider: 'local', model: LOCAL_AI_MODEL }), plays[0]);
  } finally {
    globalThis.fetch = previousFetch;
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});


test('model failover precedes local rules and keeps only the successful plan', async () => {
  const oldFetch = globalThis.fetch;
  const names = ['DEEPSEEK_API_KEY', 'LOCAL_LLM_API_KEY', 'DEEPSEEK_MODEL'] as const;
  const old = names.map(name => process.env[name]);
  process.env.DEEPSEEK_API_KEY = process.env.LOCAL_LLM_API_KEY = 'test-only';
  process.env.DEEPSEEK_MODEL = 'deepseek-flash';
  const hand = [0, 1, 2].map(id => ({ id, rank: Rank.Five, suit: Suit.Spade }));
  const last = { cards: [{ id: 99, rank: Rank.Three, suit: Suit.Spade }],
    type: 'single' as any, rank: Rank.Three, length: 1 };
  try {
    for (const scenario of [
      { primary: 'valid', backup: 'valid', calls: 1 },
      { primary: 'invalid', backup: 'valid', calls: 2 },
      { primary: 'http', backup: 'valid', calls: 2 },
      { primary: 'timeout', backup: 'valid', calls: 2 },
      { primary: 'invalid', backup: 'timeout', calls: 3 },
      { primary: 'invalid', backup: 'invalid', calls: 3 },
      { primary: 'pass', backup: 'valid', calls: 1 },
      { primary: 'invalid', backup: 'valid', calls: 2, reverse: true },
    ]) {
      const requests: any[] = [];
      let plan: any;
      globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        requests.push(body);
        const result = requests.length === 1 ? scenario.primary : scenario.backup;
        if (result === 'timeout') throw new DOMException('deadline', 'AbortError');
        if (result === 'http') return new Response('', { status: 503 });
        return new Response(JSON.stringify({ choices: [{ message: { content: result === 'invalid'
          ? '{broken' : JSON.stringify({ action_id: result === 'pass' ? 'PASS' : 0,
            strategy_plan: { next: body.model, reconsider_when: '对手报单' } }) } }] }));
      }) as typeof fetch;
      const primary = scenario.reverse ? { provider: 'local' as const, model: LOCAL_AI_MODEL }
        : { provider: 'deepseek' as const, model: 'deepseek-flash' };
      const result = await findSmartPlay(hand, scenario.primary === 'pass' ? last : null,
        scenario.primary !== 'pass', Rank.Two, undefined, primary, value => { plan = value; });
      assert.equal(requests.length, scenario.calls, JSON.stringify(scenario));
      assert.equal(requests[0].model, primary.model);
      if (requests.length === 2) {
        assert.equal(requests[1].model, HW_AI_MODEL);
        assert.equal(requests[1].messages[0].content, requests[0].messages[0].content);
        assert.deepEqual(JSON.parse(requests[1].messages[1].content.split('\n')[1]),
          JSON.parse(requests[0].messages[1].content.split('\n')[1]), 'same state, candidates and memory');
      }

      if (scenario.primary === 'pass') assert.ok(plan?.next, 'surviving hand gets a grounded continuation');
      else assert.equal(plan, undefined, 'a direct finish must not persist an invented continuation');
      if (scenario.primary === 'pass') assert.equal(result, null, 'valid PASS must not retry');
      else assert.equal(result?.cards.length, hand.length, 'both failed still produce a legal finish');
    }
  } finally {
    globalThis.fetch = oldFetch;
    names.forEach((name, i) => {
      if (old[i] === undefined) delete process.env[name];
      else process.env[name] = old[i];
    });
  }
});


test('default retries HW, Qwen and official DeepSeek in order', async t => {
  const oldLocal = process.env.LOCAL_LLM_API_KEY, oldDeepseek = process.env.DEEPSEEK_API_KEY;
  process.env.LOCAL_LLM_API_KEY = process.env.DEEPSEEK_API_KEY = 'test-only';
  t.after(() => {
    for (const [key, value] of [['LOCAL_LLM_API_KEY', oldLocal], ['DEEPSEEK_API_KEY', oldDeepseek]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  });
  const requests: Array<{ url: string; model: string }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    requests.push({ url, model: body.model });
    return requests.length < 3 ? new Response('', { status: 503 })
      : Response.json({ choices: [{ message: { content: '{"action_id":0}' } }] });
  });
  const hand = [0, 1, 2].map(id => ({ id, rank: Rank.Five, suit: Suit.Spade }));
  const result = await findSmartPlay(hand, null, true, Rank.Two);
  assert.deepEqual(requests.map(r => r.model), [HW_AI_MODEL, LOCAL_AI_MODEL, normalizeAiSelection('deepseek', '').model]);
  assert.ok(requests[0].url.includes('fueternal.com'));
  assert.ok(requests[2].url.includes('api.deepseek.com'));
  assert.equal(result?.cards.length, 3);
});

test('model failures are classified without treating missing actions as PASS', () => {
  const reply = (content: string, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content } }] });
  for (const [data, failure] of [
    [reply('{"action_id":0}', 'length'), 'truncated'],
    [reply(''), 'empty_content'],
    [reply('{broken'), 'invalid_json'],
    [reply('{"action_id":99}'), 'invalid_action'],
    [reply('{"action_id":null}'), 'invalid_action'],
    [reply('{"action_id":"PASS"}'), 'illegal_pass'],
  ] as const) assert.deepEqual(decodeModelDecision(data, 1, true), { failure });
  assert.equal((decodeModelDecision(reply('{"action_id":"PASS"}'), 1, false) as any).action, 'PASS');
  assert.equal((decodeModelDecision(reply('{"action_id":0}'), 1, true) as any).action, 0);
});
