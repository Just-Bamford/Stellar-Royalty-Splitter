const defaultCollectionWeights = {
  genre: 0.3,
  tags: 0.2,
  rarity: 0.15,
  theme: 0.1,
  audience: 0.1,
  price: 0.15,
};

function normalizeValue(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeList(value) {
  return toArray(value)
    .map((entry) => normalizeValue(String(entry)))
    .filter(Boolean);
}

function jaccardSimilarity(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter((item) => rightSet.has(item)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  if (union === 0) return 0;
  return intersection / union;
}

function stringSimilarity(left, right) {
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  const normalizedLeft = normalizeValue(left);
  const normalizedRight = normalizeValue(right);
  if (normalizedLeft === normalizedRight) return 1;
  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)
    ? 0.75
    : 0;
}

function numericSimilarity(left, right, scale = 200) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
  const delta = Math.abs(left - right);
  const adjustedScale = Math.max(scale, Math.max(Math.abs(left), Math.abs(right)));
  return Math.max(0, 1 - delta / adjustedScale);
}

function rarityRank(value) {
  const map = {
    common: 1,
    uncommon: 2,
    rare: 3,
    epic: 4,
    legendary: 5,
    mythic: 6,
  };
  const normalized = normalizeValue(value);
  return map[normalized] ?? 0;
}

export class RecommendationEngine {
  constructor(options = {}) {
    this.defaultLimit = options.limit ?? 5;
    this.minimumScore = options.minimumScore ?? 0.15;
  }

  static calculateSimilarity(left, right) {
    return new RecommendationEngine().calculateCollectionSimilarity(left, right);
  }

  static generateCollectionRecommendations(target, collections, limit = 5) {
    return new RecommendationEngine({ limit }).generateCollectionRecommendations(target, collections, limit);
  }

  static generateCollaboratorRecommendations(targetId, collaborators, limit = 5) {
    return new RecommendationEngine({ limit }).generateCollaboratorRecommendations(targetId, collaborators, limit);
  }

  normalizeCollection(collection = {}) {
    return {
      id: collection.id ?? collection.name ?? 'unknown',
      name: collection.name ?? collection.id ?? 'Unknown',
      genre: normalizeValue(collection.genre),
      rarity: normalizeValue(collection.rarity),
      theme: normalizeValue(collection.theme),
      audience: normalizeValue(collection.audience),
      floorPrice: Number(collection.floorPrice ?? collection.floor_price ?? 0),
      tags: normalizeList(collection.tags ?? collection.keywords ?? collection.categories),
    };
  }

  calculateCollectionSimilarity(left, right) {
    if (!left || !right) return 0;

    const a = this.normalizeCollection(left);
    const b = this.normalizeCollection(right);

    const genreScore = stringSimilarity(a.genre, b.genre);
    const themeScore = stringSimilarity(a.theme, b.theme);
    const audienceScore = stringSimilarity(a.audience, b.audience);
    const rarityScore = Math.max(
      0,
      1 - Math.abs(rarityRank(a.rarity) - rarityRank(b.rarity)) / 6,
    );
    const tagScore = jaccardSimilarity(a.tags, b.tags);
    const priceScore = numericSimilarity(a.floorPrice, b.floorPrice, 250);

    const totalWeight = Object.values(defaultCollectionWeights).reduce((sum, value) => sum + value, 0);
    const weightedScore =
      (genreScore * defaultCollectionWeights.genre) +
      (tagScore * defaultCollectionWeights.tags) +
      (rarityScore * defaultCollectionWeights.rarity) +
      (themeScore * defaultCollectionWeights.theme) +
      (audienceScore * defaultCollectionWeights.audience) +
      (priceScore * defaultCollectionWeights.price);

    const score = totalWeight > 0 ? weightedScore / totalWeight : 0;
    return Number(Math.min(1, Math.max(0, score)).toFixed(4));
  }

