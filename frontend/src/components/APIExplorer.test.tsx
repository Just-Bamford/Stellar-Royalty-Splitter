import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { APIExplorer } from "./APIExplorer";

describe("APIExplorer Component", () => {
  it("renders endpoint list, request builder, and handles live request and bookmarking", async () => {
    render(<APIExplorer />);

    expect(screen.getByTestId("api-explorer")).toBeInTheDocument();
    expect(screen.getByTestId("request-builder")).toBeInTheDocument();
    expect(screen.getByTestId("try-it-btn")).toBeInTheDocument();

    const bookmarkBtn = screen.getByTestId("bookmark-btn");
    fireEvent.click(bookmarkBtn);

    const tryBtn = screen.getByTestId("try-it-btn");
    fireEvent.click(tryBtn);

    await waitFor(() => {
      expect(screen.getByTestId("response-viewer")).toBeInTheDocument();
    });

    expect(screen.getByTestId("copy-curl-btn")).toBeInTheDocument();
    expect(screen.getByTestId("copy-js-btn")).toBeInTheDocument();
    expect(screen.getByTestId("copy-python-btn")).toBeInTheDocument();
  });
});
