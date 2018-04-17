// in the end, the runner will be implemented like cozy-run-standalone (cozy-run-production ?)
// and it will require index.js
// If the runner gets a class, it will instantiate it and run its known methods : authenticate, fetchData, synchronize
// If the runner gets a BaseKonnector instance, it will do nothing and let the BaseKonnector run
// itself (for compatibility with existing connectors
//
const konnector = require('./konnector')
const runner = require('cozy-konnector-libs/libs/runner')

runner(konnector)
