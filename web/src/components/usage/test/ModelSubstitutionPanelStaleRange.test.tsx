// @vitest-environment happy-dom

/**
 * Regression for the review's P1: after a failed refresh the panel kept the
 * previous payload but highlighted the newly clicked range, so the header
 * labelled 30d while every number on screen still belonged to 24h.
 */
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelSubstitutionResponse } from '@/lib/modelSubstitution';
import { ModelSubstitutionPanel } from '../ModelSubstitutionPanel';

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
  truncated: false,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('ModelSubstitutionPanel stale range labelling', () => {
  it('keeps the previous range active when the new range fails to load', async () => {
    let call = 0;
    fetchModelSubstitution.mockImplementation(async () => {
      call += 1;
      if (call === 1) return payload('24h');
      throw new Error('upstream unavailable');
    });

    await act(async () => { root.render(<ModelSubstitutionPanel />); });
    await act(async () => { await Promise.resolve(); });

    const rangeButton = (label: string) => Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === label);
    const activeLabels = () => Array.from(container.querySelectorAll('button'))
      .filter((button) => button.getAttribute('aria-pressed') === 'true')
      .map((button) => button.textContent);

    // The first successful payload was 24h.
    expect(activeLabels()).toContain('turn_state.model_sub_range_24h');

    // Clicking 30d fails; the displayed numbers are still the 24h payload, so the
    // active pill must not move to 30d and the panel must say the data is stale.
    await act(async () => { rangeButton('turn_state.model_sub_range_30d')?.click(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    expect(call).toBeGreaterThan(1);
    expect(activeLabels()).toContain('turn_state.model_sub_range_24h');
    expect(activeLabels()).not.toContain('turn_state.model_sub_range_30d');
    expect(container.querySelector('[data-model-subscription-stale]')).not.toBeNull();
  });
});
