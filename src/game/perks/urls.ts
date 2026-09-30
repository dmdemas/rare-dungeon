/** Repo path `assets/refs.perk/...` → public URL `/refs.perk/...`. */
export function perkIconUrl(iconPath: string): string {
  const marker = 'assets/refs.perk/'
  const i = iconPath.indexOf(marker)
  const path =
    i >= 0
      ? `/refs.perk/${iconPath.slice(i + marker.length)}`
      : iconPath.startsWith('/')
        ? iconPath
        : `/${iconPath}`
  // Bust cache after cropping sheet padding from source PNGs
  return `${path}?v=fog4`
}
