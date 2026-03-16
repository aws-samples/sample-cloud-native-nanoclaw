import { useState, useEffect, useCallback, createContext, useContext, createElement } from 'react';
import { fetchAuthSession, signIn, signOut, signUp, getCurrentUser, confirmSignIn } from 'aws-amplify/auth';

interface AuthUser {
  userId: string;
  email: string;
  isAdmin: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  needsNewPassword: boolean;
  completeNewPassword: (newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsNewPassword, setNeedsNewPassword] = useState(false);

  useEffect(() => {
    checkUser();
  }, []);

  async function checkUser() {
    try {
      const currentUser = await getCurrentUser();
      const session = await fetchAuthSession();
      let isAdmin = false;
      try {
        const token = session.tokens?.accessToken?.toString() || '';
        const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
        const res = await fetch(`${BASE_URL}/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const me = await res.json();
          isAdmin = me.isAdmin ?? false;
        }
      } catch {
        // API may not be available during initial load
      }
      setUser({
        userId: currentUser.userId,
        email: currentUser.signInDetails?.loginId || '',
        isAdmin,
      });
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  const login = useCallback(async (email: string, password: string) => {
    try { await signOut(); } catch { /* ignore */ }
    const result = await signIn({
      username: email,
      password,
      options: { authFlowType: 'USER_PASSWORD_AUTH' },
    });
    if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
      setNeedsNewPassword(true);
      return;
    }
    if (!result.isSignedIn) {
      throw new Error(`Sign-in incomplete: ${result.nextStep?.signInStep || 'unknown step'}`);
    }
    await checkUser();
  }, []);

  const completeNewPassword = useCallback(async (newPassword: string) => {
    await confirmSignIn({ challengeResponse: newPassword });
    await checkUser();
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    await signUp({ username: email, password, options: { userAttributes: { email } } });
  }, []);

  const logout = useCallback(async () => {
    await signOut();
    setUser(null);
  }, []);

  return createElement(AuthContext.Provider, {
    value: { user, loading, login, register, logout, needsNewPassword, completeNewPassword },
  }, children);
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

// Get JWT for API calls
export async function getAuthToken(): Promise<string> {
  const session = await fetchAuthSession();
  return session.tokens?.accessToken?.toString() || '';
}
