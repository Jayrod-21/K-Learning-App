/**
 * ErrorBoundary — root-level safety net for render-time exceptions.
 *
 * React's only way to recover from a thrown render is a class boundary, so
 * this file is the one place we keep a class component. The fallback renders
 * a hanji-styled "something went wrong" card with a refresh button — no app
 * chrome, because a corrupt Shell is the most likely cause of the failure.
 *
 * In dev we log the full error to the console so a stack trace is one click
 * away. In prod the message is intentionally generic — no stack, no error
 * details that might leak internal paths.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  hasError: boolean;
}

interface Props {
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false };

  public static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary]', error, info);
    }
    // TODO(B7): wire a real telemetry endpoint here once we have one.
  }

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  public render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="km-shell" role="alert" aria-live="assertive">
        <div className="km-shell__statusbar" aria-hidden="true" />
        <div className="km-shell__scroll km-stub">
          <div className="km-eyebrow">Something broke</div>
          <h1 className="kr-display km-stub__title">잠시 후 다시 시도</h1>
          <p className="km-stub__placeholder">
            The app hit an error and stopped rendering. Reload the page to
            recover. If this keeps happening, capture a screenshot and the URL
            and file an issue.
          </p>
          <div style={{ marginTop: 18 }}>
            <button
              type="button"
              className="km-btn km-btn--gold km-btn--md focusring"
              onClick={this.handleReload}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
