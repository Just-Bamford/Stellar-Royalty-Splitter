import { describe, it, expect, beforeEach } from "vitest";
import { useSocialStore } from "../socialStore";

describe("socialStore", () => {
  const TEST_ADDR = "GTESTUSER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const TARGET_ADDR = "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA";

  beforeEach(() => {
    // Reset store state
    useSocialStore.setState({
      profiles: useSocialStore.getState().profiles,
      following: [],
      feedItems: [],
      forumPosts: [],
    });
  });

  it("retrieves default profile and allows profile creation/edit", () => {
    const store = useSocialStore.getState();
    const profile = store.getProfile(TEST_ADDR);
    expect(profile.address).toBe(TEST_ADDR);
    expect(profile.username).toContain("GTESTU");

    // Upsert profile
    store.upsertProfile(TEST_ADDR, {
      username: "Test Creator",
      bio: "Building cool royalty tools.",
      role: "Audio Engineer",
      socialLinks: { twitter: "testcreator" },
    });

    const updated = useSocialStore.getState().getProfile(TEST_ADDR);
    expect(updated.username).toBe("Test Creator");
    expect(updated.bio).toBe("Building cool royalty tools.");
    expect(updated.role).toBe("Audio Engineer");
    expect(updated.socialLinks.twitter).toBe("testcreator");
  });

  it("handles follow/unfollow toggle correctly", () => {
    const store = useSocialStore.getState();
    expect(store.isFollowing(TARGET_ADDR)).toBe(false);

    store.toggleFollow(TARGET_ADDR, TEST_ADDR);
    expect(useSocialStore.getState().isFollowing(TARGET_ADDR)).toBe(true);

    // Unfollow
    store.toggleFollow(TARGET_ADDR, TEST_ADDR);
    expect(useSocialStore.getState().isFollowing(TARGET_ADDR)).toBe(false);
  });

  it("awards badges when milestone thresholds are reached", () => {
    const store = useSocialStore.getState();
    store.upsertProfile(TEST_ADDR, {
      earnedAmount: 1500,
      collaboratorCount: 120,
      distributionCount: 5,
      streakWeeks: 4,
    });

    const profile = useSocialStore.getState().getProfile(TEST_ADDR);
    const badgeIds = profile.badges.map((b) => b.id);
    expect(badgeIds).toContain("1k_earned");
    expect(badgeIds).toContain("100_collaborators");
    expect(badgeIds).toContain("weekly_streak");
    expect(badgeIds).toContain("first_split");
  });

  it("creates activity feed items and allows liking", () => {
    const store = useSocialStore.getState();
    store.addFeedItem({
      authorAddress: TEST_ADDR,
      authorName: "Test Creator",
      type: "update",
      title: "Hello World",
      content: "First post on activity feed!",
    });

    const items = useSocialStore.getState().feedItems;
    expect(items.length).toBeGreaterThan(0);
    const item = items[0];
    expect(item.title).toBe("Hello World");
    expect(item.likes).toBe(0);

    // Like item
    useSocialStore.getState().toggleLikeFeedItem(item.id, TEST_ADDR);
    expect(useSocialStore.getState().feedItems[0].likes).toBe(1);
  });

  it("handles forum posts, upvotes, and comments", () => {
    const store = useSocialStore.getState();
    const post = store.createForumPost({
      authorAddress: TEST_ADDR,
      authorName: "Test Creator",
      category: "music",
      title: "Audio mastering techniques",
      content: "What compressor do you use on the master bus?",
      tags: ["music", "mastering"],
    });

    expect(post.title).toBe("Audio mastering techniques");

    // Add comment
    store.addForumComment(post.id, {
      authorAddress: TARGET_ADDR,
      authorName: "Aria Vance",
      content: "I recommend a gentle VCA compressor!",
    });

    const posts = useSocialStore.getState().forumPosts;
    const currentPost = posts.find((p) => p.id === post.id);
    expect(currentPost?.comments.length).toBe(1);
    expect(currentPost?.comments[0].content).toBe("I recommend a gentle VCA compressor!");
  });

  it("calculates leaderboards correctly", () => {
    const store = useSocialStore.getState();
    const topEarners = store.getTopEarners();
    expect(topEarners.length).toBeGreaterThan(0);
    expect(topEarners[0].earnedAmount).toBeGreaterThanOrEqual(topEarners[1]?.earnedAmount || 0);

    const mostActive = store.getMostActive();
    expect(mostActive[0].distributionCount).toBeGreaterThanOrEqual(mostActive[1]?.distributionCount || 0);
  });
});
