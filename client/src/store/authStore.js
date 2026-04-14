import { create } from 'zustand'
import { persist } from 'zustand/middleware'
export const useAuthStore = create(
  persist(
    (set) => ({
      token: null,
      user: null,
      setAuth: (token, user) => set({ token, user }),
      patchUser: (partial) => set((s) => ({ user: s.user ? { ...s.user, ...partial } : null })),
      logout: () => set({ token: null, user: null }),
    }),
    { name: 'netpulse-auth' }
  )
)
