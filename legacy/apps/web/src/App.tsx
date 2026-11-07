import { useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { ArenaPage } from './pages/ArenaPage';
import { BrainPage } from './pages/BrainPage';
import { ContextPage } from './pages/ContextPage';
import { DebtPage } from './pages/DebtPage';
import { GuardsPage } from './pages/GuardsPage';
import { HandoffPage } from './pages/HandoffPage';
import { JournalPage } from './pages/JournalPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OverviewPage } from './pages/OverviewPage';
import { PairPage } from './pages/PairPage';
import { PluginsPage } from './pages/PluginsPage';
import { ReplayPage } from './pages/ReplayPage';
import { SessionPage } from './pages/SessionPage';
import { SessionsPage } from './pages/SessionsPage';
import { TrustPage } from './pages/TrustPage';
import { UnderstandingPage } from './pages/UnderstandingPage';

function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}

export function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="sessions/:id" element={<SessionPage />} />
          <Route path="sessions/:id/replay" element={<ReplayPage />} />
          <Route path="sessions/:id/trust" element={<TrustPage />} />
          <Route path="sessions/:id/understanding" element={<DebtPage />} />
          <Route path="sessions/:id/context" element={<ContextPage />} />
          <Route path="sessions/:id/handoff" element={<HandoffPage />} />
          <Route path="guards" element={<GuardsPage />} />
          <Route path="debt" element={<DebtPage />} />
          <Route path="understanding/:id" element={<UnderstandingPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="brain" element={<BrainPage />} />
          <Route path="arena" element={<ArenaPage />} />
          <Route path="journal" element={<JournalPage />} />
          <Route path="plugins" element={<PluginsPage />} />
          <Route path="pair" element={<PairPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </>
  );
}
