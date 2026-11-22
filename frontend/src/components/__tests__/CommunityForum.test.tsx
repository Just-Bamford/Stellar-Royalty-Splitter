import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { CommunityForum } from "../CommunityForum";
import { useSocialStore, type ForumPost } from "../../store/socialStore";

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

  it("paginates forum posts with 20 items per page and loads more", () => {
    const mockPosts: ForumPost[] = Array.from({ length: 25 }, (_, i) => ({
      id: `mock-post-${i + 1}`,
      authorAddress: "GAOWNER123",
      authorName: `User ${i + 1}`,
      category: "general",
      title: `Topic Discussion ${i + 1}`,
      content: `Content for topic ${i + 1}`,
      tags: ["general"],
      upvotes: 0,
      upvotedBy: [],
      commentsCount: 0,
      comments: [],
      createdAt: Date.now() - i * 1000,
    }));

    useSocialStore.setState({ forumPosts: mockPosts });

    render(<CommunityForum walletAddress={WALLET_ADDR} />);

    // Initially renders 20 posts
    expect(screen.getByText("Topic Discussion 1")).toBeInTheDocument();
    expect(screen.getByText("Topic Discussion 20")).toBeInTheDocument();
    expect(screen.queryByText("Topic Discussion 21")).not.toBeInTheDocument();

    // Shows load more button with remaining count
    const loadMoreBtn = screen.getByRole("button", { name: /Load more \(5 remaining\)/i });
    expect(loadMoreBtn).toBeInTheDocument();

    // Click load more
    fireEvent.click(loadMoreBtn);

    // Now renders remaining posts
    expect(screen.getByText("Topic Discussion 21")).toBeInTheDocument();
    expect(screen.getByText("Topic Discussion 25")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Load more/i })).not.toBeInTheDocument();
  });
});
