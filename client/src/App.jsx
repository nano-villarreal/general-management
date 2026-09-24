import React, { useState, useEffect } from 'react';
import { api } from './api';
import CameraReportsPanel from './components/CameraReportsPanel';

function LoginPage({ onLoggedIn }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(password);
      if (res.ok) onLoggedIn();
      else setError(res.error || 'Login failed');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-logo">Camera Reports</div>
        <div className="login-subtitle">Sign in to continue</div>
        <form onSubmit={submit}>
          <label className="login-label">Password</label>
          <input
            className="login-input"
            type="password"
            autoFocus
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
          <button className="login-btn" type="submit" disabled={busy}>
            {busy ? 'Signing in...' : 'Sign in'}
          </button>
          {error && <div className="login-error">{error}</div>}
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState(null);

  useEffect(() => {
    api.me().then(setMe);
  }, []);

  async function logout() {
    await api.logout();
    setMe({ authenticated: false });
  }

  if (!me) return <div className="loading">Loading...</div>;
  if (!me.authenticated) return <LoginPage onLoggedIn={() => setMe({ authenticated: true })} />;

  return (
    <div className="app-layout">
      <div className="topbar">
        <div className="topbar-logo">Camera Reports</div>
        <div className="topbar-right">
          <button className="logout-btn" onClick={logout}>Logout</button>
        </div>
      </div>
      <div className="main-content">
        <div className="solo-panel">
          <CameraReportsPanel />
        </div>
      </div>
    </div>
  );
}
