import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_AI_SELECTION,
  filterSelectableAiModels,
  isSelectableAiModel,
  LOCAL_AI_MODEL,
  normalizeAiSelection,
} from './llmAi';

test('DeepSeek exposes queried non-Pro models and rejects Pro models', () => {
  assert.equal(isSelectableAiModel('deepseek', 'deepseek-v4-flash'), true);
  assert.equal(isSelectableAiModel('deepseek', 'deepseek-chat'), true);
  assert.equal(isSelectableAiModel('deepseek', 'deepseek-reasoner'), true);
  assert.equal(isSelectableAiModel('deepseek', 'deepseek-v4-pro'), false);
  assert.equal(isSelectableAiModel('deepseek', 'DEEPSEEK-PRO-FAST'), false);
  assert.deepEqual(
    filterSelectableAiModels('deepseek', [
      'deepseek-chat',
      'deepseek-v4-flash',
      'deepseek-reasoner',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ]),
    ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash'],
  );
  assert.deepEqual(
    normalizeAiSelection('deepseek', 'deepseek-chat'),
    { provider: 'deepseek', model: 'deepseek-chat' },
  );
  assert.deepEqual(normalizeAiSelection('deepseek', 'deepseek-v4-pro'), {
    provider: 'deepseek',
    model: '',
  });
  assert.deepEqual(normalizeAiSelection('deepseek', undefined), DEFAULT_AI_SELECTION);
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
