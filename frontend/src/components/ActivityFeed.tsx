import React, { useState } from "react";
import { useSocialStore, ALL_BADGES, type ActivityFeedItem } from "../store/socialStore";
import "./ActivityFeed.css";

interface ActivityFeedProps {
  walletAddress: string | null;
  onSelectUserAddress?: (address: string) => void;
}

export const ActivityFeed: React.FC<ActivityFeedProps> = ({
  walletAddress,
  onSelectUserAddress,
}) => {
  const {
    feedItems,
    following,
    addFeedItem,
    toggleLikeFeedItem,
    toggleFollow,
    isFollowing,
    getProfile,
  } = useSocialStore();

  const currentUser = walletAddress ? getProfile(walletAddress) : null;

  const [activeFilter, setActiveFilter] = useState<
    "all" | "following" | "distribution" | "milestone" | "forum"
  >("all");

  const [newPostContent, setNewPostContent] = useState("");

  const handleCreatePost = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPostContent.trim() || !walletAddress || !currentUser) return;

    addFeedItem({
      authorAddress: walletAddress,
      authorName: currentUser.username,
      authorAvatar: currentUser.avatar,
      type: "update",
      title: `${currentUser.username} shared an update`,
      content: newPostContent.trim(),
    });

    setNewPostContent("");
  };

  const filteredFeed = feedItems.filter((item) => {
    if (activeFilter === "following") {
      return following.includes(item.authorAddress);
    }
    if (activeFilter === "distribution") {
      return item.type === "distribution";
    }
    if (activeFilter === "milestone") {
      return item.type === "milestone" || item.type === "badge";
    }
    if (activeFilter === "forum") {
      return item.type === "forum";
    }
    return true;
  });

  return (
    <div className="activity-feed-container" data-testid="activity-feed-component">
      {/* Feed Update Composer */}
      {walletAddress && (
        <div className="feed-create-card">
          <div className="feed-create-header">
            <div className="feed-create-avatar">
              {currentUser?.avatar ? (
                <img src={currentUser.avatar} alt={currentUser.username} />
              ) : (
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontWeight: 700,
                  }}
                >
                  {currentUser?.username.slice(0, 2).toUpperCase()}
                </div>
              )}
            </div>
            <div className="feed-input-wrapper">
              <form onSubmit={handleCreatePost}>
                <textarea
                  className="feed-textarea"
                  placeholder="Share a milestone, royalty update, or collaboration announcement..."
                  value={newPostContent}
                  onChange={(e) => setNewPostContent(e.target.value)}
                  rows={2}
                />
                <div className="feed-create-actions">
                  <span style={{ fontSize: "0.8rem", color: "var(--text-secondary, #9ca3af)" }}>
                    Posting as <strong>{currentUser?.username}</strong>
                  </span>
                  <button
                    type="submit"
                    className="feed-post-btn"
                    disabled={!newPostContent.trim()}
                  >
                    Post Update 🚀
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="feed-filter-bar">
        <button
          className={`feed-filter-chip ${activeFilter === "all" ? "active" : ""}`}
          onClick={() => setActiveFilter("all")}
        >
          🌟 All Updates
        </button>
        <button
          className={`feed-filter-chip ${activeFilter === "following" ? "active" : ""}`}
          onClick={() => setActiveFilter("following")}
        >
          👥 Following ({following.length})
        </button>
        <button
          className={`feed-filter-chip ${activeFilter === "distribution" ? "active" : ""}`}
          onClick={() => setActiveFilter("distribution")}
        >
          💰 Distributions
        </button>
        <button
          className={`feed-filter-chip ${activeFilter === "milestone" ? "active" : ""}`}
          onClick={() => setActiveFilter("milestone")}
        >
          🏆 Milestones & Badges
        </button>
        <button
          className={`feed-filter-chip ${activeFilter === "forum" ? "active" : ""}`}
          onClick={() => setActiveFilter("forum")}
        >
          💬 Community Discussions
        </button>
      </div>

      {/* Feed Items List */}
      <div className="feed-list">
        {filteredFeed.length === 0 ? (
          <div className="feed-empty-state">
            <span style={{ fontSize: "2rem" }}>📡</span>
            <h3>No updates found</h3>
            <p>
              {activeFilter === "following"
                ? "You aren't following anyone with recent activity yet. Follow creators to see their updates!"
                : "No activity matches the selected filter."}
            </p>
          </div>
        ) : (
          filteredFeed.map((item: ActivityFeedItem) => {
            const isLiked = walletAddress ? item.likedBy.includes(walletAddress) : false;
            const followingAuthor = isFollowing(item.authorAddress);
            const isSelfAuthor = walletAddress === item.authorAddress;
            const badgeMeta = item.badgeId ? ALL_BADGES[item.badgeId] : null;

            return (
              <div key={item.id} className="feed-card" data-testid={`feed-card-${item.id}`}>
                <div className="feed-card-header">
                  <div className="feed-author-info">
                    <div
                      className="feed-author-avatar"
                      style={{ cursor: "pointer" }}
                      onClick={() => onSelectUserAddress?.(item.authorAddress)}
                    >
                      {item.authorAvatar ? (
                        <img src={item.authorAvatar} alt={item.authorName} />
                      ) : (
                        <div
                          style={{
                            width: "100%",
                            height: "100%",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#fff",
                            fontWeight: 700,
                          }}
                        >
                          {item.authorName.slice(0, 2).toUpperCase()}
                        </div>
                      )}
                    </div>
                    <div className="feed-author-meta">
                      <span
                        className="feed-author-name"
                        style={{ cursor: "pointer" }}
                        onClick={() => onSelectUserAddress?.(item.authorAddress)}
                      >
                        {item.authorName}
                      </span>
                      <span className="feed-timestamp">{item.timestamp}</span>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span className={`feed-type-badge ${item.type}`}>{item.type}</span>

                    {!isSelfAuthor && walletAddress && (
                      <button
                        type="button"
                        className={`feed-filter-chip ${followingAuthor ? "active" : ""}`}
                        style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
                        onClick={() => toggleFollow(item.authorAddress, walletAddress)}
                      >
                        {followingAuthor ? "✓ Following" : "+ Follow"}
                      </button>
                    )}
                  </div>
                </div>

                <div className="feed-card-body">
                  <h4 className="feed-card-title">{item.title}</h4>
                  <p className="feed-card-content">{item.content}</p>

                  {badgeMeta && (
                    <div className="feed-badge-banner">
                      <span className="feed-badge-icon">{badgeMeta.icon}</span>
                      <div className="feed-badge-text">
                        <span className="feed-badge-title">{badgeMeta.title}</span>
                        <span className="feed-badge-desc">{badgeMeta.description}</span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="feed-card-footer">
                  <button
                    type="button"
                    className={`feed-like-btn ${isLiked ? "liked" : ""}`}
                    onClick={() => {
                      if (walletAddress) {
                        toggleLikeFeedItem(item.id, walletAddress);
                      }
                    }}
                  >
                    {isLiked ? "❤️ Liked" : "🤍 Like"} ({item.likes})
                  </button>

                  <span style={{ fontSize: "0.78rem", color: "var(--text-secondary, #9ca3af)" }}>
                    Stellar Network Verified
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
