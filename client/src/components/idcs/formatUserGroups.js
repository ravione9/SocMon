/**
 * Format SCIM / Oracle IDCS `user.groups[]` for UI (handles display, displayName, value).
 */
export function formatUserGroups(user) {
  const list = user?.groups;
  if (!Array.isArray(list) || list.length === 0) return '';
  return list
    .map((g) => {
      if (!g || typeof g === 'string') return typeof g === 'string' ? String(g).trim() : '';
      return String(g.display || g.displayName || g.label || g.name || g.value || '').trim();
    })
    .filter(Boolean)
    .join(', ');
}
