import { apiRequest } from './client'

/** Credentials для login endpoint. */
export interface LoginRequest {
  username: string
  password: string
}

/** Контракт короткоживущего Bearer token; refresh token остаётся в HttpOnly cookie. */
export interface AccessTokenResponse {
  token_type: 'Bearer'
  access_token: string
  expires_in: 900
}

/** Публичные регистрационные данные, отправляемые Auth API. */
export interface RegisterRequest {
  username: string
  password: string
}

/** Публичный профиль пользователя без credentials. */
export interface User {
  id: string
  username: string
  created_at: string
}

/** Аутентифицирует пользователя и возвращает короткоживущий Bearer JWT. */
export function login(credentials: LoginRequest) {
  return apiRequest<AccessTokenResponse>('/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(credentials),
  })
}

/** Регистрирует пользователя; ответ содержит только публичные поля профиля. */
export function register(data: RegisterRequest): Promise<User> {
  return apiRequest<User>('/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  })
}

/** Загружает профиль владельца переданного access token. */
export function getMe(accessToken: string): Promise<User> {
  return apiRequest<User>('/me', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

/** Получает новую пару сессии через HttpOnly refresh cookie, отправляемую `apiRequest`. */
export function refresh(): Promise<AccessTokenResponse> {
  return apiRequest<AccessTokenResponse>('/auth/refresh', {
    method: 'POST',
  })
}

/** Отзывает refresh-сессию; успешный HTTP 204 преобразуется в `undefined`. */
export function logout(): Promise<void> {
  return apiRequest<void>('/auth/logout', {
    method: 'POST',
  })
}

/** Минимальный профиль, используемый поиском, контактами и участниками чата. */
export interface UserSummary {
  id: string
  username: string
}

/** Ответ поиска пользователей по prefix. */
export interface SearchUsersResponse {
  users: UserSummary[]
}

/** Ищет публичные профили по username prefix; URLSearchParams выполняет безопасное кодирование. */
export function searchUsers(prefix: string, accessToken: string): Promise<SearchUsersResponse> {
  const params = new URLSearchParams({ prefix })

  return apiRequest<SearchUsersResponse>(`/users/search?${params.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

/** Список контактов, принадлежащий текущему аутентифицированному пользователю. */
export interface ContactsResponse {
  contacts: UserSummary[]
}

/** Возвращает независимый список контактов владельца access token. */
export function getContacts(accessToken: string): Promise<ContactsResponse> {
  return apiRequest<ContactsResponse>('/contacts', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

/** Идемпотентно добавляет пользователя в контакты и ожидает пустой ответ 204. */
export function addContact(contactId: string, accessToken: string): Promise<void> {
  return apiRequest<void>(`/contacts/${encodeURIComponent(contactId)}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

/** Идемпотентно удаляет пользователя из контактов и ожидает пустой ответ 204. */
export function removeContact(contactId: string, accessToken: string): Promise<void> {
  return apiRequest<void>(`/contacts/${encodeURIComponent(contactId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}
