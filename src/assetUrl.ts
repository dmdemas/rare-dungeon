/** Prepends Vite base path so assets work on GitHub Pages and locally. */
export const assetUrl = (path: string): string =>
  import.meta.env.BASE_URL.replace(/\/$/, '') + path
