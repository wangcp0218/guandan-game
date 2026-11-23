import assert from 'node:assert/strict';
import test from 'node:test';
import { PatternType, Suit } from '../../../shared/types';
import type { CardPattern } from '../../../shared/types';
import { llmFindBestPlay } from './llmAi';
import { findSmartPlay } from './ai';
import { getAiTelemetrySnapshot, resetAiTelemetry } from './aiTelemetry';

const play: CardPattern = {
  type: PatternType.Single, rank: 3, length: 1,
  cards: [{ id: 1, rank: 3, suit: Suit.Spade }],
};

async function withResponse(data: unknown, check: (logs: string[]) => Promise<void>) {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousInfo = console.info;
  const previousWarn = console.warn;
  const logs: string[] = [];
  process.env.DEEPSEEK_API_KEY = 'test-only';
  resetAiTelemetry();
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.reasoning_effort, undefined);
    return { ok: true, json: async () => data } as Response;
  }) as typeof fetch;
  console.info = console.warn = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    await check(logs);
  } finally {
    globalThis.fetch = previousFetch;
    console.info = previousInfo;
    console.warn = previousWarn;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
}

const choose = () => llmFindBestPlay(play.cards, [play], null, true, 5,
  undefined, { provider: 'deepseek', model: 'deepseek-flash' });

test('empty truncated response falls back and logs token metadata without reasoning text', async () => {
  await withResponse({
    choices: [{ finish_reason: 'length', message: {
      content: '', reasoning_content: 'private-reasoning',
    } }],
    usage: { prompt_tokens: 4618, completion_tokens: 4096,
      completion_tokens_details: { reasoning_tokens: 4096 } },
  }, async logs => {
    assert.equal(await choose(), undefined);
    const metadataLine = logs.find(line => line.startsWith('[LLM AI response] '))!;
    const metadata = JSON.parse(metadataLine.slice('[LLM AI response] '.length));
    assert.equal(metadata.finishReason, 'length');
    assert.equal(metadata.completionTokens, 4096);
    assert.equal(metadata.reasoningTokens, 4096);
    assert.equal(metadata.contentLength, 0);
    assert.ok(logs.some(line => line.includes('output_token_limit')));
    assert.ok(logs.every(line => !line.includes('private-reasoning')));
    assert.equal(getAiTelemetrySnapshot().modelOutcomes.invalid_response, 1);
  });
});

test('truncated response is rejected even if its JSON happens to be parseable', async () => {
  await withResponse({ choices: [{ finish_reason: 'length', message: {
    content: '{"action_id":0}',
  } }] }, async () => {
    assert.equal(await choose(), undefined);
    assert.equal(getAiTelemetrySnapshot().modelOutcomes.invalid_response, 1);
    assert.equal(getAiTelemetrySnapshot().modelOutcomes.success, 0);
  });
});

test('JSON-mode whitespace is reported as empty content', async () => {
  await withResponse({ choices: [{ finish_reason: 'stop', message: { content: '  \n ' } }] }, async logs => {
    assert.equal(await choose(), undefined);
    assert.ok(logs.some(line => line.includes('empty_content')));
    assert.equal(getAiTelemetrySnapshot().modelOutcomes.invalid_response, 1);
  });
});

test('finished JSON still selects the requested legal action', async () => {
  await withResponse({ choices: [{ finish_reason: 'stop', message: { content: '{"action_id":0}' } }] }, async () => {
    assert.equal(await choose(), play);
    assert.equal(getAiTelemetrySnapshot().modelOutcomes.success, 1);
    assert.equal(getAiTelemetrySnapshot().modelOutcomes.invalid_response, 0);
  });
});

test('finished malformed JSON falls back without losing response diagnostics', async () => {
  await withResponse({ choices: [{ finish_reason: 'stop', message: { content: '{bad json}' } }] }, async logs => {
    assert.equal(await choose(), undefined);
    assert.ok(logs.some(line => line.startsWith('[LLM AI response] ')));
    assert.equal(getAiTelemetrySnapshot().modelOutcomes.invalid_response, 1);
  });
});

test('non-forced follow still calls the model and honors its PASS with thinking disabled', async () => {
  await withResponse({ choices: [{ finish_reason: 'stop', message: { content: '{"action_id":"PASS"}' } }] }, async () => {
    const result = await findSmartPlay([
      ...play.cards, { id: 2, rank: 4, suit: Suit.Club },
    ], { type: PatternType.Single, rank: 2, length: 1,
      cards: [{ id: 0, rank: 2, suit: Suit.Diamond }],
    }, false, 5, undefined, { provider: 'deepseek', model: 'deepseek-flash' });
    assert.equal(result, null);
    const telemetry = getAiTelemetrySnapshot();
    assert.equal(telemetry.modelCalls, 1);
    assert.equal(telemetry.modelOutcomes.pass, 1);
  });
});
