"use strict";

const DAILY_REWARD = { Nothing: 0, Common: 2, Rare: 5, Epic: 8, Legendary: 10 };

const TIER_DESCRIPTIONS = {
  Common:    "A Common alien from the Zeruva universe. Assigned to your colony for daily passive income.",
  Rare:      "A Rare alien with heightened abilities. Sends stronger signals from distant planets.",
  Epic:      "An Epic alien. Few exist in the universe — this one brings serious earnings.",
  Legendary: "A Legendary alien. The rarest of the rare. Maximum daily ROI, maximum prestige.",
};

/**
 * Returns the Metaplex-compatible metadata JSON object for an alien NFT.
 * imageBaseUrl should be the publicly accessible backend URL, e.g. https://zeruva.app
 */
function buildAlienMetadata(alienId, tier, imageBaseUrl) {
  const dailyRoi = DAILY_REWARD[tier] ?? 0;
  const imageUrl = `${imageBaseUrl}/static/${alienId}.png`;

  return {
    name: `Zeruva Alien #${alienId}`,
    symbol: "ZRV",
    description: TIER_DESCRIPTIONS[tier] || "A Zeruva alien.",
    image: imageUrl,
    external_url: imageBaseUrl,
    attributes: [
      { trait_type: "Alien ID", value: String(alienId) },
      { trait_type: "Tier",     value: tier },
      { trait_type: "Daily ROI", value: `$${dailyRoi}` },
    ],
    properties: {
      files: [{ uri: imageUrl, type: "image/png" }],
      category: "image",
    },
  };
}

module.exports = { buildAlienMetadata };
