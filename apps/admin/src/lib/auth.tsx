import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { AdminUser } from '@eventkit/shared';
import { api, ApiError, onUnauthorized } from './api';

interface AuthValue {
  admin: AdminUser | null;
  loading: boolean;
  isSuperadmin: boolean;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api.me()).admin;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(
    () =>
      onUnauthorized(() => {
        qc.setQueryData(['me'], null);
      }),
    [qc],
  );

  const value: AuthValue = {
    admin: me.data ?? null,
    loading: me.isLoading,
    isSuperadmin: me.data?.role === 'superadmin',
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
    logout: async () => {
      try {
        await api.logout();
      } finally {
        qc.clear();
        qc.setQueryData(['me'], null);
      }
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
