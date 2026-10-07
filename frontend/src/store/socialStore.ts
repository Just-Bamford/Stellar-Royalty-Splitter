import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export interface Badge {
  id: string;
  title: string;
  description: string;
  icon: string;
  category: "earnings" | "collaborators" | "streak" | "milestone" | "community";
  earnedAt: string;
}

export interface UserProfileData {
  address: string;
  username: string;
  bio: string;
  avatar: string;
  role: string;
  socialLinks: {
    twitter?: string;
    github?: string;
    discord?: string;
    website?: string;
  };
  earnedAmount: number;
  distributionCount: number;
  collaboratorCount: number;
  streakWeeks: number;
  lastActiveTimestamp: number;
  badges: Badge[];
  followersCount: number;
  followingCount: number;
}

export interface ActivityFeedItem {
  id: string;
  authorAddress: string;
  authorName: string;
  authorAvatar?: string;
  type: "distribution" | "milestone" | "badge" | "forum" | "update";
  title: string;
  content: string;
  timestamp: string;
  likes: number;
  likedBy: string[];
  badgeId?: string;
  amount?: number;
}

export interface ForumComment {
  id: string;
  authorAddress: string;
  authorName: string;
  authorAvatar?: string;
  content: string;
  timestamp: string;
}

export interface ForumPost {
  id: string;
  authorAddress: string;
  authorName: string;
  authorAvatar?: string;
  category: "music" | "art" | "gaming" | "dev" | "collaboration" | "general";
  title: string;
  content: string;
  tags: string[];
  timestamp: string;
  upvotes: number;
  upvotedBy: string[];
  comments: ForumComment[];
}

export interface CommunityEvent {
  id: string;
  title: string;
  description: string;
  category: "music" | "art" | "gaming" | "dev" | "general";
  date: string;
  location: string;
  organizer: string;
  rsvps: string[];
}

export interface SocialState {
  profiles: Record<string, UserProfileData>;
  following: string[]; // List of addresses followed by current user
  feedItems: ActivityFeedItem[];
  forumPosts: ForumPost[];
  events: CommunityEvent[];

  // Profile management
  getProfile: (address: string) => UserProfileData;
  upsertProfile: (address: string, data: Partial<UserProfileData>) => void;
  toggleFollow: (targetAddress: string, currentUserAddress?: string) => void;
  isFollowing: (targetAddress: string) => boolean;

  // Gamification & Badges
  checkAndAwardBadges: (address: string) => Badge[];
  recordUserActivity: (
    address: string,
    activityType: "distribution" | "forum" | "login",
    extraData?: { amount?: number; collaboratorsCount?: number }
  ) => void;
  shareAchievementToFeed: (address: string, badgeId: string) => void;

  // Feed management
  addFeedItem: (
    item: Omit<ActivityFeedItem, "id" | "timestamp" | "likes" | "likedBy">
  ) => void;
  toggleLikeFeedItem: (id: string, userAddress: string) => void;

  // Forum management
  createForumPost: (
    post: Omit<ForumPost, "id" | "timestamp" | "upvotes" | "upvotedBy" | "comments">
  ) => ForumPost;
  toggleUpvoteForumPost: (postId: string, userAddress: string) => void;
  addForumComment: (
    postId: string,
    comment: { authorAddress: string; authorName: string; authorAvatar?: string; content: string }
  ) => void;

  // Events
  toggleEventRSVP: (eventId: string, userAddress: string) => void;

  // Leaderboard Calculation Helpers
  getTopEarners: (limit?: number) => UserProfileData[];
  getMostActive: (limit?: number) => UserProfileData[];
  getStreakLeaders: (limit?: number) => UserProfileData[];
}

