/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  readonly MAIN_VITE_API_BASE_URL?: string;
  readonly MAIN_VITE_MANIFEST_PUBKEYS?: string;
  /** "owner/repo": auto-update from its GitHub Releases (set by the release workflow). */
  readonly MAIN_VITE_UPDATE_REPO?: string;
  /** "1" when the macOS build is Developer ID signed, which macOS auto-update requires. */
  readonly MAIN_VITE_MAC_SIGNED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
