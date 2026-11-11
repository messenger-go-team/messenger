import { afterEach, expect, it, vi } from 'vitest'
import { apiRequest } from './client'

afterEach(() => {
  vi.restoreAllMocks()
})

// HttpOnly refresh cookie должна отправляться независимо от переданного RequestInit.
it('always includes credentials in API requests', async () => {
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(null, { status: 204 }))

  await apiRequest<void>('/auth/logout', {
    method: 'POST',
    credentials: 'omit',
  })

  expect(fetchSpy).toHaveBeenCalledWith(
    expect.stringContaining('/auth/logout'),
    expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }),
  )
})

// Headers конструируется стандартным API, поэтому поддерживаются все варианты HeadersInit.
it.each<HeadersInit>([
  { Authorization: 'Bearer test' },
  new Headers({ Authorization: 'Bearer test' }),
  [['Authorization', 'Bearer test']],
])('preserves HeadersInit authorization %#', async (headers) => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
  await expect(apiRequest<void>('/contacts/example', { headers })).resolves.toBeUndefined()
  expect(new Headers(spy.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer test')
})

// Не контрактный ответ proxy всё равно преобразуется в предсказуемый ApiError.
it('reports non-JSON API errors', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Unavailable', { status: 503 }))
  await expect(apiRequest('/me')).rejects.toMatchObject({ status: 503, code: 'unknown_error' })
})
