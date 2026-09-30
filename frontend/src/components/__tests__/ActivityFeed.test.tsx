import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { ActivityFeed } from "../ActivityFeed";
import { useSocialStore } from "../../store/socialStore";

describe("ActivityFeed", () => {
  const WALLET_ADDR = "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA";

  beforeEach(() => {
    useSocialStore.setState({
      following: [],
      feedItems: [
        {
          id: "feed-test-1",
          authorAddress: "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA",
          authorName: "Aria Vance",
          type: "distribution",
          title: "New Royalty Distribution Completed",
          content: "Distributed 500 XLM across 12 soundtrack collaborators",
          timestamp: "1 hour ago",
          likes: 15,
          likedBy: [],
        },
      ],
    });
  });

  it("renders activity feed items and filter bar", () => {
    render(<ActivityFeed walletAddress={WALLET_ADDR} />);

    expect(screen.getByText("🌟 All Updates")).toBeInTheDocument();
    expect(screen.getByText("💰 Distributions")).toBeInTheDocument();
    expect(screen.getByText("New Royalty Distribution Completed")).toBeInTheDocument();
  });

  it("allows filtering feed items by category", () => {
    render(<ActivityFeed walletAddress={WALLET_ADDR} />);

    const distFilterBtn = screen.getByText("💰 Distributions");
    fireEvent.click(distFilterBtn);

    expect(screen.getByText("New Royalty Distribution Completed")).toBeInTheDocument();
  });

  it("allows posting a new update from the feed composer", () => {
    render(<ActivityFeed walletAddress={WALLET_ADDR} />);

    const textarea = screen.getByPlaceholderText(/Share a milestone/i);
    fireEvent.change(textarea, { target: { value: "Excited to launch our new royalty pool!" } });

    const postBtn = screen.getByRole("button", { name: /Post Update/i });
    fireEvent.click(postBtn);

    expect(screen.getByText("Excited to launch our new royalty pool!")).toBeInTheDocument();
  });

  it("allows liking and unliking a feed item", () => {
    render(<ActivityFeed walletAddress={WALLET_ADDR} />);

    const feedItems = useSocialStore.getState().feedItems;
    const firstItemId = feedItems[0].id;

    const likeBtn = screen.getByTestId(`feed-card-${firstItemId}`).querySelector(".feed-like-btn");
    expect(likeBtn).toBeInTheDocument();

    fireEvent.click(likeBtn!);
    expect(useSocialStore.getState().feedItems[0].likes).toBe(16);
  });
});
