// Compatibility alias: the full journey must include its inbound callbacks.
import {main} from './dev-testing.mjs';
main().catch(error=>{console.error(`dev:testing: ${error.message}`);process.exitCode=1;});
