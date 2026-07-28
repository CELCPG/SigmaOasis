import type { AppApi } from './index'

declare global {
  interface Window {
    api: AppApi
  }
}

export {}
