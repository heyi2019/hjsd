/**
 * Test-only API response helper.
 *
 * UI tests often return only the fields relevant to the assertion. Keep that
 * fixture shorthand local to tests instead of weakening the production API
 * contracts or spreading `as any` across test files.
 */
export function resolveMock<T>(mock: { mockResolvedValue(value: T): unknown }, value: unknown) {
  mock.mockResolvedValue(value as T);
}

export function resolveMockOnce<T>(mock: { mockResolvedValueOnce(value: T): unknown }, value: unknown) {
  mock.mockResolvedValueOnce(value as T);
}
