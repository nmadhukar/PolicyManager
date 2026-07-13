import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { AcknowledgmentsPage } from './pages/AcknowledgmentsPage';
import { ApiClientsPage } from './pages/ApiClientsPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { DashboardPage } from './pages/DashboardPage';
import { DocumentDetailPage } from './pages/DocumentDetailPage';
import { EmailAdminPage } from './pages/EmailAdminPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ImportPage } from './pages/ImportPage';
import { LibraryPage } from './pages/LibraryPage';
import { LoginPage } from './pages/LoginPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { ReviewsPage } from './pages/ReviewsPage';
import { StorageAdminPage } from './pages/StorageAdminPage';
import { UsersPage } from './pages/UsersPage';

export default function App() {
  const location = useLocation();
  return (
    // Keying the boundary on the path clears a caught error when the user
    // navigates elsewhere, so one crashed page never wedges the whole app.
    <ErrorBoundary key={location.pathname}>
      <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        path="/change-password"
        element={
          <ProtectedRoute>
            <ChangePasswordPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/library"
        element={
          <ProtectedRoute>
            <LibraryPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/library/import"
        element={
          <ProtectedRoute>
            <ImportPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/library/:id"
        element={
          <ProtectedRoute>
            <DocumentDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/reviews"
        element={
          <ProtectedRoute>
            <ReviewsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/acknowledgments"
        element={
          <ProtectedRoute>
            <AcknowledgmentsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/email"
        element={
          <ProtectedRoute>
            <EmailAdminPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/audit"
        element={
          <ProtectedRoute>
            <AuditLogPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/users"
        element={
          <ProtectedRoute>
            <UsersPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/storage"
        element={
          <ProtectedRoute>
            <StorageAdminPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/api-clients"
        element={
          <ProtectedRoute>
            <ApiClientsPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ErrorBoundary>
  );
}
