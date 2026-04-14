import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_THEME, THEME_IDS } from '../constants/themes'

function applyDomTheme(theme) {
  const id = THEME_IDS.includes(theme) ? theme : DEFAULT_THEME
  document.documentElement.setAttribute('data-theme', id)
}

export const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: DEFAULT_THEME,
      saveToProfile: false,
      setTheme: (theme) => {
        const id = THEME_IDS.includes(theme) ? theme : DEFAULT_THEME
        set({ theme: id })
        applyDomTheme(id)
      },
      setSaveToProfile: (saveToProfile) => set({ saveToProfile: !!saveToProfile }),
      /** After /api/auth/me — server wins when user opted into profile sync. */
      syncFromUser: (user) => {
        if (user?.themeSaveToProfile && user?.theme && THEME_IDS.includes(user.theme)) {
          set({ theme: user.theme, saveToProfile: true })
          applyDomTheme(user.theme)
        } else {
          set({ saveToProfile: false })
          applyDomTheme(get().theme)
        }
      },
    }),
    {
      name: 'netpulse-theme',
      partialize: (s) => ({ theme: s.theme, saveToProfile: s.saveToProfile }),
      onRehydrateStorage: () => (state) => {
        if (state?.theme) applyDomTheme(state.theme)
        else applyDomTheme(DEFAULT_THEME)
      },
    }
  )
)
