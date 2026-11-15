const SAFE_CODE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

function safeCode(value) {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : null;
}

export function apiErrorCode(error) {
  const upstream = error?.response?.data;
  const candidates = [
    upstream?.error,
    upstream?.error?.status,
    upstream?.error?.errors?.[0]?.reason,
    upstream?.errors?.[0]?.reason,
    error?.code,
  ];
  return candidates.map(safeCode).find(Boolean) || null;
}
