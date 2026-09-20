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
