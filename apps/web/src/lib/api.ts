/**
 * API client.
 *
 * Amounts cross this boundary as strings and stay strings. Parsing a balance
 * into a JS number for display is how a rounding error reaches a customer's
 * screen, so formatting works on the string directly.
 */

/**
 * Where the API lives.
 *
 * In development Vite proxies `/api` to localhost:4000, so the default works
 * with no configuration. A deployed front end has no such proxy, so it needs
 * the API's real origin — set `VITE_API_BASE_URL` at build time (Vite inlines
 * it, so it must be present when the bundle is built, not at runtime).
 */
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '');

export const apiBaseUrl = (): string => API_BASE;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'gwc.token';
const ROLE_KEY = 'gwc.role';

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const getRole = (): 'customer' | 'operator' | null =>
  localStorage.getItem(ROLE_KEY) as 'customer' | 'operator' | null;

export const setSession = (token: string, role: 'customer' | 'operator'): void => {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ROLE_KEY, role);
};

export const clearSession = (): void => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
};

export const request = async <T>(
  method: string, path: string, body?: unknown,
): Promise<T> => {
  const token = getToken();
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }

  if (!response.ok) {
    const err = (payload as { error?: { code: string; message: string; details?: unknown } })?.error;
    // An expired session should drop the user at the login screen rather than
    // showing an error on a page they can no longer load.
    if (response.status === 401) {
      clearSession();
      if (!location.pathname.startsWith('/login')) location.href = '/login';
    }
    throw new ApiError(
      response.status,
      err?.code ?? 'request_failed',
      err?.message ?? `Request failed with ${response.status}`,
      err?.details,
    );
  }

  return payload as T;
};

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// --- Formatting -------------------------------------------------------------

/** Format a decimal string as currency without ever parsing it to a float. */
export const money = (value: string | null | undefined, currency = 'USD'): string => {
  if (value === null || value === undefined || value === '') return '—';
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = { USD: '$', EUR: '€', GBP: '£' }[currency] ?? '';
  const decimals = fraction.padEnd(2, '0').slice(0, 2);
  return `${negative ? '−' : ''}${symbol}${grouped}.${decimals}`;
};

/** Compact form for dense tables and axis labels. */
export const moneyCompact = (value: string | null | undefined): string => {
  if (!value) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return money(value);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
};

export const percent = (value: string | null | undefined, dp = 1): string => {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(dp)}%` : '—';
};

export const points = (value: string | null | undefined): string => {
  if (!value) return '0';
  return value.split('.')[0]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

export const dateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

export const dateOnly = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
};

export const relative = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};
