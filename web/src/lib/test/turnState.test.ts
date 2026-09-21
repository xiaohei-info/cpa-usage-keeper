// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { fetchTurnStateOverview, ApiError } from '../api';
import { isTurnStateOverview } from '../turnState';
import { getUsageTabPath, resolveUsageTabFromPath } from '../usageNavigation';
import fixture from '../../../../internal/codexproxy/testdata/turn_state_overview.json';
afterEach(() => { vi.unstubAllGlobals(); delete window.__APP_BASE_PATH__; });
it('validates frozen DTO including required unknowns and bounded arrays', () => {
 expect(isTurnStateOverview(fixture)).toBe(true);
 expect(isTurnStateOverview({ ...fixture, summary: {} })).toBe(false);
 expect(isTurnStateOverview({ ...fixture, sessions: Array(1001).fill(fixture.sessions[0]) })).toBe(false);
 expect(isTurnStateOverview({ ...fixture, events: [{...fixture.events[0], usage: {}}] })).toBe(false);
 expect(isTurnStateOverview({ ...fixture, schema: 'old' })).toBe(false);
 expect(getUsageTabPath('turn-state')).toBe('/turn-state'); expect(resolveUsageTabFromPath('/turn-state')).toBe('turn-state');
});
// 契约 §8.2/§8.3：新字段全部可加性，旧 proxy 缺字段时快照必须仍然有效。
it('accepts the additive session and event fields from the frozen contract', () => {
 const withFields = {
   ...fixture,
   sessions: [{ ...fixture.sessions[0], excluded: false, last_upstream_model: 'gpt-5.6-luna', model_mismatch: true,
     last_result: 'block_mismatch', ws_connection_reused: 5, plan_provenance: 'account',
     last_failure: { code: 'block_mismatch', reason: 'block_mismatch', verdict: 'shape_mismatch', observed_blocks: 11, expected_blocks: 10 } }],
   events: [{ ...fixture.events[0], upstream_model: 'gpt-5.6-luna', verdict: 'shape_mismatch', reason: 'block_mismatch', observed_blocks: 11, expected_blocks: 10 }],
 };
 expect(isTurnStateOverview(withFields)).toBe(true);
 // 旧 payload 缺这些字段依然是有效快照。
 expect(isTurnStateOverview(fixture)).toBe(true);
 // 出现但取值非法时必须拒绝，不能静默当成健康数据。
 expect(isTurnStateOverview({ ...withFields, sessions: [{ ...withFields.sessions[0], excluded: 'yes' }] })).toBe(false);
 expect(isTurnStateOverview({ ...withFields, events: [{ ...withFields.events[0], verdict: 'Not A Code' }] })).toBe(false);
});
it('uses authenticated basepath GET and rejects missing/old/error data', async () => {
 window.__APP_BASE_PATH__ = '/keeper';
 const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture))); vi.stubGlobal('fetch', fetcher);
 const controller = new AbortController(); await fetchTurnStateOverview(controller.signal);
 expect(fetcher.mock.calls[0][0]).toBe('/keeper/api/v1/turn-state/overview');
 expect(fetcher.mock.calls[0][1]).toMatchObject({credentials:'include', signal:controller.signal});
 expect(fetcher.mock.calls[0][1].method).toBeUndefined();
 fetcher.mockResolvedValue(new Response('{}')); await expect(fetchTurnStateOverview()).rejects.toThrow('turn_state_unavailable');
 fetcher.mockResolvedValue(new Response('secret', {status:503})); await expect(fetchTurnStateOverview()).rejects.toBeInstanceOf(ApiError);
});
