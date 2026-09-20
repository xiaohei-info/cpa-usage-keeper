// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, fetchTurnStateOverview } from '@/lib/api';
import { TurnStatePanel } from '../TurnStatePanel';
import fixture from '../../../../../internal/codexproxy/testdata/turn_state_overview.json';
import type { TurnStateOverview } from '@/lib/turnState';
vi.mock('@/lib/api', () => ({ fetchTurnStateOverview: vi.fn(), fetchModelSubstitution: vi.fn(), ApiError: class extends Error { constructor(message: string, public status: number) { super(message); } } }));
// 模型替换面板会画 canvas；这里只验证它被挂载在 Turn-State 页上，不需要真实渲染图表。
vi.mock('react-chartjs-2', () => ({ Chart: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('shows read-only snapshot, unknown usage, epoch resets and stale failure; pauses hidden polling and cancels on unmount', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers(); vi.setSystemTime(new Date(fixture.server_time));
  let hidden = false; vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  const fetcher = vi.mocked(fetchTurnStateOverview);
  const active = { usable: true, length: 184, blocks: 10, fingerprint: 'abcdef012345', issued_at: fixture.server_time, expires_at: '2026-09-22T01:00:00Z', route_id: null, version: 1 };
  fetcher.mockResolvedValue({ ...fixture, sessions: [{ ...fixture.sessions[0], active, ready: { ...active, version: 2 } }] } as TurnStateOverview);
  const node = document.createElement('div'); const root = createRoot(node);
  await act(async () => root.render(<TurnStatePanel />));
  expect(node.textContent).toContain('turn_state.current'); expect(node.textContent).toContain('turn_state.unknown');
  expect(node.textContent).toContain('turn_state.overview_ready');
  expect(node.textContent).toContain('turn_state.state_ready'); expect(node.textContent).toContain('turn_state.backup_state');
  // Turn-State 快照本身仍然只读；页面上唯一的交互控件是模型替换观测的范围选择器。
  const controls = [...node.querySelectorAll('button, input, a')];
  expect(controls.every((control) => control.getAttribute('aria-pressed') !== null)).toBe(true);
  fetcher.mockRejectedValueOnce(new Error('private error'));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(node.textContent).toContain('turn_state.stale'); expect(node.textContent).not.toContain('private error');
  fetcher.mockResolvedValue({ ...fixture, epoch: 'runtime-2' } as TurnStateOverview);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(node.textContent).toContain('turn_state.current');
  hidden = true; await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  const count = fetcher.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); expect(fetcher).toHaveBeenCalledTimes(count);
  hidden = false; fetcher.mockImplementation(() => new Promise(() => {}));
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  const signal = fetcher.mock.calls.at(-1)?.[0]; await act(async () => root.unmount()); expect(signal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000); expect(fetcher).toHaveBeenCalledTimes(count + 1);
});
it('reports unavailable without zero counts and preserves Keeper authentication handling', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(fetchTurnStateOverview).mockRejectedValue(new ApiError('private error', 401));
  const onAuthRequired = vi.fn(); const node = document.createElement('div'); const root = createRoot(node);
  await act(async () => root.render(<TurnStatePanel onAuthRequired={onAuthRequired} />));
  expect(node.textContent).toContain('turn_state.unavailable'); expect(node.textContent).not.toContain('turn_state.counters'); expect(onAuthRequired).toHaveBeenCalledOnce();
  // 模型替换观测只读 Keeper 自己的历史，proxy 概览不可用时也必须继续渲染。
  expect(node.textContent).toContain('turn_state.model_sub_title');
  await act(async () => root.unmount());
});
