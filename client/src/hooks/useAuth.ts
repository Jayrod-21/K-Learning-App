/**
 * useAuth Hook
 * Manages authentication state using Supabase Auth.
 * Provides login, register, logout, and current user state.
 */
import { useState, useEffect } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '../services/supabase';

interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
}

/**
 * Custom hook for Supabase authentication
 * @returns Auth state and methods (login, register, logout)
 */
export function useAuth() {
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    session: null,
    loading: true,
  });

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setAuthState({
        user: session?.user ?? null,
        session,
        loading: false,
      });
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setAuthState({
          user: session?.user ?? null,
          session,
          loading: false,
        });
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  /**
   * Sign in with email and password
   * @param email - User email
   * @param password - User password
   */
  async function login(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  /**
   * Register a new account
   * @param email - User email
   * @param password - User password
   */
  async function register(email: string, password: string) {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
  }

  /** Sign out the current user */
  async function logout() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }

  return {
    user: authState.user,
    session: authState.session,
    loading: authState.loading,
    login,
    register,
    logout,
  };
}
