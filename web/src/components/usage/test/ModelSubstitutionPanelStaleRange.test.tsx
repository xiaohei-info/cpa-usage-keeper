// @vitest-environment happy-dom

/**
 * Regression for the review's P1: after a failed refresh the panel kept the
 * previous payload but highlighted the newly clicked range, so the header
 * labelled 30d while every number on screen still belonged to 24h.
 *
 * 时间维度按钮现在由父级（合并总表卡片）持有，本组件只消费控制器；
 * 因此这里直接驱动控制器，并断言失败刷新后仍然显示上一份数据且标出过期。
 */
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelSubstitutionRangeSelection, ModelSubstitutionResponse } from '@/lib/modelSubstitution';
import { ModelSubstitutionPanel, useModelSubstitution } from '../ModelSubstitutionPanel';

const fetchModelSubstitution = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, fetchModelSubstitution: (...args: unknown[]) => fetchModelSubstitution(...args) };
});

vi.mock('react-chartjs-2', () => ({ Chart: () => null }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

const payload = (range: string): ModelSubstitutionResponse => ({
  schema: 'cpa-usage-keeper.turn-state-model-mismatch.v1',
  range,
  window_start: '2026-09-20T00:00:00Z',
  window_end: '2026-09-21T00:00:00Z',
  bucket_seconds: 3600,
  summary: { requests_with_model: 3, matched: 1, mismatched: 2, match_rate: 33.3, empty: false, top_substitution: null },
  series: [],
  matrix: [],
  substitutions: [],
  current: [],
  truncated: false,
});

let container: HTMLDivElement;
let root: Root;
let selectRange: ((selection: ModelSubstitutionRangeSelection) => void) | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  selectRange = null;
  vi.clearAllMocks();
});

describe('ModelSubstitutionPanel stale range labelling', () => {
  it('keeps the previous data and flags it stale when the new range fails to load', async () => {
    let call = 0;
    fetchModelSubstitution.mockImplementation(async () => {
      call += 1;
      if (call === 1) return payload('24h');
      throw new Error('upstream unavailable');
    });

    const Harness = () => {
      const controller = useModelSubstitution();
      selectRange = controller.selectRange;
      return <ModelSubstitutionPanel controller={controller} />;
    };
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await Promise.resolve(); });

    // 第一次成功后必须已渲染上一份数据。
    expect(container.textContent).toContain('turn_state.model_sub_coverage');

    // 切到一个会失败的范围：数字仍是上一份，因此必须标出过期而不是静默当成新范围。
    await act(async () => { selectRange!('30d'); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    expect(call).toBeGreaterThan(1);
    expect(container.querySelector('[data-model-subscription-stale]')).not.toBeNull();
    expect(container.querySelector('[data-model-subscription-coverage]')).not.toBeNull();
  });
});
