// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestEventsDetailsCard } from '../RequestEventsDetailsCard';
import type { UsageEvent } from '@/lib/types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const event: UsageEvent = {
  id: 'settings-observability',
  timestamp: '2026-09-21T10:00:00+08:00',
  model: 'gpt-5',
  upstream_model: 'gpt-5',
  state_check: 'ok',
  source: 'Provider A',
  failed: false,
  tokens: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 2 },
};

const baseProps: React.ComponentProps<typeof RequestEventsDetailsCard> = {
  events: [],
  loading: false,
  totalCount: 0,
  modelOptions: [],
  sourceOptions: [],
  modelFilter: '__all__',
  sourceFilter: '__all__',
  resultFilter: '__all__',
  onModelFilterChange: () => undefined,
  onSourceFilterChange: () => undefined,
  onResultFilterChange: () => undefined,
};

describe('observability columns in the column settings panel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('offers both columns and defaults them to visible', async () => {
    await act(async () => root.render(<RequestEventsDetailsCard {...baseProps} />));
    const trigger = document.querySelector<HTMLButtonElement>('[data-request-events-column-settings-trigger]');
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    for (const columnId of ['upstream_model', 'state_check']) {
      const toggle = document.querySelector<HTMLInputElement>(`[data-request-events-column-visibility="${columnId}"]`);
      expect(toggle).not.toBeNull();
      expect(toggle?.checked).toBe(true);
    }

    const rows = [...document.querySelectorAll('[data-request-events-column-row]')]
      .map((row) => row.getAttribute('data-request-events-column-row'));
    expect(rows.slice(3, 6)).toEqual(['model', 'upstream_model', 'state_check']);
  });

  it('keeps a hidden observability column out of the table', async () => {
    await act(async () => root.render(
      <RequestEventsDetailsCard
        {...baseProps}
        events={[event]}
        totalCount={1}
        visibleColumnIds={['model', 'state_check']}
      />,
    ));

    const headers = [...document.querySelectorAll('th')].map((header) => header.textContent);
    expect(headers).toEqual(['Model', 'State Check']);
  });
});