export const ALL_BADGES: Record<string, Omit<Badge, "earnedAt">> = {
  "1k_earned": {
    id: "1k_earned",
    title: "1k Earned",
    description: "Earned over 1,000 XLM in royalties",
    icon: "💰",
    category: "earnings",
  },
  "100_collaborators": {
    id: "100_collaborators",
    title: "100 Collaborators",
    description: "Distributed royalties to over 100 collaborators",
    icon: "🤝",
    category: "collaborators",
  },
  "weekly_streak": {
    id: "weekly_streak",
    title: "Streak Master",
    description: "Active for 4+ consecutive weeks",
    icon: "🔥",
    category: "streak",
  },
  "first_split": {
    id: "first_split",
    title: "First Split",
    description: "Executed your first royalty distribution",
    icon: "⚡",
    category: "milestone",
  },
  "community_voice": {
    id: "community_voice",
    title: "Community Voice",
    description: "Posted 5 or more discussion topics in the forum",
    icon: "🗣️",
    category: "community",
  },
  "star_creator": {
    id: "star_creator",
    title: "Star Creator",
    description: "Gained 10 or more followers",
    icon: "🌟",
    category: "milestone",
  },
};

const DEFAULT_PROFILES: Record<string, UserProfileData> = {
  "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA": {
    address: "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA",
    username: "Aria Vance",
    bio: "Independent Synthwave & EDM producer releasing royalty-split tracks on Stellar.",
    avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=Aria",
    role: "Music Producer",
    socialLinks: {
      twitter: "ariavance_music",
      github: "ariavance",
      website: "https://ariavance.io",
    },
    earnedAmount: 1450,
    distributionCount: 24,
    collaboratorCount: 105,
    streakWeeks: 6,
    lastActiveTimestamp: Date.now() - 3600000,
    badges: [
      { ...ALL_BADGES["1k_earned"], earnedAt: "2026-08-15" },
      { ...ALL_BADGES["100_collaborators"], earnedAt: "2026-09-01" },
      { ...ALL_BADGES["weekly_streak"], earnedAt: "2026-09-20" },
      { ...ALL_BADGES["first_split"], earnedAt: "2026-06-10" },
    ],
    followersCount: 42,
    followingCount: 18,
  },
  "GSTELLAR9876543210ABCDEFGHIJKLMNOPQRSTUVWXYZBBBB": {
    address: "GSTELLAR9876543210ABCDEFGHIJKLMNOPQRSTUVWXYZBBBB",
    username: "PixelCraft Studio",
    bio: "Digital Art Collective crafting generative 3D assets with automated royalty splits.",
    avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=PixelCraft",
    role: "Digital Artist",
    socialLinks: {
      twitter: "pixelcraft_art",
      discord: "pixelcraft#9900",
    },
    earnedAmount: 920,
    distributionCount: 18,
    collaboratorCount: 48,
    streakWeeks: 3,
    lastActiveTimestamp: Date.now() - 86400000,
    badges: [
      { ...ALL_BADGES["first_split"], earnedAt: "2026-07-01" },
      { ...ALL_BADGES["community_voice"], earnedAt: "2026-08-28" },
    ],
    followersCount: 29,
    followingCount: 14,
  },
  "GLOWING5432109876ABCDEFGHIJKLMNOPQRSTUVWXYZCCCC": {
    address: "GLOWING5432109876ABCDEFGHIJKLMNOPQRSTUVWXYZCCCC",
    username: "GameForge Labs",
    bio: "Indie game studio developing decentralised RPG soundtrack & asset pools.",
    avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=GameForge",
    role: "Game Developer",
    socialLinks: {
      github: "gameforgelabs",
      twitter: "gameforgelabs",
    },
    earnedAmount: 2100,
    distributionCount: 35,
    collaboratorCount: 140,
    streakWeeks: 8,
    lastActiveTimestamp: Date.now() - 172800000,
    badges: [
      { ...ALL_BADGES["1k_earned"], earnedAt: "2026-07-20" },
      { ...ALL_BADGES["100_collaborators"], earnedAt: "2026-08-10" },
      { ...ALL_BADGES["weekly_streak"], earnedAt: "2026-08-30" },
      { ...ALL_BADGES["first_split"], earnedAt: "2026-05-15" },
    ],
    followersCount: 68,
    followingCount: 30,
  },
};

