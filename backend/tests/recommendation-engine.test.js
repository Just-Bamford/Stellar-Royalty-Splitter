import { RecommendationEngine } from "../src/services/recommendation-engine.js";

describe("RecommendationEngine", () => {
  test("calculates high similarity for matching collection metadata", () => {
    const engine = new RecommendationEngine();
    const a = {
      id: "collection-a",
      name: "Neon City",
      genre: "cyberpunk",
      rarity: "legendary",
      floorPrice: 120,
      tags: ["neon", "city", "futuristic"],
      theme: "urban",
      audience: "collectors",
    };

    const b = {
      id: "collection-b",
      name: "Electric District",
      genre: "cyberpunk",
      rarity: "legendary",
      floorPrice: 140,
      tags: ["neon", "district", "futuristic"],
      theme: "urban",
      audience: "collectors",
    };

    expect(engine.calculateCollectionSimilarity(a, b)).toBeGreaterThan(0.7);
  });

  test("recommends similar collections using ranked similarity", () => {
    const engine = new RecommendationEngine();
    const collections = [
      {
        id: "c1",
        name: "Sunset Dreams",
        genre: "abstract",
        rarity: "rare",
        floorPrice: 80,
        tags: ["sunset", "color"],
        theme: "dreamy",
        audience: "modern",
      },
      {
        id: "c2",
        name: "Midnight Noise",
        genre: "electronic",
        rarity: "epic",
        floorPrice: 90,
        tags: ["night", "beats"],
        theme: "urban",
        audience: "club",
      },
      {
        id: "c3",
        name: "Sunset Echo",
        genre: "abstract",
        rarity: "rare",
        floorPrice: 85,
        tags: ["sunset", "echo", "color"],
        theme: "dreamy",
        audience: "modern",
      },
    ];

    const recs = engine.generateCollectionRecommendations(collections[0], collections);
    expect(recs[0].id).toBe("c3");
    expect(recs[0].score).toBeGreaterThan(0.7);
  });

  test("produces collaborative collaborator recommendations from shared work", () => {
    const engine = new RecommendationEngine();
    const collaborators = [
      { id: "alice", name: "Alice", projects: ["p1", "p2"] },
      { id: "bob", name: "Bob", projects: ["p2", "p3"] },
      { id: "charlie", name: "Charlie", projects: ["p4"] },
    ];

    const recommendations = engine.generateCollaboratorRecommendations("alice", collaborators);

    expect(recommendations[0].id).toBe("bob");
    expect(recommendations[0].confidence).toBeGreaterThan(0.5);
  });
});
