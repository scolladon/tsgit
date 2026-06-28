import { afterEach, describe, expect, it } from 'vitest';
import { NodeEnvReader } from '../../../../src/adapters/node/node-env-reader.js';
import { envReaderContractTests } from '../../ports/env-reader.contract.js';

const TEST_VAR = 'TSGIT_NODE_ENV_READER_TEST_VAR';
const TEST_VALUE = 'tsgit-test-value-12345';

describe('NodeEnvReader', () => {
  envReaderContractTests(() => new NodeEnvReader());

  describe('Given a variable set in process.env', () => {
    afterEach(() => {
      delete process.env[TEST_VAR];
    });

    describe('When get is called with that name', () => {
      it('Then returns the set value', () => {
        // Arrange
        const sut = new NodeEnvReader();
        process.env[TEST_VAR] = TEST_VALUE;

        // Act
        const result = sut.get(TEST_VAR);

        // Assert
        expect(result).toBe(TEST_VALUE);
      });
    });
  });

  describe('Given a variable absent from process.env', () => {
    describe('When get is called with that name', () => {
      it('Then returns undefined', () => {
        // Arrange
        const sut = new NodeEnvReader();
        const absentKey = 'TSGIT_NODE_ENV_READER_ABSENT_KEY_XYZ789';

        // Act
        const result = sut.get(absentKey);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
