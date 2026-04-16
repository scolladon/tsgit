import { noopProgressReporter } from '../../../src/ports/progress-reporter.js';
import { progressReporterContractTests } from './progress-reporter.contract.js';

progressReporterContractTests(async () => noopProgressReporter);
