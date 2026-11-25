import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { CommunityForum } from "../CommunityForum";

describe("CommunityForum", () => {
  const WALLET_ADDR = "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA";

  beforeEach(() => {
    // Reset state
  });

  it("renders discussion forums and allows category filtering", () => {
    render(<CommunityForum walletAddress={WALLET_ADDR} />);

    expect(screen.getByText("💬 Discussion Forums")).toBeInTheDocument();
    expect(screen.getByText("Best practices for automated secondary music royalty splits?")).toBeInTheDocument();

    const gamingChip = screen.getByRole("button", { name: "🎮 Gaming" });
    fireEvent.click(gamingChip);

    expect(screen.getByText("Integrating Stellar Soroban contracts into Unity game engine")).toBeInTheDocument();
  });

  it("allows searching topics by title", () => {
    render(<CommunityForum walletAddress={WALLET_ADDR} />);

    const searchInput = screen.getByPlaceholderText(/Search topics or tags/i);
    fireEvent.change(searchInput, { target: { value: "Unity" } });

    expect(screen.getByText("Integrating Stellar Soroban contracts into Unity game engine")).toBeInTheDocument();
  });

  it("switches to leaderboards tab and displays correct calculations", () => {
    render(<CommunityForum walletAddress={WALLET_ADDR} />);

    const leaderboardTabBtn = screen.getByRole("button", { name: "🏆 Leaderboards" });
    fireEvent.click(leaderboardTabBtn);

    expect(screen.getByTestId("leaderboard-table")).toBeInTheDocument();
    expect(screen.getByText("1,450 XLM")).toBeInTheDocument();
  });

  it("switches to events calendar tab and allows RSVP toggle", () => {
    render(<CommunityForum walletAddress={WALLET_ADDR} />);

    const eventsTabBtn = screen.getByRole("button", { name: "📅 Events Calendar" });
    fireEvent.click(eventsTabBtn);

    expect(screen.getByText("Stellar Music & Audio Collaboration Jam")).toBeInTheDocument();
    expect(screen.getByText(/✓ Attending/i)).toBeInTheDocument();
  });

  it("opens create post modal and publishes a new topic", () => {
    render(<CommunityForum walletAddress={WALLET_ADDR} />);

    const newTopicBtn = screen.getByRole("button", { name: "+ New Topic" });
    fireEvent.click(newTopicBtn);

    expect(screen.getByRole("heading", { name: "Start a New Discussion Topic" })).toBeInTheDocument();

    const titleInput = screen.getByLabelText("Title");
    fireEvent.change(titleInput, { target: { value: "How to split royalties for remix contests?" } });

    const contentInput = screen.getByLabelText("Content");
    fireEvent.change(contentInput, { target: { value: "We want to host a remix contest on Stellar." } });

    const submitBtn = screen.getByRole("button", { name: /Publish Topic/i });
    fireEvent.click(submitBtn);

    expect(screen.getByText("How to split royalties for remix contests?")).toBeInTheDocument();
  });

  it("enforces character limits and displays character counters in post creation modal", () => {
    render(<CommunityForum walletAddress={WALLET_ADDR} />);

    const newTopicBtn = screen.getByRole("button", { name: "+ New Topic" });
    fireEvent.click(newTopicBtn);

    const titleInput = screen.getByLabelText("Title");
    const contentInput = screen.getByLabelText("Content");
    const titleCounter = screen.getByTestId("title-character-counter");
    const contentCounter = screen.getByTestId("content-character-counter");

    // Check maxLength attributes
    expect(titleInput).toHaveAttribute("maxLength", "200");
    expect(contentInput).toHaveAttribute("maxLength", "5000");

    // Check initial counter values
    expect(titleCounter).toHaveTextContent("0/200");
    expect(contentCounter).toHaveTextContent("0/5000");

    // Check counter updates on input
    fireEvent.change(titleInput, { target: { value: "A".repeat(25) } });
    expect(titleCounter).toHaveTextContent("25/200");

    fireEvent.change(contentInput, { target: { value: "B".repeat(150) } });
    expect(contentCounter).toHaveTextContent("150/5000");
  });

  it("does not submit posts exceeding max title or content length", () => {
    render(<CommunityForum walletAddress={WALLET_ADDR} />);

    const newTopicBtn = screen.getByRole("button", { name: "+ New Topic" });
    fireEvent.click(newTopicBtn);

    const titleInput = screen.getByLabelText("Title");
    const contentInput = screen.getByLabelText("Content");
    const submitBtn = screen.getByRole("button", { name: /Publish Topic/i });

    // Try submitting with title > 200 chars
    const overlyLongTitle = "T".repeat(201);
    fireEvent.change(titleInput, { target: { value: overlyLongTitle } });
    fireEvent.change(contentInput, { target: { value: "Valid content" } });
    fireEvent.click(submitBtn);

    // Modal should remain open and post should not be published
    expect(screen.getByRole("heading", { name: "Start a New Discussion Topic" })).toBeInTheDocument();
    expect(screen.queryByText(overlyLongTitle)).not.toBeInTheDocument();
  });
});
