import { Component, ReactNode } from 'react';
import { ErrorState } from './states';

interface Props {
  children: ReactNode;
  /** Optional custom fallback; defaults to a friendly reload card. */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Catches render/runtime errors in its subtree so an uncaught throw shows a
 * friendly card instead of a blank white screen (AGENTS.md §10c). The reload
 * action clears any corrupt in-memory state.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    // Surface for diagnostics; the UI already shows a friendly fallback.
    // eslint-disable-next-line no-console
    console.error('Unhandled UI error:', error);
  }

  private handleReload = (): void => {
    if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
    } else {
      // No window to reload (tests) — at least clear the error to re-render.
      this.setState({ hasError: false });
    }
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="mx-auto max-w-lg p-6">
            <ErrorState
              title="Something went wrong"
              description="An unexpected error interrupted this page. Reloading usually fixes it."
              onRetry={this.handleReload}
            />
          </div>
        )
      );
    }
    return this.props.children;
  }
}
