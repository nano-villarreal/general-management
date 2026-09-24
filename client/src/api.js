async function apiFetch(path, opts = {}) {
  const res = await fetch(path, { credentials: 'include', ...opts });
  if (res.status === 401) {
    window.location.reload();
    return null;
  }
  if (!res.ok) {
    const text = await res.text();
    try { throw new Error(JSON.parse(text).error || text); } catch (e) { throw e instanceof SyntaxError ? new Error(text) : e; }
  }
  return res.json();
}

export const api = {
  me: () => apiFetch('/api/me'),

  cameraReports: (limit = 30) => apiFetch(`/api/camera-reports?limit=${limit}`),
  cameraReportsSummary: () => apiFetch('/api/camera-reports/summary'),
  cameraFrameUrl: (id) => `/api/camera-reports/${id}/frame`,
  markReference: (id, note) => apiFetch(`/api/camera-reports/${id}/mark-reference`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
  }),
  unmarkReference: (id) => apiFetch(`/api/camera-reports/${id}/mark-reference`, { method: 'DELETE' }),
  markEngagement: (id, note) => apiFetch(`/api/camera-reports/${id}/mark-engagement`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
  }),
  unmarkEngagement: (id) => apiFetch(`/api/camera-reports/${id}/mark-engagement`, { method: 'DELETE' }),

  alerts: (limit = 40) => apiFetch(`/api/alerts?limit=${limit}`),
  idleFlags: (limit = 20) => apiFetch(`/api/idle-flags?limit=${limit}`),

  login: (password) => fetch('/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  }).then(r => r.json()),

  logout: () => fetch('/logout', { method: 'POST', credentials: 'include' }).then(r => r.json()),
};
