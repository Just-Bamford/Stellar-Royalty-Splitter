import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";
import { CommunityForum, FORUM_PAGE_SIZE } from "../CommunityForum";
import { useSocialStore, type ForumPost } from "../../store/socialStore";

// #1391: the forum list renders FORUM_PAGE_SIZE posts at a time.

const WALLET_ADDR = "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA";
const TITLE_RE = /^Paginated post \d+$/;

function makePosts(count: number, category: ForumPost["category"] = "music"): ForumPost[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `paginated-${category}-${i + 1}`,
    authorAddress: WALLET_ADDR,
    authorName: "Tester",
    category,
    title: `Paginated post ${i + 1}`,
    content: `Body ${i + 1}`,
    tags: [category],
    timestamp: new Date(2026, 0, 1, 0, i).toISOString(),
    upvotes: 0,
    upvotedBy: [],
    comments: [],
  }));
}

function renderedPostCount() {
  return screen.queryAllByText(TITLE_RE).length;
}

describe("CommunityForum pagination (#1391)", () => {
  let originalPosts: ForumPost[];

  beforeEach(() => {
    originalPosts = useSocialStore.getState().forumPosts;
  });

  afterEach(() => {
    useSocialStore.setState({ forumPosts: originalPosts });
  });

  it("renders only the first page and reveals the next page on Load more", () => {
    expect(FORUM_PAGE_SIZE).toBe(20);
    useSocialStore.setState({ forumPosts: makePosts(45) });
    render(<CommunityForum walletAddress={WALLET_ADDR} />);

    expect(renderedPostCount()).toBe(20);
    fireEvent.click(screen.getByRole("button", { name: "Load more (25 remaining)" }));

    expect(renderedPostCount()).toBe(40);
    fireEvent.click(screen.getByRole("button", { name: "Load more (5 remaining)" }));

    expect(renderedPostCount()).toBe(45);
    expect(screen.queryByRole("button", { name: /Load more/ })).not.toBeInTheDocument();
  });

  it("does not show Load more when every post fits on one page", () => {
    useSocialStore.setState({ forumPosts: makePosts(FORUM_PAGE_SIZE) });
    render(<CommunityForum walletAddress={WALLET_ADDR} />);

    expect(renderedPostCount()).toBe(FORUM_PAGE_SIZE);
    expect(screen.queryByRole("button", { name: /Load more/ })).not.toBeInTheDocument();
  });

  it("resets to the first page when the category filter changes", () => {
    useSocialStore.setState({ forumPosts: [...makePosts(30, "music"), ...makePosts(30, "art")] });
    render(<CommunityForum walletAddress={WALLET_ADDR} />);

    fireEvent.click(screen.getByRole("button", { name: "Load more (40 remaining)" }));
    expect(renderedPostCount()).toBe(40);

    fireEvent.click(screen.getByRole("button", { name: "🎨 Art" }));
    expect(renderedPostCount()).toBe(20);
    expect(screen.getByRole("button", { name: "Load more (10 remaining)" })).toBeInTheDocument();
  });

  it("resets to the first page when the search query changes", () => {
    useSocialStore.setState({ forumPosts: makePosts(50) });
    render(<CommunityForum walletAddress={WALLET_ADDR} />);

    fireEvent.click(screen.getByRole("button", { name: "Load more (30 remaining)" }));
    expect(renderedPostCount()).toBe(40);

    fireEvent.change(screen.getByPlaceholderText(/Search topics or tags/i), {
      target: { value: "Paginated" },
    });
    expect(renderedPostCount()).toBe(20);
    expect(screen.getByRole("button", { name: "Load more (30 remaining)" })).toBeInTheDocument();
  });
});
