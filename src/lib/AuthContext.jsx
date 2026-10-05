import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

const AuthContext = createContext();
const ADMIN_ROLES = new Set(['owner', 'staff']);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState(null);
  const verifiedUserId = useRef(null);
  const pendingValidation = useRef(null);
  const validationVersion = useRef(0);

  const validateSession = useCallback((session) => {
    if (!session?.user) {
      validationVersion.current++;
      pendingValidation.current = null;
      verifiedUserId.current = null;
      setUser(null);
      setIsAuthenticated(false);
      setIsLoadingAuth(false);
      setAuthError(null);
      return Promise.resolve(false);
    }

    const id = session.user.id;
    // getSession and INITIAL_SESSION/SIGNED_IN can arrive together. Share the
    // same validation rather than letting overlapping results race each other.
    if (pendingValidation.current?.id === id) return pendingValidation.current.promise;
    const version = ++validationVersion.current;
    const sameUser = verifiedUserId.current === id;
    if (!sameUser) {
      verifiedUserId.current = null;
      setUser(null);
      setIsAuthenticated(false);
      setIsLoadingAuth(true);
    }
    // Keep already-verified screens mounted while the same user's session is
    // refreshed on tab focus. A loading-screen remount discards form state.
    setAuthError(null);
    const promise = (async () => {
      try {
        const { data: profile, error } = await supabase.from('profiles')
          .select('app_role').eq('id', id).maybeSingle();
        if (version !== validationVersion.current) return false;
        if (error) throw error;
        const role = String(profile?.app_role || '');
        if (!ADMIN_ROLES.has(role)) {
          verifiedUserId.current = null;
          setUser(null);
          setIsAuthenticated(false);
          setAuthError({ type: 'admin_required', message: 'This account does not have BLOM Admin access.' });
          return false;
        }
        verifiedUserId.current = id;
        setUser({ ...session.user, app_role: role });
        setIsAuthenticated(true);
        return true;
      } catch (error) {
        if (version !== validationVersion.current) return false;
        // A temporary network failure during a background role check must not
        // destroy unsaved work. Server functions still validate every request.
        console.warn('Unable to recheck Admin access:', error instanceof Error ? error.message : 'Role lookup failed');
        setAuthError({ type: 'auth_error', message: 'We could not verify your Admin access. Please try again.' });
        return false;
      } finally {
        if (version === validationVersion.current) {
          pendingValidation.current = null;
          setIsLoadingAuth(false);
        }
      }
    })();
    pendingValidation.current = { id, promise };
    return promise;
  }, []);

  const checkAppState = useCallback(async () => {
    const version = validationVersion.current;
    const { data, error } = await supabase.auth.getSession();
    if (version !== validationVersion.current) return;
    if (error) {
      setAuthError({ type: 'auth_error', message: error.message });
      setIsLoadingAuth(false);
      return;
    }
    await validateSession(data.session);
  }, [validateSession]);

  useEffect(() => {
    let timer;
    checkAppState();
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      window.clearTimeout(timer);
      if (event === 'SIGNED_OUT') { validateSession(null); return; }
      timer = window.setTimeout(() => validateSession(session), 0);
    });
    return () => { window.clearTimeout(timer); data.subscription.unsubscribe(); };
  }, [checkAppState, validateSession]);

  const signIn = async (email, password) => {
    setAuthError(null);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setAuthError({ type: 'auth_error', message: error.message });
      throw error;
    }
    const allowed = await validateSession(data.session);
    if (!allowed) {
      await supabase.auth.signOut();
      throw new Error('This account does not have BLOM Admin access.');
    }
  };

  const logout = async () => {
    await validateSession(null);
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated,
      isLoadingAuth,
      isLoadingPublicSettings: false,
      authError,
      appPublicSettings: null,
      signIn,
      logout,
      navigateToLogin: () => {},
      checkAppState,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
