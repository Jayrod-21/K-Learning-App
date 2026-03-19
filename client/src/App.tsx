/**
 * App Root Component
 * Sets up routing, navigation, and auth-gated pages.
 */
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import Navigation from './components/Navigation';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Curriculum from './pages/Curriculum';
import Vocabulary from './pages/Vocabulary';
import GrammarList from './pages/GrammarList';
import GrammarLesson from './pages/GrammarLesson';
import Reading from './pages/Reading';
import Conversation from './pages/Conversation';

/**
 * Protected route wrapper — redirects to login if unauthenticated
 */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#1A1A2E] flex items-center justify-center">
        <div className="text-center">
          <p className="font-['Noto_Sans_KR'] text-2xl text-[#F5F0E8] mb-2">한국어 마스터</p>
          <p className="text-[#F5F0E8]/40 text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-screen bg-[#1A1A2E]">
      <Navigation />
      <main>{children}</main>
    </div>
  );
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
        <Route
          path="/curriculum"
          element={
            <ProtectedRoute>
              <Curriculum />
            </ProtectedRoute>
          }
        />
        <Route
          path="/vocab"
          element={
            <ProtectedRoute>
              <Vocabulary />
            </ProtectedRoute>
          }
        />
        <Route
          path="/grammar"
          element={
            <ProtectedRoute>
              <GrammarList />
            </ProtectedRoute>
          }
        />
        <Route
          path="/grammar/:lessonId"
          element={
            <ProtectedRoute>
              <GrammarLesson />
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
              <Conversation />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reading"
          element={
            <ProtectedRoute>
              <Reading />
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

/** Temporary placeholder for modules not yet built */
function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 text-center">
      <h1 className="font-['Noto_Sans_KR'] text-3xl font-bold text-[#F5F0E8] mb-4">{title}</h1>
      <p className="text-[#a0a0b0]">Coming soon</p>
      <a
        href="/"
        className="inline-block mt-6 text-[#C9A84C] hover:underline transition-colors"
      >
        ← 대시보드로 돌아가기
      </a>
    </div>
  );
}
