import { useState, useEffect, useCallback, createContext, useContext, createElement } from 'react';

const AUTH_MODE = import.meta.env.VITE_AUTH_MODE || 'cognito';
const AUTH_ENDPOINT = import.meta.env.VITE_AUTH_ENDPOINT || '';
const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

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

// ── Token storage (OIDC mode) — persisted to localStorage ─────────────

let oidcAccessToken = localStorage.getItem('clawbot_access_token') || '';
let oidcRefreshToken = localStorage.getItem('clawbot_refresh_token') || '';
let pendingForceChangeEmail = '';
let pendingForceChangePassword = '';

function persistTokens(access: string, refresh: string) {
  oidcAccessToken = access;
  oidcRefreshToken = refresh;
  if (access) localStorage.setItem('clawbot_access_token', access);
  else localStorage.removeItem('clawbot_access_token');
  if (refresh) localStorage.setItem('clawbot_refresh_token', refresh);
  else localStorage.removeItem('clawbot_refresh_token');
}

// ── Cognito (Amplify) helpers ─────────────────────────────────────────

async function cognitoCheckUser(): Promise<AuthUser | null> {
  const { getCurrentUser, fetchAuthSession } = await import('aws-amplify/auth');
  const currentUser = await getCurrentUser();
  const session = await fetchAuthSession();
  let isAdmin = false;
  try {
    const token = session.tokens?.accessToken?.toString() || '';
    const res = await fetch(`${BASE_URL}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const me = await res.json();
      isAdmin = me.isAdmin ?? false;
    }
  } catch { /* API may not be available */ }
  return {
    userId: currentUser.userId,
    email: currentUser.signInDetails?.loginId || '',
    isAdmin,
  };
}

async function cognitoLogin(email: string, password: string): Promise<{ needsNewPassword: boolean; user: AuthUser | null }> {
  const { signIn, signOut } = await import('aws-amplify/auth');
  try { await signOut(); } catch { /* ignore */ }
  const result = await signIn({
    username: email,
    password,
    options: { authFlowType: 'USER_PASSWORD_AUTH' },
  });
  if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
    return { needsNewPassword: true, user: null };
  }
  if (!result.isSignedIn) {
    throw new Error(`Sign-in incomplete: ${result.nextStep?.signInStep || 'unknown step'}`);
  }
  const user = await cognitoCheckUser();
  return { needsNewPassword: false, user };
}

async function cognitoCompleteNewPassword(newPassword: string): Promise<AuthUser | null> {
  const { confirmSignIn } = await import('aws-amplify/auth');
  await confirmSignIn({ challengeResponse: newPassword });
  return cognitoCheckUser();
}

async function cognitoLogout(): Promise<void> {
  const { signOut } = await import('aws-amplify/auth');
  await signOut();
}

async function cognitoGetToken(): Promise<string> {
  const { fetchAuthSession } = await import('aws-amplify/auth');
  const session = await fetchAuthSession();
  return session.tokens?.accessToken?.toString() || '';
}

// ── OIDC helpers ──────────────────────────────────────────────────────

async function oidcCheckUser(): Promise<AuthUser | null> {
  if (!oidcAccessToken) return null;
  try {
    const res = await fetch(`${BASE_URL}/me`, {
      headers: { Authorization: `Bearer ${oidcAccessToken}` },
    });
    if (!res.ok) return null;
    const me = await res.json();
    return { userId: me.userId, email: me.email, isAdmin: me.isAdmin ?? false };
  } catch {
    return null;
  }
}

async function oidcLogin(email: string, password: string): Promise<{ needsNewPassword: boolean; user: AuthUser | null }> {
  const res = await fetch(`${AUTH_ENDPOINT}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Login failed' }));
    throw new Error(body.error || 'Login failed');
  }
  const data = await res.json();
  if (data.challengeName === 'NEW_PASSWORD_REQUIRED') {
    pendingForceChangeEmail = email;
    pendingForceChangePassword = password;
    return { needsNewPassword: true, user: null };
  }
  persistTokens(data.accessToken, data.refreshToken);
  const user = await oidcCheckUser();
  return { needsNewPassword: false, user };
}

async function oidcCompleteNewPassword(newPassword: string): Promise<AuthUser | null> {
  const res = await fetch(`${AUTH_ENDPOINT}/auth/force-change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: pendingForceChangeEmail,
      currentPassword: pendingForceChangePassword,
      newPassword,
    }),
  });
  pendingForceChangeEmail = '';
  pendingForceChangePassword = '';
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Password change failed' }));
    throw new Error(body.error || 'Password change failed');
  }
  const data = await res.json();
  persistTokens(data.accessToken, data.refreshToken);
  return oidcCheckUser();
}

async function oidcLogout(): Promise<void> {
  persistTokens('', '');
}

async function oidcRefresh(): Promise<boolean> {
  if (!oidcRefreshToken) return false;
  try {
    const res = await fetch(`${AUTH_ENDPOINT}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: oidcRefreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    persistTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

// ── AuthProvider ──────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsNewPassword, setNeedsNewPassword] = useState(false);

  useEffect(() => {
    checkUser();
  }, []);

  async function checkUser() {
    try {
      const u = AUTH_MODE === 'oidc' ? await oidcCheckUser() : await cognitoCheckUser();
      setUser(u);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  const login = useCallback(async (email: string, password: string) => {
    const result = AUTH_MODE === 'oidc'
      ? await oidcLogin(email, password)
      : await cognitoLogin(email, password);
    if (result.needsNewPassword) {
      setNeedsNewPassword(true);
      return;
    }
    setUser(result.user);
  }, []);

  const completeNewPassword = useCallback(async (newPassword: string) => {
    const u = AUTH_MODE === 'oidc'
      ? await oidcCompleteNewPassword(newPassword)
      : await cognitoCompleteNewPassword(newPassword);
    setNeedsNewPassword(false);
    setUser(u);
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    if (AUTH_MODE === 'oidc') {
      throw new Error('Self-registration not supported in OIDC mode');
    }
    const { signUp } = await import('aws-amplify/auth');
    await signUp({ username: email, password, options: { userAttributes: { email } } });
  }, []);

  const logout = useCallback(async () => {
    if (AUTH_MODE === 'oidc') await oidcLogout();
    else await cognitoLogout();
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

export async function getAuthToken(): Promise<string> {
  if (AUTH_MODE === 'oidc') {
    if (!oidcAccessToken && oidcRefreshToken) {
      await oidcRefresh();
    }
    return oidcAccessToken;
  }
  return cognitoGetToken();
}