const DEFAULT_FEED: ActivityFeedItem[] = [
  {
    id: "feed-1",
    authorAddress: "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA",
    authorName: "Aria Vance",
    authorAvatar: "https://api.dicebear.com/7.x/bottts/svg?seed=Aria",
    type: "distribution",
    title: "New Royalty Distribution Completed",
    content: "Distributed 500 XLM across 12 soundtrack collaborators for 'Neon Dreams LP'!",
    timestamp: "2 hours ago",
    likes: 15,
    likedBy: [],
    amount: 500,
  },
  {
    id: "feed-2",
    authorAddress: "GSTELLAR9876543210ABCDEFGHIJKLMNOPQRSTUVWXYZBBBB",
    authorName: "PixelCraft Studio",
    authorAvatar: "https://api.dicebear.com/7.x/bottts/svg?seed=PixelCraft",
    type: "badge",
    title: "Achievement Unlocked: Community Voice 🗣️",
    content: "Unlocked the 'Community Voice' badge by sharing insights in the Art & Tech forum!",
    timestamp: "5 hours ago",
    likes: 9,
    likedBy: [],
    badgeId: "community_voice",
  },
  {
    id: "feed-3",
    authorAddress: "GLOWING5432109876ABCDEFGHIJKLMNOPQRSTUVWXYZCCCC",
    authorName: "GameForge Labs",
    authorAvatar: "https://api.dicebear.com/7.x/bottts/svg?seed=GameForge",
    type: "milestone",
    title: "Milestone Reached: 8-Week Streak! 🔥",
    content: "Maintained active royalty distributions for 8 consecutive weeks! Thanks to all project contributors.",
    timestamp: "1 day ago",
    likes: 24,
    likedBy: [],
  },
];

const DEFAULT_FORUM_POSTS: ForumPost[] = [
  {
    id: "post-1",
    authorAddress: "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA",
    authorName: "Aria Vance",
    authorAvatar: "https://api.dicebear.com/7.x/bottts/svg?seed=Aria",
    category: "music",
    title: "Best practices for automated secondary music royalty splits?",
    content: "We're setting up secondary sale royalty splits for our album drop. What basis points split do you recommend between lead composer, mix engineer, and cover artist?",
    tags: ["music", "secondary-royalties", "splits"],
    timestamp: "3 hours ago",
    upvotes: 14,
    upvotedBy: [],
    comments: [
      {
        id: "c-1",
        authorAddress: "GLOWING5432109876ABCDEFGHIJKLMNOPQRSTUVWXYZCCCC",
        authorName: "GameForge Labs",
        authorAvatar: "https://api.dicebear.com/7.x/bottts/svg?seed=GameForge",
        content: "We usually do 60% lead, 25% mix engineer, 15% visual artist. Works great for our soundtrack pools!",
        timestamp: "2 hours ago",
      },
    ],
  },
  {
    id: "post-2",
    authorAddress: "GSTELLAR9876543210ABCDEFGHIJKLMNOPQRSTUVWXYZBBBB",
    authorName: "PixelCraft Studio",
    authorAvatar: "https://api.dicebear.com/7.x/bottts/svg?seed=PixelCraft",
    category: "art",
    title: "Generative Art Collaborations: Looking for 3D Shader Coders",
    content: "Our studio is launching a 500-piece 3D generative series. We need GLSL shader developers interested in splitting secondary sales on Stellar!",
    tags: ["art", "generative", "collaboration"],
    timestamp: "6 hours ago",
    upvotes: 8,
    upvotedBy: [],
    comments: [],
  },
  {
    id: "post-3",
    authorAddress: "GLOWING5432109876ABCDEFGHIJKLMNOPQRSTUVWXYZCCCC",
    authorName: "GameForge Labs",
    authorAvatar: "https://api.dicebear.com/7.x/bottts/svg?seed=GameForge",
    category: "gaming",
    title: "Integrating Stellar Soroban contracts into Unity game engine",
    content: "Sharing our open-source helper library for triggering automated royalty distributions directly upon in-game item microtransactions.",
    tags: ["gaming", "dev", "soroban", "unity"],
    timestamp: "1 day ago",
    upvotes: 21,
    upvotedBy: [],
    comments: [],
  },
];

