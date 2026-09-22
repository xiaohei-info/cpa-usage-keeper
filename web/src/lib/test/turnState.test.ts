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
// Flattened proxy config is additive: an older snapshot remains valid, while current
// fields are validated when present.
it('accepts the flattened proxy config fields', () => {
 const withFields = { ...fixture, config: { ...fixture.config, harvest_proxy_url: null, revalidate: true, mismatch_is_success: false, revoke_after_signals: 2 } };
 expect(isTurnStateOverview(withFields)).toBe(true);
 expect(isTurnStateOverview({ ...fixture, config: { ...withFields.config, revalidate: 'yes' } })).toBe(false);
 expect(isTurnStateOverview(fixture)).toBe(true);
});
// proxy 的 ticket 层会发出 source:'ticket'（codex-proxy 4b74a74）。此前白名单只认四个
// 通用来源，含 ticket 事件的快照会被 isTurnStateOverview 整份拒收，前端拿不到任何数据（P0-3）。
it('accepts the ticket event source and still rejects unknown sources', () => {
 expect(isTurnStateOverview({ ...fixture, events: [{ ...fixture.events[0], source: 'ticket' }] })).toBe(true);
 expect(isTurnStateOverview({ ...fixture, events: [{ ...fixture.events[0], source: 'made_up' }] })).toBe(false);
});
// 合并后的主动采集计数与累计起点是可加字段：旧 proxy 缺失仍合法，
// 但一旦出现就必须是合法值（非法值拒绝整份快照，不当成未知但可用）。
it('accepts the merged active-collection counters and rejects malformed values', () => {
 const withMetrics = { ...fixture, summary: { ...fixture.summary, active_attempts: 13, active_accepted: 1, active_rejected: 12, since: fixture.server_time } };
 expect(isTurnStateOverview(withMetrics)).toBe(true);
 // 旧 proxy 没有这四个字段仍必须通过。
 expect(isTurnStateOverview(fixture)).toBe(true);
 expect(isTurnStateOverview({ ...fixture, summary: { ...withMetrics.summary, active_attempts: -1 } })).toBe(false);
 expect(isTurnStateOverview({ ...fixture, summary: { ...withMetrics.summary, active_accepted: 'many' } })).toBe(false);
 // since 是时间戳：非 ISO 与其它时间字段同一口径，必须拒绝。
 expect(isTurnStateOverview({ ...fixture, summary: { ...withMetrics.summary, since: 'not-a-time' } })).toBe(false);
});
// 实时速率（滚动 1 小时 dispatch 数）同样是可加字段：旧 proxy 缺失仍合法，
// 但出现时的非法值必须拒绝整份快照。
it('accepts the rolling hourly dispatch rate and rejects malformed values', () => {
 expect(isTurnStateOverview({ ...fixture, summary: { ...fixture.summary, active_last_hour: 7 } })).toBe(true);
 // 旧 proxy 不返回该字段仍然是合法快照。
 expect(isTurnStateOverview(fixture)).toBe(true);
 expect(isTurnStateOverview({ ...fixture, summary: { ...fixture.summary, active_last_hour: -1 } })).toBe(false);
 expect(isTurnStateOverview({ ...fixture, summary: { ...fixture.summary, active_last_hour: 'many' } })).toBe(false);
});
// 200 上限保持 fail-closed：超量由生产端修复，Keeper 不放宽。
it('still rejects more than 200 events', () => {
 expect(isTurnStateOverview({ ...fixture, events: Array(201).fill(fixture.events[0]) })).toBe(false);
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
