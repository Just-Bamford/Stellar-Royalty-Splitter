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
});
