/**
 * App Root Component
 * Sets up routing and auth-gated navigation.
 */
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';

/**
 * Protected route wrapper — redirects to login if unauthenticated
 */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-ink flex items-center justify-center">
        <div className="text-center">
          <p className="font-korean text-2xl text-paper mb-2">한국어 마스터</p>
          <p className="text-paper/40 text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

/**
 * Public route wrapper — redirects to dashboard if already authenticated
 */
function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return null;

  if (user) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={
            <PublicRoute>
              <Login />
            </PublicRoute>
          }
        />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        {/* Future routes — placeholder for Phase 2+ */}
        <Route
          path="/vocab"
          element={
            <ProtectedRoute>
              <PlaceholderPage title="단어 학습 | Vocabulary" />
            </ProtectedRoute>
          }
        />
        <Route
          path="/grammar"
          element={
            <ProtectedRoute>
              <PlaceholderPage title="문법 수업 | Grammar" />
            </ProtectedRoute>
          }
        />
        <Route
          path="/topik"
          element={
            <ProtectedRoute>
              <PlaceholderPage title="TOPIK 연습 | TOPIK Practice" />
            </ProtectedRoute>
          }
        />
        <Route
          path="/conversation"
          element={
            <ProtectedRoute>
              <PlaceholderPage title="AI 대화 | Conversation" />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reading"
          element={
            <ProtectedRoute>
              <PlaceholderPage title="읽기 연습 | Reading" />
            </ProtectedRoute>
          }
        />
        <Route
          path="/speaking"
          element={
            <ProtectedRoute>
              <PlaceholderPage title="발음 연습 | Speaking" />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

/** Temporary placeholder for future module pages */
function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="min-h-screen bg-ink text-paper flex items-center justify-center">
      <div className="text-center">
        <h1 className="font-korean text-3xl font-bold mb-4">{title}</h1>
        <p className="text-paper/40">Coming in Phase 2+</p>
        <a
          href="/"
          className="inline-block mt-6 text-accent hover:text-accent-light transition-colors"
        >
          ← 대시보드로 돌아가기
        </a>
      </div>
    </div>
  );
}
