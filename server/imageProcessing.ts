import sharp from 'sharp';

// Vayria consumes PNG provider output. Block HEIF/AVIF before native parsing:
// sharp 0.35.4 still bundles libheif 1.23.2 (GHSA-xrp2-63fq-jm8q).
sharp.block({ operation: ['VipsForeignLoadHeif'] });

export default sharp;
