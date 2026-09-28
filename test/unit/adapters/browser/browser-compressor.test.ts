import { describe } from 'vitest';
import { BrowserCompressor } from '../../../../src/adapters/browser/browser-compressor.js';
import { compressorContractTests } from '../../ports/compressor.contract.js';

describe('BrowserCompressor', () => {
  compressorContractTests(async () => new BrowserCompressor());
});
