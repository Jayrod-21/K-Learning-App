/**
 * topikStudyDraw — unit tests for the B-029 draw-size → request-options
 * boundary (SF-1 fix-pass finding).
 *
 * `Topik.test.tsx` module-mocks `useEndpointOrMock` wholesale, so nothing in
 * that suite ever actually invokes `realFn`/`fetchStudyDraw` — the B-029 UI
 * test there only verifies the select control + the stepping-state reset.
 * This is a direct unit test of the boundary function that builds the real
 * request options, so a regression that stopped forwarding `limit` (or
 * built `{ limit: NaN }`) fails here even though the mocked-hook tests never
 * would.
 */
import { describe, it, expect } from 'vitest';
import { buildStudyDrawOptions } from './topikStudyDraw';

describe('buildStudyDrawOptions', () => {
  it('omits `limit` for the server-default placeholder', () => {
    expect(buildStudyDrawOptions('')).toEqual({});
  });

  it('forwards the chosen size as a numeric `limit`', () => {
    expect(buildStudyDrawOptions('20')).toEqual({ limit: 20 });
    expect(buildStudyDrawOptions('30')).toEqual({ limit: 30 });
    expect(buildStudyDrawOptions('50')).toEqual({ limit: 50 });
  });
});
