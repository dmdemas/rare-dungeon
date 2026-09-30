/** Repo path `assets/refs.perk/...` → public URL prefixed with Vite base. */
export function perkIconUrl(iconPath: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  const marker = 'assets/refs.perk/'
  const i = iconPath.indexOf(marker)
  const rel =
    i >= 0
      ? `/refs.perk/${iconPath.slice(i + marker.length)}`
      : iconPath.startsWith('/')
        ? iconPath
        : `/${iconPath}`
  // Bust cache after cropping sheet padding from source PNGs
  return `${base}${rel}?v=fog4`
}
