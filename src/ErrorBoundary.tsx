import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  children: ReactNode
}

type State = {
  hasError: boolean
  message: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    message: '',
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message,
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Application crashed:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="auth-shell">
          <section className="auth-card">
            <h1>Canvass</h1>
            <p>The app hit an unexpected error.</p>
            <p className="error-banner">{this.state.message || 'Unknown runtime error'}</p>
          </section>
        </main>
      )
    }

    return this.props.children
  }
}
