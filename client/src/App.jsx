import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import LoginSuccess from './pages/LoginSuccess';
import Dashboard from './pages/Dashboard';
import Landing from './pages/Landing';
import Demo from './pages/Demo';

// Protects routes that require authentication.
// Redirects to /login if no JWT is found in localStorage.
const ProtectedRoute = ({ children }) => {
  const token = localStorage.getItem('codeguard_token');
  if (!token) return <Navigate to="/login" replace />;
  return children;
};

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes */}
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/login/success" element={<LoginSuccess />} />
        <Route path="/demo" element={<Demo />} />

        {/* Protected route — dashboard requires a valid JWT */}
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />

        {/* Catch-all: redirect unknown paths to the landing page */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
