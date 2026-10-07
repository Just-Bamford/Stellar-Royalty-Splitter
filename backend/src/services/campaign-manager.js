/**
 * Campaign manager - creates and tracks marketing campaigns targeted at
 * user segments, including A/B message testing and engagement analytics.
 *
 * This module is in-memory and deterministic. It does not send email/SMS (that
 * is assumed to be available elsewhere); it only manages campaign definitions,
 * targeting, A/B variant assignment, and conversion/engagement tracking.
 */

import {
  buildSegments,
  flattenSegments,
  resolveTargetRule,
  exportAudienceCsv,
} from "./user-segmentation.js";

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "running", "paused", "completed"];
export const CAMPAIGN_CHANNELS = ["email", "sms", "in-app"];

function generateId(prefix = "camp") {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

function normalizeVariant(variant, index) {
  if (!variant || typeof variant !== "object") {
    throw new Error(`Variant at index ${index} must be an object`);
  }
  const name = variant.name || `${String.fromCharCode(65 + index)}`;
  const weight = variant.weight === undefined ? 1 : Number(variant.weight);
  if (!Number.finite(weight) || weight <= 0) {
    throw new Error(`Variant "${name}" must have a positive weight`);
  }
  return {
    id: variant.id || generateId("var"),
    name,
    weight,
    subject: variant.subject || null,
    body: variant.body || null,
    metadata: variant.metadata || {},
  };
}

export class CampaignManager {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.campaigns = new Map();
    this.events = [];
  }

  /**
   * Create a campaign targeted at a segment or a targeting rule.
   */
  createCampaign(input) {
    if (!input || typeof input !== "object") {
      throw new Error("Campaign input is required");
    }
    const name = input.name;
    if (!name || typeof name !== "string") {
      throw new Error("Campaign name is required");
    }
    const channel = input.channel || "email";
    if (!CAMPAIGN_CHANNELS.includes(channel)) {
      throw new Error(`Unsupported channel: ${channel}`);
    }
    const variants = Array.isArray(input.variants) && input.variants.length
      ? input.variants.map(normalizeVariant)
      : [normalizeVariant({ name: "A", subject: input.subject, body: input.body }, 0)];

    const campaign = {
      id: input.id || generateId("camp"),
      name,
      channel,
      status: CAMPAIGN_STATUSES.includes(input.status) ? input.status : "draft",
      target: null,
      variants,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      stats: {
        sent: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        converted: 0,
        unsubscribed: 0,
        bounced: 0,
      },
      variantStats: {},
    };

    for (const variant of variants) {
      campaign.variantStats[variant.id] = {
        sent: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        converted: 0,
        unsubscribed: 0,
        bounced: 0,
      };
    }

    this.campaigns.set(campaign.id, campaign);
    this._recordEvent("campaign.created", { campaignId: campaign.id });
    return this._clone(campaign);
  }

  /**
   * Attach a target to a campaign. Target can be a segment id or a targeting rule.
   */
  setTarget(campaignId, target, contributors = []) {
    const campaign = this._require(campaignId);
    if (!target) {
      throw new Error("Target is required");
    }

    let resolved;
    if (target.segmentId) {
      const segments = flattenSegments(buildSegments(contributors, { now: this.now() }));
      const segment = segments.find((s) => s.id === target.segmentId);
      if (!segment) throw new Error(`Segment not found: ${target.segmentId}`);
      resolved = {
        type: "segment",
        segmentId: segment.id,
        dimension: segment.dimension,
        label: segment.label,
        size: segment.size,
        wallets: segment.members,
      };
    } else if (target.rule) {
      const matched = resolveTargetRule(target.rule, contributors, { now: this.now() });
      resolved = {
        type: "rule",
        rule: target.rule,
        size: matched.size,
        wallets: matched.wallets,
      };
    } else {
      throw new Error("Target must specify a segmentId or a rule");
    }

    campaign.target = resolved;
    campaign.updatedAt = this.now().toISOString();
    this._recordEvent("campaign.targeted", {
      campaignId,
      targetType: resolved.type,
      size: resolved.size,
    });
    return this._clone(campaign);
  }

  /**
   * Assign a wallet to an A/B variant using deterministic weighted hashing.
   */
  assignVariant(campaignId, wallet) {
    const campaign = this._require(campaignId);
    if (!wallet) throw new Error("Wallet is required");
    const variants = campaign.variants;
    if (!variants.length) throw new Error("Campaign has no variants");
    const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
    const hash = hashString(`${campaignId}:${wallet}`);
    const bucket = (hash % 10000) / 10000 * totalWeight;
    let accumulated = 0;
    for (const variant of variants) {
      accumulated += variant.weight;
      if (bucket < accumulated) return variant;
    }
    return variants[variants.length - 1];
  }

  /**
   * Record a campaign event (sent, opened, converted, etc.) for a wallet.
   */
  recordEvent(campaignId, type, payload = {}) {
    const campaign = this._require(campaignId);
    const allowed = ["sent", "delivered", "opened", "clicked", "converted", "unsubscribed", "bounced"];
    if (!allowed.includes(type)) {
      throw new Error(`Unknown campaign event type: ${type}`);
    }
    const wallet = payload.wallet || null;
    let variant = null;
    if (payload.variantId) {
      variant = campaign.variants.find((v) => v.id === payload.variantId);
    } else if (wallet) {
      variant = this.assignVariant(campaignId, wallet);
    }
    if (!variant) variant = campaign.variants[0];

    campaign.stats[type] = (campaign.stats[type] || 0) + 1;
    if (campaign.variantStats[variant.id]) {
      campaign.variantStats[variant.id][type] =
        (campaign.variantStats[variant.id][type] || 0) + 1;
    }
    campaign.updatedAt = this.now().toISOString();
    this._recordEvent(`campaign.${type}`, {
      campaignId,
      variantId: variant.id,
      wallet,
      ...payload,
    });
    return this._clone(campaign);
  }

  /**
   * Return a campaign by id.
   */
  getCampaign(campaignId) {
    const campaign = this.campaigns.get(campaignId);
    return campaign ? this._clone(campaign) : null;
  }

  /**
   * List campaigns, optionally filtered by status.
   */
  listCampaigns(filter = {}) {
    const all = Array.from(this.campaigns.values());
    const filtered = filter.status ? all.filter((c) => c.status === filter.status) : all;
    return filtered.map((c) => this._clone(c));
  }

  /**
   * Update a campaign status.
   */
  setStatus(campaignId, status) {
    const campaign = this._require(campaignId);
    if (!CAMPAIGN_STATUSES.includes(status)) {
      throw new Error(`Unknown campaign status: ${status}`);
    }
    campaign.status = status;
    campaign.updatedAt = this.now().toISOString();
    this._recordEvent("campaign.status", { campaignId, status });
    return this._clone(campaign);
  }

  /**
   * Compute analytics for a campaign including open/click/conversion rates and
   * per-variant breakdowns.
   */
  getAnalytics(campaignId) {
    const campaign = this._require(campaignId);
    const stats = campaign.stats;
    const delivered = stats.delivered || stats.sent || 0;
    const rate = (num, denom) => (denom > 0 ? num / denom : 0);
    const variantAnalytics = campaign.variants.map((variant) => {
      const vs = campaign.variantStats[variant.id] || {};
      const vDelivered = vs.delivered || vs.sent || 0;
      return {
        variantId: variant.id,
        variantName: variant.name,
        stats: vs,
        openRate: rate(vs.opened || 0, vDelivered),
        clickRate: rate(vs.clicked || 0, vDelivered),
        conversionRate: rate(vs.converted || 0, vDelivered),
      };
    });

    const bestVariant = variantAnalytics.reduce((best, current) => {
      if (!best) return current;
      return current.conversionRate > best.conversionRate ? current : best;
    }, null);

    return {
      campaignId,
      name: campaign.name,
      status: campaign.status,
      targetSize: campaign.target ? campaign.target.size : 0,
      stats: { ...stats },
      openRate: rate(stats.opened || 0, delivered),
      clickRate: rate(stats.clicked || 0, delivered),
      conversionRate: rate(stats.converted || 0, delivered),
      unsubscribeRate: rate(stats.unsubscribed || 0, delivered),
      bounceRate: rate(stats.bounced || 0, delivered),
      variants: variantAnalytics,
      bestVariantId: bestVariant ? bestVariant.variantId : null,
    };
  }

  /**
   * Export the targeted audience for a campaign as CSV.
   */
  exportAudience(campaignId) {
    const campaign = this._require(campaignId);
    if (!campaign.target) throw new Error("Campaign has no target");
    return exportAudienceCsv(campaign.target.wallets);
  }

  /**
   * Return the event log for auditing and debugging.
   */
  getEvents() {
    return this.events.map((e) => ({ ...e }));
  }

  _require(campaignId) {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
    return campaign;
  }

  _recordEvent(type, payload) {
    this.events.push({ type, payload, at: this.now().toISOString() });
  }

  _clone(campaign) {
    return JSON.parse(JSON.stringify(campaign));
  }
}

function hashString(value) {
  let hash = 2166136261;
  const str = String(value);
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash * 16777619);
  }
  return hash >>> 0;
}

export function createCampaignManager(options) {
  return new CampaignManager(options);
}

export default { CampaignManager, createCampaignManager, CAMPAIGN_STATUSES, CAMPAIGN_CHANNELS };
