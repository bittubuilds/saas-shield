import { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import { Loading } from './components/Status.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Scanning from './pages/Scanning.jsx';
import Report from './pages/Report.jsx';
import History from './pages/History.jsx';
import Competitors from './pages/Competitors.jsx';
import Login from './pages/Login.jsx';
import { loadSession, primaryWorkspace, setWorkspaceId, signOut } from './services/api.js';

export default function App() {
  // undefined = still asking the server, null = signed out
  const [session, setSession] = useState(undefined);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setError('');
    try {
      const s = await loadSession();
      setSession(s);
      const space = primaryWorkspace(s);
      setWorkspaceId(space ? space.id : null);
    } catch (e) {
      setSession(null);
      setError(e.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleSignOut = useCallback(async () => {
    await signOut();
    setSession(null);
  }, []);

  if (session === undefined) {
    return <main className="main"><section className="page-narrow"><Loading label="Checking your session…" /></section></main>;
  }

  if (error) {
    return (
      <main className="main">
        <section className="page-narrow">
          <h1 className="page-title">Cannot reach SaaS Shield</h1>
          <p className="field-error" role="alert">{error}</p>
          <button className="btn btn-primary" onClick={refresh}>Try again</button>
        </section>
      </main>
    );
  }

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<Login onSignedIn={refresh} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const space = primaryWorkspace(session);

  return (
    <Routes>
      <Route element={<Layout session={session} workspace={space} onSignOut={handleSignOut} />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/scan/:websiteId" element={<Scanning />} />
        <Route path="/report/:scanId" element={<Report />} />
        <Route path="/history" element={<History />} />
        <Route path="/competitors" element={<Competitors />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
