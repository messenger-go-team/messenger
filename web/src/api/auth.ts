import { apiRequest } from './client'

export interface LoginRequest {
  username: string
  password: string
}

export interface AccessTokenResponse {
  token_type: 'Bearer'
  access_token: string
  expires_in: 900
}

export interface RegisterRequest {
  username: string
  password: string
}

export interface User {
  id: string
  username: string
  created_at: string
}

export function login(credentials: LoginRequest) {
  return apiRequest<AccessTokenResponse>('/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(credentials),
  })
}
export function register(data: RegisterRequest): Promise<User> {
  return apiRequest<User>('/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  })
}
export function getMe(accessToken: string): Promise<User> {
  return apiRequest<User>('/me', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

export function refresh(): Promise<AccessTokenResponse> {
  return apiRequest<AccessTokenResponse>('/auth/refresh', {
    method: 'POST',
  })
}

export function logout(): Promise<void> {
  return apiRequest<void>('/auth/logout', {
    method: 'POST',
  })
}

export interface UserSummary {
  id: string
  username: string
}

export interface SearchUsersResponse {
  users: UserSummary[]
}

export function searchUsers(prefix: string, accessToken: string): Promise<SearchUsersResponse> {
  const params = new URLSearchParams({ prefix })

  return apiRequest<SearchUsersResponse>(`/users/search?${params.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

export interface ContactsResponse {
  contacts: UserSummary[]
}

export function getContacts(accessToken: string): Promise<ContactsResponse> {
  return apiRequest<ContactsResponse>('/contacts', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

export function addContact(contactId: string, accessToken: string): Promise<void> {
  return apiRequest<void>(`/contacts/${encodeURIComponent(contactId)}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

export function removeContact(contactId: string, accessToken: string): Promise<void> {
  return apiRequest<void>(`/contacts/${encodeURIComponent(contactId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}
