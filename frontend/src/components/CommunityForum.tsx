import React, { useState } from "react";
import { useSocialStore, type ForumPost } from "../store/socialStore";
import "./CommunityForum.css";

interface CommunityForumProps {
  walletAddress: string | null;
  onSelectUserAddress?: (address: string) => void;
}

export const CommunityForum: React.FC<CommunityForumProps> = ({
  walletAddress,
  onSelectUserAddress,
}) => {
  const {
    forumPosts,
    events,
    createForumPost,
    toggleUpvoteForumPost,
    addForumComment,
    toggleEventRSVP,
    getTopEarners,
    getMostActive,
    getStreakLeaders,
    getProfile,
  } = useSocialStore();

  const [activeTab, setActiveTab] = useState<"forums" | "leaderboards" | "events">("forums");

  // Forums state
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [expandedCommentsPostId, setExpandedCommentsPostId] = useState<string | null>(null);
  const [commentInputText, setCommentInputText] = useState<string>("");

  // Create post modal state
  const [isCreatingPost, setIsCreatingPost] = useState(false);
  const [postTitle, setPostTitle] = useState("");
  const [postCategory, setPostCategory] = useState<ForumPost["category"]>("music");
  const [postContent, setPostContent] = useState("");
  const [postTags, setPostTags] = useState("");

  // Leaderboard state
  const [leaderboardType, setLeaderboardType] = useState<"earnings" | "active" | "streak">("earnings");

  const currentUser = walletAddress ? getProfile(walletAddress) : null;

  const handleOpenCreatePost = () => {
    setIsCreatingPost(true);
  };

  const handleSubmitPost = (e: React.FormEvent) => {
    e.preventDefault();
    if (!walletAddress || !currentUser || !postTitle.trim() || !postContent.trim()) return;

    const tagsArray = postTags
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);

    createForumPost({
      authorAddress: walletAddress,
      authorName: currentUser.username,
      authorAvatar: currentUser.avatar,
      category: postCategory,
      title: postTitle.trim(),
      content: postContent.trim(),
      tags: tagsArray.length > 0 ? tagsArray : [postCategory],
    });

    setPostTitle("");
    setPostContent("");
    setPostTags("");
    setIsCreatingPost(false);
  };

  const handleAddComment = (postId: string) => {
    if (!walletAddress || !currentUser || !commentInputText.trim()) return;
    addForumComment(postId, {
      authorAddress: walletAddress,
      authorName: currentUser.username,
      authorAvatar: currentUser.avatar,
      content: commentInputText.trim(),
    });
    setCommentInputText("");
  };

  // Filtered Forum Posts
  const filteredPosts = forumPosts.filter((post) => {
    const matchesCategory = selectedCategory === "all" || post.category === selectedCategory;
    const matchesSearch =
      post.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      post.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
      post.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesCategory && matchesSearch;
  });

  return (
    <div className="community-forum-container" data-testid="community-forum-component">
      {/* Navigation Tabs */}
      <div className="community-nav-tabs">
        <button
          type="button"
          className={`community-tab-btn ${activeTab === "forums" ? "active" : ""}`}
          onClick={() => setActiveTab("forums")}
        >
          💬 Discussion Forums
        </button>
        <button
          type="button"
          className={`community-tab-btn ${activeTab === "leaderboards" ? "active" : ""}`}
          onClick={() => setActiveTab("leaderboards")}
        >
          🏆 Leaderboards
        </button>
        <button
          type="button"
          className={`community-tab-btn ${activeTab === "events" ? "active" : ""}`}
          onClick={() => setActiveTab("events")}
        >
          📅 Events Calendar
        </button>
      </div>

      {/* ── FORUMS TAB ─────────────────────────────────────────────────── */}
      {activeTab === "forums" && (
        <>
          <div className="forum-controls-row">
            <div className="forum-categories-bar">
              <button
                type="button"
                className={`category-chip ${selectedCategory === "all" ? "active" : ""}`}
                onClick={() => setSelectedCategory("all")}
              >
                🌐 All Topics
              </button>
              <button
                type="button"
                className={`category-chip ${selectedCategory === "music" ? "active" : ""}`}
                onClick={() => setSelectedCategory("music")}
              >
                🎵 Music
              </button>
              <button
                type="button"
                className={`category-chip ${selectedCategory === "art" ? "active" : ""}`}
                onClick={() => setSelectedCategory("art")}
              >
                🎨 Art
              </button>
              <button
                type="button"
                className={`category-chip ${selectedCategory === "gaming" ? "active" : ""}`}
                onClick={() => setSelectedCategory("gaming")}
              >
                🎮 Gaming
              </button>
              <button
                type="button"
                className={`category-chip ${selectedCategory === "dev" ? "active" : ""}`}
                onClick={() => setSelectedCategory("dev")}
              >
                💻 Development
              </button>
              <button
                type="button"
                className={`category-chip ${selectedCategory === "collaboration" ? "active" : ""}`}
                onClick={() => setSelectedCategory("collaboration")}
              >
                🤝 Collaboration
              </button>
            </div>

            <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
              <input
                type="text"
                className="forum-search-input"
                placeholder="🔍 Search topics or tags..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />

              {walletAddress && (
                <button
                  type="button"
                  className="profile-btn profile-btn-primary"
                  onClick={handleOpenCreatePost}
                  style={{ whiteSpace: "nowrap" }}
                >
                  + New Topic
                </button>
              )}
            </div>
          </div>

          <div className="forum-posts-list">
            {filteredPosts.length === 0 ? (
              <div className="feed-empty-state">
                <span style={{ fontSize: "2rem" }}>💬</span>
                <h3>No discussions found</h3>
                <p>Be the first to start a conversation in this topic!</p>
              </div>
            ) : (
              filteredPosts.map((post) => {
                const hasUpvoted = walletAddress ? post.upvotedBy.includes(walletAddress) : false;
                const isExpanded = expandedCommentsPostId === post.id;

                return (
                  <div key={post.id} className="forum-post-card" data-testid={`forum-post-${post.id}`}>
                    {/* Upvote Column */}
                    <div
                      className={`upvote-box ${hasUpvoted ? "upvoted" : ""}`}
                      onClick={() => walletAddress && toggleUpvoteForumPost(post.id, walletAddress)}
                      title={hasUpvoted ? "Remove Upvote" : "Upvote Post"}
                    >
                      <span className="upvote-arrow">▲</span>
                      <span className="upvote-count">{post.upvotes}</span>
                    </div>

                    {/* Main Post Content */}
                    <div className="forum-post-main">
                      <div className="post-header-meta">
                        <span className="category-tag">{post.category}</span>
                        <div className="post-tags">
                          {post.tags.map((t, idx) => (
                            <span key={idx} className="tag-pill">#{t}</span>
                          ))}
                        </div>
                      </div>

                      <h3 className="post-title">{post.title}</h3>
                      <p className="post-content">{post.content}</p>

                      <div className="post-author-footer">
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.5rem",
                            cursor: "pointer",
                          }}
                          onClick={() => onSelectUserAddress?.(post.authorAddress)}
                        >
                          <span style={{ fontWeight: 600, fontSize: "0.85rem", color: "#818cf8" }}>
                            {post.authorName}
                          </span>
                          <span style={{ fontSize: "0.78rem", color: "var(--text-secondary, #9ca3af)" }}>
                            • {post.timestamp}
                          </span>
                        </div>

                        <button
                          type="button"
                          className="comments-toggle-btn"
                          onClick={() =>
                            setExpandedCommentsPostId(isExpanded ? null : post.id)
                          }
                        >
                          💬 {post.comments.length} Comments
                        </button>
                      </div>

                      {/* Expanded Comments */}
                      {isExpanded && (
                        <div className="post-comments-wrapper">
                          {post.comments.map((comment) => (
                            <div key={comment.id} className="comment-card">
                              <span className="comment-author">{comment.authorName}</span>
                              <p className="comment-body">{comment.content}</p>
                            </div>
                          ))}

                          {walletAddress && (
                            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.4rem" }}>
                              <input
                                type="text"
                                className="form-input"
                                style={{ flex: 1, fontSize: "0.85rem" }}
                                placeholder="Add a reply..."
                                value={commentInputText}
                                onChange={(e) => setCommentInputText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleAddComment(post.id);
                                }}
                              />
                              <button
                                type="button"
                                className="profile-btn profile-btn-primary"
                                style={{ padding: "0.4rem 0.8rem", fontSize: "0.8rem" }}
                                onClick={() => handleAddComment(post.id)}
                              >
                                Reply
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      {/* ── LEADERBOARDS TAB ───────────────────────────────────────────── */}
      {activeTab === "leaderboards" && (
        <div className="leaderboard-card">
          <div className="forum-controls-row" style={{ marginBottom: "1rem" }}>
            <h3 style={{ margin: 0, fontSize: "1.3rem" }}>🏆 Leaderboards</h3>

            <div className="forum-categories-bar">
              <button
                type="button"
                className={`category-chip ${leaderboardType === "earnings" ? "active" : ""}`}
                onClick={() => setLeaderboardType("earnings")}
              >
                💰 Top Earnings
              </button>
              <button
                type="button"
                className={`category-chip ${leaderboardType === "active" ? "active" : ""}`}
                onClick={() => setLeaderboardType("active")}
              >
                ⚡ Most Active
              </button>
              <button
                type="button"
                className={`category-chip ${leaderboardType === "streak" ? "active" : ""}`}
                onClick={() => setLeaderboardType("streak")}
              >
                🔥 Streak Leaders
              </button>
            </div>
          </div>

          {(() => {
            let leaderboardData = [];
            if (leaderboardType === "earnings") leaderboardData = getTopEarners();
            else if (leaderboardType === "active") leaderboardData = getMostActive();
            else leaderboardData = getStreakLeaders();

            return (
              <table className="leaderboard-table" data-testid="leaderboard-table">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Collaborator</th>
                    <th>Role</th>
                    {leaderboardType === "earnings" && <th>Total Earned (XLM)</th>}
                    {leaderboardType === "active" && <th>Distributions</th>}
                    {leaderboardType === "streak" && <th>Active Streak</th>}
                    <th>Badges</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboardData.map((user, index) => {
                    const rankEmoji =
                      index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `#${index + 1}`;

                    return (
                      <tr key={user.address}>
                        <td className="rank-badge">{rankEmoji}</td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                            <img
                              src={user.avatar}
                              alt={user.username}
                              style={{ width: 36, height: 36, borderRadius: "50%" }}
                            />
                            <div style={{ display: "flex", flexDirection: "column" }}>
                              <span style={{ fontWeight: 700, color: "#fff" }}>{user.username}</span>
                              <span style={{ fontSize: "0.75rem", color: "#9ca3af", fontFamily: "monospace" }}>
                                {user.address.slice(0, 6)}...{user.address.slice(-4)}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className="profile-role-badge">{user.role}</span>
                        </td>
                        {leaderboardType === "earnings" && (
                          <td style={{ fontWeight: 700, color: "#10b981" }}>
                            {user.earnedAmount.toLocaleString()} XLM
                          </td>
                        )}
                        {leaderboardType === "active" && (
                          <td style={{ fontWeight: 700, color: "#818cf8" }}>
                            {user.distributionCount} Splits
                          </td>
                        )}
                        {leaderboardType === "streak" && (
                          <td style={{ fontWeight: 700, color: "#f59e0b" }}>
                            🔥 {user.streakWeeks} Weeks
                          </td>
                        )}
                        <td>
                          <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                            🏆 {user.badges.length}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="profile-btn profile-btn-secondary"
                            style={{ padding: "0.3rem 0.6rem", fontSize: "0.78rem" }}
                            onClick={() => onSelectUserAddress?.(user.address)}
                          >
                            View Profile
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          })()}
        </div>
      )}

      {/* ── EVENTS CALENDAR TAB ────────────────────────────────────────── */}
      {activeTab === "events" && (
        <div>
          <div className="forum-controls-row" style={{ marginBottom: "1.25rem" }}>
            <h3 style={{ margin: 0, fontSize: "1.3rem" }}>📅 Upcoming Community Events & Collabs</h3>
          </div>

          <div className="events-grid">
            {events.map((evt) => {
              const isRSVPd = walletAddress ? evt.rsvps.includes(walletAddress) : false;
              const formattedDate = new Date(evt.date).toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });

              return (
                <div key={evt.id} className="event-card" data-testid={`event-card-${evt.id}`}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span className="category-tag">{evt.category}</span>
                      <span style={{ fontSize: "0.8rem", color: "#818cf8", fontWeight: 600 }}>
                        {formattedDate}
                      </span>
                    </div>

                    <h4 style={{ margin: "0.4rem 0 0", fontSize: "1.1rem", fontWeight: 700, color: "#fff" }}>
                      {evt.title}
                    </h4>

                    <p style={{ fontSize: "0.88rem", color: "#d1d5db", margin: 0, lineHeight: 1.4 }}>
                      {evt.description}
                    </p>
                  </div>

                  <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: "0.75rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "0.78rem", color: "#9ca3af" }}>
                      📍 {evt.location}
                    </span>

                    {walletAddress && (
                      <button
                        type="button"
                        className={`profile-btn ${isRSVPd ? "profile-btn-following" : "profile-btn-primary"}`}
                        style={{ fontSize: "0.8rem", padding: "0.35rem 0.75rem" }}
                        onClick={() => toggleEventRSVP(evt.id, walletAddress)}
                      >
                        {isRSVPd ? "✓ Attending" : "RSVP"} ({evt.rsvps.length})
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* New Topic Modal */}
      {isCreatingPost && (
        <div className="edit-profile-modal-backdrop" onClick={() => setIsCreatingPost(false)}>
          <div className="edit-profile-modal" onClick={(e) => e.stopPropagation()}>
            <div className="edit-profile-header">
              <h3 className="edit-profile-title">Start a New Discussion Topic</h3>
              <button
                type="button"
                className="profile-btn profile-btn-secondary"
                onClick={() => setIsCreatingPost(false)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitPost} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div className="form-group">
                <label className="form-label" htmlFor="topic-category">Category</label>
                <select
                  id="topic-category"
                  className="form-input"
                  value={postCategory}
                  onChange={(e) => setPostCategory(e.target.value as ForumPost["category"])}
                >
                  <option value="music">🎵 Music & Audio</option>
                  <option value="art">🎨 Digital & Generative Art</option>
                  <option value="gaming">🎮 Gaming & Soundtracks</option>
                  <option value="dev">💻 Soroban & Smart Contracts</option>
                  <option value="collaboration">🤝 Collaboration Opportunities</option>
                  <option value="general">💬 General Discussion</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="topic-title">Title</label>
                <input
                  id="topic-title"
                  type="text"
                  className="form-input"
                  placeholder="e.g. Best practices for automated secondary music royalty splits"
                  value={postTitle}
                  onChange={(e) => setPostTitle(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="topic-tags">Tags (comma separated)</label>
                <input
                  id="topic-tags"
                  type="text"
                  className="form-input"
                  placeholder="music, splits, secondary-royalties"
                  value={postTags}
                  onChange={(e) => setPostTags(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="topic-content">Content</label>
                <textarea
                  id="topic-content"
                  className="form-textarea"
                  rows={4}
                  placeholder="Describe your question or discussion topic in detail..."
                  value={postContent}
                  onChange={(e) => setPostContent(e.target.value)}
                  required
                />
              </div>

              <div className="profile-actions" style={{ justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="profile-btn profile-btn-secondary"
                  onClick={() => setIsCreatingPost(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="profile-btn profile-btn-primary">
                  Publish Topic 🚀
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
