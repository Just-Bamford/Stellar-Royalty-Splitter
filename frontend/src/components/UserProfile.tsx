import React, { useState } from "react";
import { useSocialStore, ALL_BADGES, type UserProfileData } from "../store/socialStore";
import { CopyButton } from "./CopyButton";
import "./UserProfile.css";

interface UserProfileProps {
  walletAddress: string | null;
  targetAddress?: string;
  onClose?: () => void;
}

export const UserProfile: React.FC<UserProfileProps> = ({
  walletAddress,
  targetAddress,
  onClose,
}) => {
  const activeAddress = targetAddress || walletAddress || "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA";
  const isSelf = walletAddress ? walletAddress === activeAddress : false;

  const {
    getProfile,
    upsertProfile,
    toggleFollow,
    isFollowing,
    shareAchievementToFeed,
  } = useSocialStore();

  const profile = getProfile(activeAddress);
  const followingState = isFollowing(activeAddress);

  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState<Partial<UserProfileData>>({
    username: profile.username,
    role: profile.role,
    bio: profile.bio,
    avatar: profile.avatar,
    socialLinks: { ...profile.socialLinks },
  });

  const handleEditOpen = () => {
    setFormData({
      username: profile.username,
      role: profile.role,
      bio: profile.bio,
      avatar: profile.avatar,
      socialLinks: { ...profile.socialLinks },
    });
    setIsEditing(true);
  };

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    upsertProfile(activeAddress, formData);
    setIsEditing(false);
  };

  const handleToggleFollow = () => {
    toggleFollow(activeAddress, walletAddress || undefined);
  };

  // Determine earned vs locked badges
  const earnedBadgeIds = new Set(profile.badges.map((b) => b.id));
  const allBadgeList = Object.values(ALL_BADGES);

  return (
    <div className="user-profile-container" data-testid="user-profile-component">
      <div className="profile-card">
        <div className="profile-header-banner" />

        <div className="profile-header-content">
          <div className="profile-avatar-row">
            <div className="profile-avatar-wrapper">
              {profile.avatar ? (
                <img
                  src={profile.avatar}
                  alt={profile.username}
                  className="profile-avatar-img"
                  onError={(e) => {
                    // Fallback on image loading error
                    (e.target as HTMLElement).style.display = "none";
                  }}
                />
              ) : (
                <div className="profile-avatar-fallback">
                  {profile.username.slice(0, 2).toUpperCase()}
                </div>
              )}
            </div>

            <div className="profile-actions">
              {isSelf ? (
                <button
                  type="button"
                  className="profile-btn profile-btn-secondary"
                  onClick={handleEditOpen}
                  aria-label="Edit Profile"
                >
                  ✏️ Edit Profile
                </button>
              ) : (
                <button
                  type="button"
                  className={`profile-btn ${
                    followingState ? "profile-btn-following" : "profile-btn-primary"
                  }`}
                  onClick={handleToggleFollow}
                  aria-label={followingState ? "Unfollow User" : "Follow User"}
                >
                  {followingState ? "✓ Following" : "+ Follow"}
                </button>
              )}

              {onClose && (
                <button
                  type="button"
                  className="profile-btn profile-btn-secondary"
                  onClick={onClose}
                  aria-label="Close Profile"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          <div className="profile-info">
            <div className="profile-name-row">
              <h2 className="profile-username">{profile.username}</h2>
              <span className="profile-role-badge">{profile.role}</span>
            </div>

            <div className="profile-address">
              <span>{activeAddress.slice(0, 8)}...{activeAddress.slice(-6)}</span>
              <CopyButton value={activeAddress} label="address" size="sm" />
            </div>

            <p className="profile-bio">{profile.bio || "No bio added yet."}</p>

            <div className="profile-socials">
              {profile.socialLinks.twitter && (
                <a
                  href={`https://twitter.com/${profile.socialLinks.twitter}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="profile-social-link"
                >
                  🐦 @{profile.socialLinks.twitter}
                </a>
              )}
              {profile.socialLinks.github && (
                <a
                  href={`https://github.com/${profile.socialLinks.github}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="profile-social-link"
                >
                  💻 {profile.socialLinks.github}
                </a>
              )}
              {profile.socialLinks.discord && (
                <span className="profile-social-link">
                  💬 {profile.socialLinks.discord}
                </span>
              )}
              {profile.socialLinks.website && (
                <a
                  href={profile.socialLinks.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="profile-social-link"
                >
                  🌐 Website
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="profile-stats-grid">
        <div className="profile-stat-card">
          <span className="stat-icon">💰</span>
          <span className="stat-value">{profile.earnedAmount.toLocaleString()} XLM</span>
          <span className="stat-label">Total Earned</span>
        </div>

        <div className="profile-stat-card">
          <span className="stat-icon">⚡</span>
          <span className="stat-value">{profile.distributionCount}</span>
          <span className="stat-label">Distributions</span>
        </div>

        <div className="profile-stat-card">
          <span className="stat-icon">🤝</span>
          <span className="stat-value">{profile.collaboratorCount}</span>
          <span className="stat-label">Collaborators</span>
        </div>

        <div className="profile-stat-card">
          <span className="stat-icon">🔥</span>
          <span className="stat-value">{profile.streakWeeks} Weeks</span>
          <span className="stat-label">Active Streak</span>
        </div>

        <div className="profile-stat-card">
          <span className="stat-icon">👥</span>
          <span className="stat-value">{profile.followersCount}</span>
          <span className="stat-label">Followers</span>
        </div>
      </div>

      {/* Badges & Achievements */}
      <div className="profile-card" style={{ padding: "1.5rem" }}>
        <h3 className="profile-section-title">
          <span>🏆 Achievements & Badges</span>
          <span style={{ fontSize: "0.85rem", color: "var(--text-secondary, #9ca3af)", fontWeight: 500 }}>
            {profile.badges.length} of {allBadgeList.length} Unlocked
          </span>
        </h3>

        <div className="badges-grid">
          {allBadgeList.map((badge) => {
            const isEarned = earnedBadgeIds.has(badge.id);
            const earnedInfo = profile.badges.find((b) => b.id === badge.id);

            return (
              <div
                key={badge.id}
                className={`badge-card ${isEarned ? "badge-card--earned" : "badge-card--locked"}`}
              >
                <div className="badge-icon-box">{badge.icon}</div>
                <div className="badge-details">
                  <span className="badge-title">{badge.title}</span>
                  <span className="badge-description">{badge.description}</span>
                  {isEarned ? (
                    <>
                      <span className="badge-date">Unlocked {earnedInfo?.earnedAt}</span>
                      <button
                        type="button"
                        className="badge-share-btn"
                        onClick={() => shareAchievementToFeed(activeAddress, badge.id)}
                      >
                        🚀 Share Achievement
                      </button>
                    </>
                  ) : (
                    <span className="badge-date" style={{ color: "#9ca3af" }}>🔒 Locked</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Edit Profile Modal */}
      {isEditing && (
        <div className="edit-profile-modal-backdrop" onClick={() => setIsEditing(false)}>
          <div className="edit-profile-modal" onClick={(e) => e.stopPropagation()}>
            <div className="edit-profile-header">
              <h3 className="edit-profile-title">Edit Profile</h3>
              <button
                type="button"
                className="profile-btn profile-btn-secondary"
                onClick={() => setIsEditing(false)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveProfile} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div className="form-grid-2">
                <div className="form-group">
                  <label className="form-label" htmlFor="edit-username">Display Name</label>
                  <input
                    id="edit-username"
                    type="text"
                    className="form-input"
                    value={formData.username || ""}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="edit-role">Role / Title</label>
                  <input
                    id="edit-role"
                    type="text"
                    className="form-input"
                    placeholder="e.g. Music Producer, Digital Artist"
                    value={formData.role || ""}
                    onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="edit-bio">Bio</label>
                <textarea
                  id="edit-bio"
                  className="form-textarea"
                  rows={3}
                  value={formData.bio || ""}
                  onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                  placeholder="Tell the community about your work and royalty projects..."
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="edit-avatar">Avatar Image URL</label>
                <input
                  id="edit-avatar"
                  type="url"
                  className="form-input"
                  placeholder="https://..."
                  value={formData.avatar || ""}
                  onChange={(e) => setFormData({ ...formData, avatar: e.target.value })}
                />
              </div>

              <div className="form-grid-2">
                <div className="form-group">
                  <label className="form-label" htmlFor="edit-twitter">Twitter / X Handle</label>
                  <input
                    id="edit-twitter"
                    type="text"
                    className="form-input"
                    placeholder="username"
                    value={formData.socialLinks?.twitter || ""}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        socialLinks: { ...formData.socialLinks, twitter: e.target.value },
                      })
                    }
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="edit-github">GitHub Handle</label>
                  <input
                    id="edit-github"
                    type="text"
                    className="form-input"
                    placeholder="username"
                    value={formData.socialLinks?.github || ""}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        socialLinks: { ...formData.socialLinks, github: e.target.value },
                      })
                    }
                  />
                </div>
              </div>

              <div className="profile-actions" style={{ justifyContent: "flex-end", marginTop: "0.5rem" }}>
                <button
                  type="button"
                  className="profile-btn profile-btn-secondary"
                  onClick={() => setIsEditing(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="profile-btn profile-btn-primary">
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