const DEFAULT_EVENTS: CommunityEvent[] = [
  {
    id: "event-1",
    title: "Stellar Music & Audio Collaboration Jam",
    description: "Connect with producers, vocalists, and sound designers to build co-owned audio NFTs with automated splits.",
    category: "music",
    date: "2026-10-15T18:00:00Z",
    location: "Discord Voice Lounge #1",
    organizer: "Aria Vance",
    rsvps: ["GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA"],
  },
  {
    id: "event-2",
    title: "Web3 Generative Art & Royalty Design Workshop",
    description: "Learn how to structure multi-tier secondary royalty splits for generative art collections.",
    category: "art",
    date: "2026-10-20T16:00:00Z",
    location: "Twitter/X Spaces",
    organizer: "PixelCraft Studio",
    rsvps: [],
  },
  {
    id: "event-3",
    title: "Indie Game Monetization & Smart Contract Hackathon",
    description: "Build in-game revenue splitter integrations using Stellar Soroban smart contracts.",
    category: "gaming",
    date: "2026-11-01T10:00:00Z",
    location: "Virtual Conference Room",
    organizer: "GameForge Labs",
    rsvps: [],
  },
];

export const useSocialStore = create<SocialState>()(
  devtools(
    persist(
      (set, get) => ({
        profiles: DEFAULT_PROFILES,
        following: ["GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA"],
        feedItems: DEFAULT_FEED,
        forumPosts: DEFAULT_FORUM_POSTS,
        events: DEFAULT_EVENTS,

        getProfile: (address: string) => {
          const state = get();
          if (state.profiles[address]) {
            return state.profiles[address];
          }
          // Default fallback for new addresses
          const short = address.length > 10 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
          return {
            address,
            username: short,
            bio: "Creator on Stellar Royalty Splitter.",
            avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${address}`,
            role: "Collaborator",
            socialLinks: {},
            earnedAmount: 0,
            distributionCount: 0,
            collaboratorCount: 0,
            streakWeeks: 1,
            lastActiveTimestamp: Date.now(),
            badges: [],
            followersCount: 0,
            followingCount: 0,
          };
        },

        upsertProfile: (address: string, data: Partial<UserProfileData>) => {
          set((state) => {
            const current = state.getProfile(address);
            const updated = {
              ...current,
              ...data,
              socialLinks: {
                ...current.socialLinks,
                ...(data.socialLinks || {}),
              },
            };
            return {
              profiles: {
                ...state.profiles,
                [address]: updated,
              },
            };
          });

          // Check if any badges unlocked after profile update
          get().checkAndAwardBadges(address);
        },

        toggleFollow: (targetAddress: string, currentUserAddress?: string) => {
          set((state) => {
            const isCurrentlyFollowing = state.following.includes(targetAddress);
            const nextFollowing = isCurrentlyFollowing
              ? state.following.filter((a) => a !== targetAddress)
              : [...state.following, targetAddress];

            // Update target user's follower count
            const targetProfile = state.getProfile(targetAddress);
            const updatedTarget = {
              ...targetProfile,
              followersCount: Math.max(
                0,
                targetProfile.followersCount + (isCurrentlyFollowing ? -1 : 1)
              ),
            };

            const updatedProfiles = {
              ...state.profiles,
              [targetAddress]: updatedTarget,
            };

            // If currentUserAddress is provided, update current user's following count
            if (currentUserAddress) {
              const currentProfile = state.getProfile(currentUserAddress);
              updatedProfiles[currentUserAddress] = {
                ...currentProfile,
                followingCount: Math.max(
                  0,
                  currentProfile.followingCount + (isCurrentlyFollowing ? -1 : 1)
                ),
              };
            }

            return {
              following: nextFollowing,
              profiles: updatedProfiles,
            };
          });

          if (currentUserAddress) {
            get().checkAndAwardBadges(currentUserAddress);
          }
          get().checkAndAwardBadges(targetAddress);
        },

        isFollowing: (targetAddress: string) => {
          return get().following.includes(targetAddress);
        },

        checkAndAwardBadges: (address: string) => {
          const profile = get().getProfile(address);
          const earnedBadgeIds = new Set(profile.badges.map((b) => b.id));
          const newBadges: Badge[] = [];
          const nowStr = new Date().toISOString().split("T")[0];

          // 1. 1k_earned
          if (profile.earnedAmount >= 1000 && !earnedBadgeIds.has("1k_earned")) {
            newBadges.push({ ...ALL_BADGES["1k_earned"], earnedAt: nowStr });
          }

          // 2. 100_collaborators
          if (profile.collaboratorCount >= 100 && !earnedBadgeIds.has("100_collaborators")) {
            newBadges.push({ ...ALL_BADGES["100_collaborators"], earnedAt: nowStr });
          }

          // 3. weekly_streak
          if (profile.streakWeeks >= 4 && !earnedBadgeIds.has("weekly_streak")) {
            newBadges.push({ ...ALL_BADGES["weekly_streak"], earnedAt: nowStr });
          }

          // 4. first_split
          if (profile.distributionCount >= 1 && !earnedBadgeIds.has("first_split")) {
            newBadges.push({ ...ALL_BADGES["first_split"], earnedAt: nowStr });
          }

          // 5. community_voice
          const userPostCount = get().forumPosts.filter((p) => p.authorAddress === address).length;
          if (userPostCount >= 5 && !earnedBadgeIds.has("community_voice")) {
            newBadges.push({ ...ALL_BADGES["community_voice"], earnedAt: nowStr });
          }

          // 6. star_creator
          if (profile.followersCount >= 10 && !earnedBadgeIds.has("star_creator")) {
            newBadges.push({ ...ALL_BADGES["star_creator"], earnedAt: nowStr });
          }

          if (newBadges.length > 0) {
            const updatedBadges = [...profile.badges, ...newBadges];
            set((state) => ({
              profiles: {
                ...state.profiles,
                [address]: {
                  ...profile,
                  badges: updatedBadges,
                },
              },
            }));

            // Create activity feed items for each new badge
            newBadges.forEach((badge) => {
              get().addFeedItem({
                authorAddress: address,
                authorName: profile.username,
                authorAvatar: profile.avatar,
                type: "badge",
                title: `Achievement Unlocked: ${badge.title} ${badge.icon}`,
                content: `${profile.username} unlocked the '${badge.title}' badge: ${badge.description}!`,
                badgeId: badge.id,
              });
            });
          }

          return newBadges;
        },

        recordUserActivity: (
          address: string,
          activityType: "distribution" | "forum" | "login",
          extraData?: { amount?: number; collaboratorsCount?: number }
        ) => {
          const profile = get().getProfile(address);
          const now = Date.now();
          const oneWeekMs = 7 * 86400000;
          const timeSinceLast = now - (profile.lastActiveTimestamp || 0);

          let streakWeeks = profile.streakWeeks || 1;
          if (timeSinceLast > oneWeekMs && timeSinceLast < 2 * oneWeekMs) {
            streakWeeks += 1;
          } else if (timeSinceLast >= 2 * oneWeekMs) {
            streakWeeks = 1;
          }

          const updatedProfile: Partial<UserProfileData> = {
            lastActiveTimestamp: now,
            streakWeeks,
          };

          if (activityType === "distribution") {
            updatedProfile.distributionCount = profile.distributionCount + 1;
            if (extraData?.amount) {
              updatedProfile.earnedAmount = profile.earnedAmount + extraData.amount;
            }
            if (extraData?.collaboratorsCount) {
              updatedProfile.collaboratorCount = Math.max(
                profile.collaboratorCount,
                extraData.collaboratorsCount
              );
            }
          }

          get().upsertProfile(address, updatedProfile);
        },

        shareAchievementToFeed: (address: string, badgeId: string) => {
          const profile = get().getProfile(address);
          const badge = ALL_BADGES[badgeId] || profile.badges.find((b) => b.id === badgeId);
          if (!badge) return;

          get().addFeedItem({
            authorAddress: address,
            authorName: profile.username,
            authorAvatar: profile.avatar,
            type: "badge",
            title: `Shared Achievement: ${badge.title} ${badge.icon}`,
            content: `${profile.username} proudly shared their achievement: ${badge.description}`,
            badgeId: badge.id,
          });
        },

        addFeedItem: (item) => {
          const newItem: ActivityFeedItem = {
            ...item,
            id: `feed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: "Just now",
            likes: 0,
            likedBy: [],
          };

          set((state) => ({
            feedItems: [newItem, ...state.feedItems],
          }));
        },

        toggleLikeFeedItem: (id: string, userAddress: string) => {
          set((state) => ({
            feedItems: state.feedItems.map((item) => {
              if (item.id !== id) return item;
              const hasLiked = item.likedBy.includes(userAddress);
              const nextLikedBy = hasLiked
                ? item.likedBy.filter((a) => a !== userAddress)
                : [...item.likedBy, userAddress];
              return {
                ...item,
                likes: Math.max(0, item.likes + (hasLiked ? -1 : 1)),
                likedBy: nextLikedBy,
              };
            }),
          }));
        },

        createForumPost: (postData) => {
          const newPost: ForumPost = {
            ...postData,
            id: `post-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: "Just now",
            upvotes: 1,
            upvotedBy: [postData.authorAddress],
            comments: [],
          };

          set((state) => ({
            forumPosts: [newPost, ...state.forumPosts],
          }));

          // Post to feed
          get().addFeedItem({
            authorAddress: postData.authorAddress,
            authorName: postData.authorName,
            authorAvatar: postData.authorAvatar,
            type: "forum",
            title: `New Discussion: ${postData.title}`,
            content: postData.content.slice(0, 140) + (postData.content.length > 140 ? "..." : ""),
          });

          // Record activity for badge progression
          get().recordUserActivity(postData.authorAddress, "forum");

          return newPost;
        },

        toggleUpvoteForumPost: (postId: string, userAddress: string) => {
          set((state) => ({
            forumPosts: state.forumPosts.map((post) => {
              if (post.id !== postId) return post;
              const hasUpvoted = post.upvotedBy.includes(userAddress);
              const nextUpvotedBy = hasUpvoted
                ? post.upvotedBy.filter((a) => a !== userAddress)
                : [...post.upvotedBy, userAddress];
              return {
                ...post,
                upvotes: Math.max(0, post.upvotes + (hasUpvoted ? -1 : 1)),
                upvotedBy: nextUpvotedBy,
              };
            }),
          }));
        },

        addForumComment: (postId, comment) => {
          const newComment: ForumComment = {
            ...comment,
            id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: "Just now",
          };

          set((state) => ({
            forumPosts: state.forumPosts.map((post) => {
              if (post.id !== postId) return post;
              return {
                ...post,
                comments: [...post.comments, newComment],
              };
            }),
          }));
        },

        toggleEventRSVP: (eventId: string, userAddress: string) => {
          set((state) => ({
            events: state.events.map((evt) => {
              if (evt.id !== eventId) return evt;
              const hasRSVP = evt.rsvps.includes(userAddress);
              const nextRSVPs = hasRSVP
                ? evt.rsvps.filter((a) => a !== userAddress)
                : [...evt.rsvps, userAddress];
              return {
                ...evt,
                rsvps: nextRSVPs,
              };
            }),
          }));
        },

        getTopEarners: (limit = 10) => {
          const profiles = Object.values(get().profiles);
          return profiles
            .sort((a, b) => b.earnedAmount - a.earnedAmount)
            .slice(0, limit);
        },

        getMostActive: (limit = 10) => {
          const profiles = Object.values(get().profiles);
          return profiles
            .sort((a, b) => b.distributionCount - a.distributionCount)
            .slice(0, limit);
        },

        getStreakLeaders: (limit = 10) => {
          const profiles = Object.values(get().profiles);
          return profiles
            .sort((a, b) => b.streakWeeks - a.streakWeeks)
            .slice(0, limit);
        },
      }),
      {
        name: "stellar-royalty-splitter-social-v1",
      }
    ),
    { name: "SocialStore" }
  )
);