  generateCollectionRecommendations(target, collections = [], limit = this.defaultLimit) {
    if (!target || !Array.isArray(collections) || collections.length === 0) return [];

    const targetCollection = this.normalizeCollection(target);
    const scored = collections
      .filter((item) => item && item.id !== targetCollection.id)
      .map((item) => {
        const score = this.calculateCollectionSimilarity(targetCollection, item);
        const reasonParts = [];

        if (score >= 0.5) {
          const genreMatch = normalizeValue(item.genre) && normalizeValue(item.genre) === targetCollection.genre;
          if (genreMatch) reasonParts.push(`shared ${targetCollection.genre || 'genre'} aesthetic`);
          if (item.theme && targetCollection.theme && normalizeValue(item.theme) === targetCollection.theme) {
            reasonParts.push(`matching ${targetCollection.theme} theme`);
          }
          const overlap = jaccardSimilarity(targetCollection.tags, this.normalizeCollection(item).tags);
          if (overlap > 0) {
            reasonParts.push(`${Math.round(overlap * 100)}% overlapping tags`);
          }
        }

        return {
          id: item.id ?? item.name ?? 'collection',
          name: item.name ?? item.id ?? 'Collection',
          score,
          confidence: Number(Math.min(1, score + 0.1).toFixed(4)),
          reason: reasonParts.join(' • ') || 'Strong thematic and audience alignment',
          type: 'collection',
        };
      })
      .filter((item) => item.score >= this.minimumScore)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

    return scored.slice(0, Math.max(1, limit)).map((item) => ({ ...item, score: Number(item.score.toFixed(4)) }));
  }

  extractCollaboratorProjects(collaborator = {}) {
    const candidates = [
      collaborator.projects,
      collaborator.projectIds,
      collaborator.work,
      collaborator.portfolio,
    ];

    return candidates
      .flatMap((entry) => toArray(entry))
      .map((entry) => normalizeValue(String(entry)))
      .filter(Boolean);
  }

  generateCollaboratorRecommendations(targetId, collaborators = [], limit = this.defaultLimit) {
    if (!Array.isArray(collaborators) || collaborators.length === 0) return [];

    const target = collaborators.find(
      (collaborator) =>
        collaborator &&
        (collaborator.id === targetId ||
          collaborator.address === targetId ||
          normalizeValue(collaborator.name) === normalizeValue(String(targetId))),
    ) ?? { id: targetId, projects: [] };

    const targetProjects = new Set(this.extractCollaboratorProjects(target));

    const scored = collaborators
      .filter((collaborator) => collaborator && (collaborator.id !== target.id && collaborator.address !== target.id))
      .map((collaborator) => {
        const collaboratorProjects = this.extractCollaboratorProjects(collaborator);
        const sharedProjects = collaboratorProjects.filter((project) => targetProjects.has(project));
        const sharedCount = sharedProjects.length;
        const projectOverlap = targetProjects.size + collaboratorProjects.length > 0
          ? sharedCount / Math.max(1, Math.max(targetProjects.size, collaboratorProjects.length))
          : 0;

        const score = Math.min(
          1,
          projectOverlap * 0.8 +
            (sharedCount > 0 ? 0.2 : 0) +
            (collaborator.reliability ?? 0) * 0.2,
        );

        return {
          id: collaborator.id ?? collaborator.address ?? collaborator.name ?? 'collaborator',
          name: collaborator.name ?? collaborator.id ?? collaborator.address ?? 'Collaborator',
          score: Number(score.toFixed(4)),
          confidence: Number(Math.min(1, score + 0.15).toFixed(4)),
          reason:
            sharedCount > 0
              ? `Collaborators who worked with you also worked with ${collaborator.name ?? 'this collaborator'}`
              : 'Strong fit based on project history and creative alignment',
          type: 'collaborator',
          sharedProjects: sharedCount,
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

    return scored.slice(0, Math.max(1, limit));
  }

  generateRecommendations({
    collection,
    collections = [],
    collaborator,
    collaborators = [],
    limit = this.defaultLimit,
  } = {}) {
    const collectionRecommendations = collection
      ? this.generateCollectionRecommendations(collection, collections, limit)
      : [];
    const collaboratorRecommendations = collaborator
      ? this.generateCollaboratorRecommendations(collaborator, collaborators, limit)
      : [];

    return {
      generatedAt: new Date().toISOString(),
      collectionRecommendations,
      collaboratorRecommendations,
      summary: {
        totalCollectionRecommendations: collectionRecommendations.length,
        totalCollaboratorRecommendations: collaboratorRecommendations.length,
      },
    };
  }
}

export const recommendationEngine = new RecommendationEngine();
export function calculateSimilarityScore(left, right) {
  return recommendationEngine.calculateCollectionSimilarity(left, right);
}

export default RecommendationEngine;
