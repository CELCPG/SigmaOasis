import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches render-time crashes so a single bad message or malformed
 * conversation can't leave the user staring at a blank window. Conversations
 * are already on disk, so reloading recovers the session.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Sigma Oasis renderer crashed:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex h-screen items-center justify-center bg-base-light p-8 text-neutral-900 dark:bg-base-dark dark:text-neutral-100">
        <div className="max-w-lg text-center">
          <p className="mb-2 text-4xl">🧠💥</p>
          <p className="font-medium">Sigma Oasis hit an unexpected error</p>
          <p className="mt-2 text-sm text-neutral-500">
            Your conversations are saved on disk — reloading should pick up where you left off.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black/5 p-3 text-left font-mono text-xs text-neutral-500 dark:bg-white/5">
            {error.message}
          </pre>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="rounded-lg border border-black/10 px-4 py-2 text-sm hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10"
            >
              Try to continue
            </button>
          </div>
        </div>
      </div>
    )
  }
}
