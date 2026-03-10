"use client";

import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <div
          style={{
            padding: "2rem",
            maxWidth: "600px",
            margin: "2rem auto",
            backgroundColor: "#0b0e1a",
            border: "1px solid #1f2435",
            borderRadius: "1rem",
            color: "#f9fafb",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <h2 style={{ color: "#f97373", marginBottom: "1rem" }}>
            Something went wrong
          </h2>
          <pre
            style={{
              fontSize: "0.875rem",
              overflow: "auto",
              color: "#9ca3af",
              whiteSpace: "pre-wrap",
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: undefined })}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1rem",
              backgroundColor: "#4ade80",
              color: "#000",
              border: "none",
              borderRadius: "0.5rem",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
