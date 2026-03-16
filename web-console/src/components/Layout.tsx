import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top navbar */}
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <Link to="/" className="text-xl font-bold text-indigo-600">NanoClaw Cloud</Link>
            </div>
            <div className="flex items-center gap-4">
              {user?.isAdmin && (
                <Link to="/admin/users" className="text-sm text-indigo-600 hover:text-indigo-500 font-medium">Admin</Link>
              )}
              <span className="text-sm text-gray-600">{user?.email}</span>
              <button onClick={logout} className="text-sm text-gray-500 hover:text-gray-700">Sign out</button>
            </div>
          </div>
        </div>
      </nav>
      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
