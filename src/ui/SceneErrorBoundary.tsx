// Last line of defence around the 3D view: a rendering error shows a message instead of blanking the whole app.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

export class SceneErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("3D view crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="scene-error" role="alert" data-testid="scene-error">
        <strong>The 3D view hit an error.</strong>
        <span className="small muted">{this.state.error.message}</span>
        <span className="small">Undo the last change or import a saved plan, then try again.</span>
        <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
